import { provisionJotformAccount } from '../onboarding/jotform-onboarding';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AccountDeletionRequestStatus,
  JotformSyncSource,
  JotformSyncStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JotformApiClient, JotformApiError } from './jotform-api.client';
import { JOTFORM_CONFIG, JotformConfig } from './jotform.config';
import { calculateJotformRetryDelayMs } from './jotform-retry';
import { acquireJotformPrivacyLock } from './jotform-privacy';
import {
  CanonicalJotformSubmission,
  JotformCanonicalSubmissionError,
  mapCanonicalJotformSubmission,
} from './jotform-submission.mapper';
import {
  isVendorTimestampAtLeast,
  laterVendorTimestamp,
} from './jotform-vendor-time';

export const JOTFORM_API_CLIENT = Symbol('JOTFORM_API_CLIENT');

type ClaimedSubmission = {
  id: string;
  submissionId: string;
  attemptCount: number;
  processingGeneration: number;
  leaseToken: string;
};

type SafeFailure = {
  code: string;
  retryable: boolean;
  rejected: boolean;
  httpStatus: number | null;
  retryAfterMs: number | null;
  limitLeft: number | null;
};

export type JotformProcessingSummary = {
  claimed: number;
  processed: number;
  retryScheduled: number;
  deadLettered: number;
  rejected: number;
};

export class JotformApiCallDeferredError extends Error {
  constructor(
    public readonly code: 'API_CALL_PAUSED' | 'API_CALL_BUSY',
    public readonly reason: string,
  ) {
    super('Jotform API call deferred');
    this.name = 'JotformApiCallDeferredError';
  }
}

@Injectable()
export class JotformSyncService {
  private readonly logger = new Logger(JotformSyncService.name);
  private backgroundProcessingEnabled = true;
  private kickRequested = false;
  private kickPromise: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(JOTFORM_CONFIG) private readonly config: Readonly<JotformConfig>,
    @Inject(JOTFORM_API_CLIENT)
    private readonly apiClient: JotformApiClient | null,
  ) {}

  async acceptWebhook(envelope: {
    formId: string;
    submissionId: string;
    fingerprint: string;
  }) {
    if (!this.config.enabled || envelope.formId !== this.config.formId) {
      throw new Error('JOTFORM_WEBHOOK_NOT_ACCEPTED');
    }

    const receivedAt = new Date();
    const record = await this.prisma.$transaction(async (tx) => {
      const queued = await tx.jotformSubmission.upsert({
        where: {
          formId_submissionId: {
            formId: envelope.formId,
            submissionId: envelope.submissionId,
          },
        },
        create: {
          formId: envelope.formId,
          submissionId: envelope.submissionId,
          lastEnqueuedBy: JotformSyncSource.WEBHOOK,
          syncStatus: JotformSyncStatus.PENDING,
          firstWebhookReceivedAt: receivedAt,
          lastWebhookReceivedAt: receivedAt,
          webhookDeliveryCount: 1,
          envelopeFingerprint: envelope.fingerprint,
          nextAttemptAt: receivedAt,
        },
        update: {
          lastEnqueuedBy: JotformSyncSource.WEBHOOK,
          generation: { increment: 1 },
          lastWebhookReceivedAt: receivedAt,
          webhookDeliveryCount: { increment: 1 },
          envelopeFingerprint: envelope.fingerprint,
          nextAttemptAt: receivedAt,
        },
        select: {
          id: true,
          syncStatus: true,
          webhookDeliveryCount: true,
        },
      });

      if (queued.syncStatus !== JotformSyncStatus.PROCESSING) {
        await tx.jotformSubmission.update({
          where: { id: queued.id },
          data: {
            syncStatus: JotformSyncStatus.PENDING,
            leaseToken: null,
            leaseExpiresAt: null,
            processingGeneration: null,
            attemptCount: 0,
            deadLetteredAt: null,
            nextAttemptAt: receivedAt,
            lastErrorCode: null,
            lastErrorHttpStatus: null,
            lastErrorRetryable: null,
            lastErrorAt: null,
          },
        });
      }

      return queued;
    });

    this.kick();
    return {
      accepted: true as const,
      duplicate: record.webhookDeliveryCount > 1,
    };
  }

  /**
   * Best-effort low-latency processing. The durable row is already committed,
   * so a process restart is repaired by the maintenance command.
   */
  kick() {
    if (
      !this.backgroundProcessingEnabled ||
      !this.config.enabled ||
      !this.apiClient
    ) {
      return;
    }
    this.kickRequested = true;
    if (this.kickPromise) {
      return;
    }

    this.kickPromise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        while (this.kickRequested) {
          this.kickRequested = false;
          const batch = await this.processDue();
          if (batch.claimed === this.config.processingBatchSize) {
            this.kickRequested = true;
          }
        }
      })
      .catch(() => {
        this.logger.error('Jotform background processing failed');
      })
      .finally(() => {
        this.kickPromise = null;
        if (this.kickRequested) {
          this.kick();
        }
      });
  }

  /** CLI jobs run explicit drains and must not leave setImmediate work behind. */
  disableBackgroundProcessing() {
    this.backgroundProcessingEnabled = false;
    this.kickRequested = false;
  }

  async processDue(
    maximum = this.config.processingBatchSize,
  ): Promise<JotformProcessingSummary> {
    const summary: JotformProcessingSummary = {
      claimed: 0,
      processed: 0,
      retryScheduled: 0,
      deadLettered: 0,
      rejected: 0,
    };
    if (!this.config.enabled || !this.apiClient) {
      return summary;
    }
    const limit = Math.min(
      this.config.processingBatchSize,
      Math.max(0, Math.floor(maximum)),
    );

    for (let index = 0; index < limit; index += 1) {
      if (await this.isApiCallPaused()) {
        break;
      }
      const claimed = await this.claimNext();
      if (!claimed) {
        break;
      }
      summary.claimed += 1;

      const outcome = await this.processClaimed(claimed);
      summary[outcome.status] += 1;
      if (outcome.haltBatch) {
        break;
      }
    }
    return summary;
  }

  async recordReconciledSubmission(input: unknown) {
    if (!this.config.enabled) {
      return { recorded: false as const };
    }
    const canonical = this.mapAndVerify(input);
    const now = new Date();
    const queued = await this.prisma.jotformSubmission.upsert({
      where: {
        formId_submissionId: {
          formId: canonical.formId,
          submissionId: canonical.submissionId,
        },
      },
      create: {
        formId: canonical.formId,
        submissionId: canonical.submissionId,
        lastEnqueuedBy: JotformSyncSource.RECONCILIATION,
        syncStatus: JotformSyncStatus.PENDING,
        nextAttemptAt: now,
      },
      update: {},
      select: { id: true, generation: true },
    });

    await this.applyCanonical(queued.id, canonical, {
      leaseToken: null,
      processingGeneration: null,
      reconciliationGeneration: queued.generation,
      reconciled: true,
    });

    return {
      recorded: true as const,
      vendorUpdatedAt: canonical.vendorUpdatedAt,
    };
  }

  async recordRejectedReconciliationSubmission(input: unknown, code: string) {
    const identity = readCanonicalIdentity(input);
    if (!identity || identity.formId !== this.config.formId) {
      return { recorded: false as const };
    }
    const safeCode = /^[A-Z][A-Z0-9_]{2,80}$/.test(code)
      ? code
      : 'INVALID_CANONICAL_SUBMISSION';
    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const ensured = await tx.jotformSubmission.upsert({
        where: {
          formId_submissionId: {
            formId: identity.formId,
            submissionId: identity.submissionId,
          },
        },
        create: {
          formId: identity.formId,
          submissionId: identity.submissionId,
          lastEnqueuedBy: JotformSyncSource.RECONCILIATION,
          syncStatus: JotformSyncStatus.PENDING,
          nextAttemptAt: now,
          vendorUpdatedAt: identity.updatedAt,
          reviewReasonCode: safeCode,
          lastErrorCode: safeCode,
          lastErrorRetryable: false,
          lastErrorAt: now,
        },
        update: {},
        select: { id: true },
      });
      await lockJotformSubmission(tx, ensured.id);
      const current = await tx.jotformSubmission.findUniqueOrThrow({
        where: { id: ensured.id },
      });

      const staleObservation = Boolean(
        current.vendorUpdatedAt !== null &&
        identity.updatedAt !== null &&
        identity.updatedAt < current.vendorUpdatedAt,
      );
      const stableRejectedObservation = Boolean(
        current.syncStatus === JotformSyncStatus.REJECTED &&
        (identity.updatedAt === null ||
          current.vendorUpdatedAt === identity.updatedAt),
      );
      if (staleObservation || stableRejectedObservation) {
        await tx.jotformSubmission.update({
          where: { id: current.id },
          data: {
            lastErrorCode: safeCode,
            lastErrorRetryable: false,
            lastErrorAt: now,
          },
        });
        return 'preserved' as const;
      }

      const destructiveNewerObservation = Boolean(
        identity.updatedAt &&
        (!current.vendorUpdatedAt ||
          identity.updatedAt > current.vendorUpdatedAt),
      );
      if (current.syncStatus === JotformSyncStatus.PROCESSING) {
        if (!destructiveNewerObservation) {
          await tx.jotformSubmission.update({
            where: { id: current.id },
            data: {
              lastErrorCode: safeCode,
              lastErrorRetryable: false,
              lastErrorAt: now,
            },
          });
          return 'preserved' as const;
        }
        await tx.jotformSubmission.update({
          where: { id: current.id },
          data: {
            lastEnqueuedBy: JotformSyncSource.RECONCILIATION,
            generation: { increment: 1 },
            nextAttemptAt: now,
            lastErrorCode: safeCode,
            lastErrorHttpStatus: null,
            lastErrorRetryable: false,
            lastErrorAt: now,
          },
        });
        return 'processing-invalidated' as const;
      }

      await tx.jotformSubmission.update({
        where: { id: current.id },
        data: {
          lastEnqueuedBy: JotformSyncSource.RECONCILIATION,
          syncStatus: JotformSyncStatus.PENDING,
          generation: { increment: 1 },
          attemptCount: 0,
          nextAttemptAt: now,
          processingGeneration: null,
          leaseToken: null,
          leaseExpiresAt: null,
          ...(destructiveNewerObservation
            ? {
                vendorUpdatedAt: identity.updatedAt,
                contentHash: null,
                respondentEmail: null,
                companyName: null,
                dealerNumber: null,
                reviewReasonCode: current.privacyErasedAt
                  ? 'ACCOUNT_PRIVACY_ERASED'
                  : safeCode,
              }
            : {}),
          deadLetteredAt: null,
          lastErrorCode: safeCode,
          lastErrorHttpStatus: null,
          lastErrorRetryable: false,
          lastErrorAt: now,
        },
      });
      return 'point-fetch' as const;
    });
    if (outcome === 'point-fetch') {
      this.kick();
    }
    return { recorded: true as const, outcome };
  }

  async replay(submissionId: string) {
    if (!/^\d{1,64}$/.test(submissionId)) {
      throw new Error('INVALID_JOTFORM_SUBMISSION_ID');
    }
    const now = new Date();
    const result = await this.prisma.jotformSubmission.updateMany({
      where: {
        formId: this.config.formId,
        submissionId,
        syncStatus: {
          in: [JotformSyncStatus.DEAD_LETTER, JotformSyncStatus.REJECTED],
        },
      },
      data: {
        lastEnqueuedBy: JotformSyncSource.MANUAL_REPLAY,
        syncStatus: JotformSyncStatus.PENDING,
        generation: { increment: 1 },
        attemptCount: 0,
        nextAttemptAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        processingGeneration: null,
        deadLetteredAt: null,
        lastErrorCode: null,
        lastErrorHttpStatus: null,
        lastErrorRetryable: null,
        lastErrorAt: null,
      },
    });
    if (result.count > 0 && this.backgroundProcessingEnabled) {
      this.kick();
    }
    return { requeued: result.count };
  }

  async getOperationalStatus() {
    const [counts, state, oldestPending, terminalRecords] = await Promise.all([
      this.prisma.jotformSubmission.groupBy({
        by: ['syncStatus'],
        where: { formId: this.config.formId },
        _count: { _all: true },
      }),
      this.prisma.jotformSyncState.findUnique({
        where: { formId: this.config.formId },
        select: {
          watermark: true,
          reconciliationFrom: true,
          reconciliationOffset: true,
          reconciliationHighWatermark: true,
          reconciliationAfterId: true,
          lastAttemptAt: true,
          lastSuccessfulAt: true,
          consecutiveFailures: true,
          leaseExpiresAt: true,
          lastErrorCode: true,
          apiLimitRemaining: true,
          apiLimitResetAt: true,
          apiCircuitOpenUntil: true,
          apiCircuitReason: true,
          apiLeaseExpiresAt: true,
        },
      }),
      this.prisma.jotformSubmission.findFirst({
        where: {
          formId: this.config.formId,
          syncStatus: {
            in: [JotformSyncStatus.PENDING, JotformSyncStatus.RETRY_WAIT],
          },
        },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.jotformSubmission.findMany({
        where: {
          formId: this.config.formId,
          syncStatus: {
            in: [JotformSyncStatus.DEAD_LETTER, JotformSyncStatus.REJECTED],
          },
        },
        orderBy: [{ lastErrorAt: 'desc' }, { createdAt: 'desc' }],
        take: 25,
        select: {
          submissionId: true,
          syncStatus: true,
          attemptCount: true,
          lastErrorCode: true,
          lastErrorAt: true,
          deadLetteredAt: true,
        },
      }),
    ]);
    return {
      enabled: this.config.enabled,
      formId: this.config.formId,
      counts: Object.fromEntries(
        counts.map((item) => [item.syncStatus, item._count._all]),
      ),
      oldestPendingAt: oldestPending?.createdAt ?? null,
      terminalRecords,
      reconciliation: state,
    };
  }

  /**
   * Serializes Jotform API calls across application instances. This prevents
   * late responses from reopening a quota/circuit state recorded by a newer
   * request and gives both queue processing and reconciliation one quota view.
   */
  async executeApiCall<T extends { limitLeft: number | null }>(
    operation: () => Promise<T>,
  ): Promise<{ response: T; quotaReached: boolean }> {
    const pauseReason = await this.readApiPauseReason();
    if (pauseReason) {
      throw new JotformApiCallDeferredError('API_CALL_PAUSED', pauseReason);
    }
    const leaseToken = await this.acquireApiCallLease();
    if (!leaseToken) {
      throw new JotformApiCallDeferredError(
        'API_CALL_BUSY',
        'API_CALL_LEASE_BUSY',
      );
    }

    try {
      const response = await operation();
      const quotaReached = await this.recordApiSuccess(response.limitLeft);
      return { response, quotaReached };
    } catch (error: unknown) {
      await this.recordApiFailureCircuit(normalizeFailure(error));
      throw error;
    } finally {
      await this.releaseApiCallLease(leaseToken);
    }
  }

  private async isApiCallPaused() {
    return (await this.readApiPauseReason()) !== null;
  }

  private async readApiPauseReason() {
    const now = new Date();
    const state = await this.prisma.jotformSyncState.findUnique({
      where: { formId: this.config.formId },
      select: {
        apiLimitRemaining: true,
        apiLimitResetAt: true,
        apiCircuitOpenUntil: true,
        apiCircuitReason: true,
      },
    });
    if (!state) {
      return null;
    }
    if (state.apiCircuitOpenUntil && state.apiCircuitOpenUntil > now) {
      return state.apiCircuitReason ?? 'API_CIRCUIT_OPEN';
    }
    if (
      state.apiLimitRemaining !== null &&
      state.apiLimitRemaining <= this.config.apiRateLimitReserve &&
      state.apiLimitResetAt &&
      state.apiLimitResetAt > now
    ) {
      return 'API_RATE_LIMIT_RESERVE';
    }
    return null;
  }

  private async acquireApiCallLease() {
    const now = new Date();
    const leaseToken = randomUUID();
    const minimumLeaseMs = this.config.requestTimeoutMs + 5_000;
    const leaseExpiresAt = new Date(
      now.getTime() +
        Math.max(this.config.processingLeaseSeconds * 1_000, minimumLeaseMs),
    );
    await this.prisma.jotformSyncState.upsert({
      where: { formId: this.config.formId },
      create: { formId: this.config.formId },
      update: {},
    });
    const claimed = await this.prisma.jotformSyncState.updateMany({
      where: {
        formId: this.config.formId,
        AND: [
          {
            OR: [
              { apiLeaseToken: null },
              { apiLeaseExpiresAt: null },
              { apiLeaseExpiresAt: { lte: now } },
            ],
          },
          {
            OR: [
              { apiCircuitOpenUntil: null },
              { apiCircuitOpenUntil: { lte: now } },
            ],
          },
          {
            OR: [
              { apiLimitRemaining: null },
              {
                apiLimitRemaining: {
                  gt: this.config.apiRateLimitReserve,
                },
              },
              { apiLimitResetAt: null },
              { apiLimitResetAt: { lte: now } },
            ],
          },
        ],
      },
      data: { apiLeaseToken: leaseToken, apiLeaseExpiresAt: leaseExpiresAt },
    });
    return claimed.count === 1 ? leaseToken : null;
  }

  private async releaseApiCallLease(leaseToken: string) {
    await this.prisma.jotformSyncState.updateMany({
      where: { formId: this.config.formId, apiLeaseToken: leaseToken },
      data: { apiLeaseToken: null, apiLeaseExpiresAt: null },
    });
  }

  private async recordApiSuccess(limitLeft: number | null) {
    const now = new Date();
    const state = await this.prisma.jotformSyncState.findUniqueOrThrow({
      where: { formId: this.config.formId },
      select: {
        apiLimitRemaining: true,
        apiLimitResetAt: true,
        apiCircuitOpenUntil: true,
      },
    });
    const sameQuotaWindow = Boolean(
      state.apiLimitResetAt && state.apiLimitResetAt > now,
    );
    const observedLimit =
      limitLeft === null
        ? sameQuotaWindow
          ? state.apiLimitRemaining
          : null
        : sameQuotaWindow && state.apiLimitRemaining !== null
          ? Math.min(state.apiLimitRemaining, limitLeft)
          : limitLeft;
    const quotaReached = Boolean(
      observedLimit !== null &&
      observedLimit <= this.config.apiRateLimitReserve,
    );
    const quotaResetAt =
      limitLeft === null
        ? sameQuotaWindow
          ? state.apiLimitResetAt
          : null
        : sameQuotaWindow
          ? state.apiLimitResetAt
          : nextJotformQuotaReset(now);
    const circuitStillOpen = Boolean(
      state.apiCircuitOpenUntil && state.apiCircuitOpenUntil > now,
    );
    await this.prisma.jotformSyncState.update({
      where: { formId: this.config.formId },
      data: {
        apiLimitRemaining: observedLimit,
        apiLimitResetAt: quotaResetAt,
        ...(circuitStillOpen
          ? {}
          : { apiCircuitOpenUntil: null, apiCircuitReason: null }),
      },
    });
    return quotaReached;
  }

  private async recordApiFailureCircuit(failure: SafeFailure) {
    if (!isGlobalApiFailure(failure)) {
      return false;
    }

    const now = new Date();
    const retryAfterMs = Math.max(0, failure.retryAfterMs ?? 0);
    const defaultPauseMs =
      failure.code === 'RATE_LIMITED'
        ? nextJotformQuotaReset(now).getTime() - now.getTime()
        : failure.code === 'AUTHENTICATION_ERROR'
          ? 15 * 60_000
          : Math.max(this.config.retryBaseDelayMs, 30_000);
    const openUntil = new Date(
      now.getTime() +
        Math.min(24 * 60 * 60_000, Math.max(defaultPauseMs, retryAfterMs)),
    );
    const current = await this.prisma.jotformSyncState.findUnique({
      where: { formId: this.config.formId },
      select: { apiCircuitOpenUntil: true, apiLimitRemaining: true },
    });
    const effectiveOpenUntil =
      current?.apiCircuitOpenUntil && current.apiCircuitOpenUntil > openUntil
        ? current.apiCircuitOpenUntil
        : openUntil;
    const effectiveLimit =
      failure.limitLeft === null
        ? (current?.apiLimitRemaining ?? null)
        : current?.apiLimitRemaining === null ||
            current?.apiLimitRemaining === undefined
          ? failure.limitLeft
          : Math.min(current.apiLimitRemaining, failure.limitLeft);
    await this.prisma.jotformSyncState.upsert({
      where: { formId: this.config.formId },
      create: {
        formId: this.config.formId,
        apiLimitRemaining: effectiveLimit,
        apiLimitResetAt:
          failure.code === 'RATE_LIMITED' ? effectiveOpenUntil : undefined,
        apiCircuitOpenUntil: effectiveOpenUntil,
        apiCircuitReason: failure.code,
      },
      update: {
        ...(effectiveLimit !== null
          ? { apiLimitRemaining: effectiveLimit }
          : {}),
        ...(failure.code === 'RATE_LIMITED'
          ? { apiLimitResetAt: effectiveOpenUntil }
          : {}),
        apiCircuitOpenUntil: effectiveOpenUntil,
        apiCircuitReason: failure.code,
      },
    });
    return true;
  }

  private async claimNext(): Promise<ClaimedSubmission | null> {
    const now = new Date();
    const eligible: Prisma.JotformSubmissionWhereInput = {
      formId: this.config.formId,
      OR: [
        {
          syncStatus: {
            in: [JotformSyncStatus.PENDING, JotformSyncStatus.RETRY_WAIT],
          },
          nextAttemptAt: { lte: now },
        },
        {
          syncStatus: JotformSyncStatus.PROCESSING,
          leaseExpiresAt: { lt: now },
        },
      ],
    };
    const candidate = await this.prisma.jotformSubmission.findFirst({
      where: eligible,
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, generation: true },
    });
    if (!candidate) {
      return null;
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + this.workLeaseDurationMs());
    const claimed = await this.prisma.jotformSubmission.updateMany({
      where: { id: candidate.id, ...eligible },
      data: {
        syncStatus: JotformSyncStatus.PROCESSING,
        processingGeneration: candidate.generation,
        attemptCount: { increment: 1 },
        lastAttemptAt: now,
        leaseToken,
        leaseExpiresAt,
      },
    });
    if (claimed.count !== 1) {
      return null;
    }

    const record = await this.prisma.jotformSubmission.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        submissionId: true,
        attemptCount: true,
        processingGeneration: true,
        leaseToken: true,
      },
    });
    if (
      !record ||
      record.processingGeneration === null ||
      record.leaseToken === null
    ) {
      return null;
    }
    return record as ClaimedSubmission;
  }

  private workLeaseDurationMs() {
    return Math.max(
      this.config.processingLeaseSeconds * 1_000,
      this.config.requestTimeoutMs + 5_000,
    );
  }

  private async processClaimed(claimed: ClaimedSubmission): Promise<{
    status: keyof Omit<JotformProcessingSummary, 'claimed'>;
    haltBatch: boolean;
  }> {
    try {
      const { response, quotaReached } = await this.executeApiCall(() =>
        this.apiClient!.getSubmission(claimed.submissionId),
      );
      const canonical = this.mapAndVerify(
        response.content,
        claimed.submissionId,
      );
      await this.applyCanonical(claimed.id, canonical, {
        leaseToken: claimed.leaseToken,
        processingGeneration: claimed.processingGeneration,
        reconciled: false,
      });
      return { status: 'processed', haltBatch: quotaReached };
    } catch (error: unknown) {
      if (error instanceof JotformApiCallDeferredError) {
        await this.releaseClaimForApiDeferral(claimed, error.code);
        return { status: 'retryScheduled', haltBatch: true };
      }
      const failure = normalizeFailure(error);
      return {
        status: await this.recordFailure(claimed, failure),
        haltBatch: isGlobalApiFailure(failure),
      };
    }
  }

  private async releaseClaimForApiDeferral(
    claimed: ClaimedSubmission,
    code: JotformApiCallDeferredError['code'],
  ) {
    const now = new Date();
    await this.prisma.jotformSubmission.updateMany({
      where: { id: claimed.id, leaseToken: claimed.leaseToken },
      data: {
        syncStatus: JotformSyncStatus.RETRY_WAIT,
        attemptCount: Math.max(0, claimed.attemptCount - 1),
        nextAttemptAt: new Date(now.getTime() + 5_000),
        leaseToken: null,
        leaseExpiresAt: null,
        processingGeneration: null,
        lastErrorCode: code,
        lastErrorHttpStatus: null,
        lastErrorRetryable: true,
        lastErrorAt: now,
      },
    });
  }

  private mapAndVerify(input: unknown, expectedSubmissionId?: string) {
    const canonical = mapCanonicalJotformSubmission(input, {
      emailQuestionId: this.config.questionIds.email,
      companyQuestionId: this.config.questionIds.company,
      nameQuestionId: this.config.questionIds.name,
      ...(this.config.questionIds.dealerNumber
        ? { dealerNumberQuestionId: this.config.questionIds.dealerNumber }
        : {}),
    });
    if (
      canonical.formId !== this.config.formId ||
      (expectedSubmissionId && canonical.submissionId !== expectedSubmissionId)
    ) {
      throw new JotformCanonicalSubmissionError('CANONICAL_ID_MISMATCH');
    }
    return canonical;
  }

  private async applyCanonical(
    recordId: string,
    canonical: CanonicalJotformSubmission,
    context: {
      leaseToken: string | null;
      processingGeneration: number | null;
      reconciliationGeneration?: number;
      reconciled: boolean;
    },
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (canonical.respondentEmail) {
        await acquireJotformPrivacyLock(tx, canonical.respondentEmail);
      }
      await lockJotformSubmission(tx, recordId);
      const current = await tx.jotformSubmission.findUnique({
        where: { id: recordId },
      });
      if (!current) {
        throw new Error('JOTFORM_QUEUE_RECORD_MISSING');
      }
      if (
        context.leaseToken &&
        (current.syncStatus !== JotformSyncStatus.PROCESSING ||
          current.leaseToken !== context.leaseToken)
      ) {
        return;
      }

      const isAtLeastCurrent = isVendorTimestampAtLeast(
        canonical.vendorUpdatedAt,
        current.vendorUpdatedAt,
      );
      const reconciliationConflict = Boolean(
        context.reconciled &&
        current.vendorUpdatedAt === canonical.vendorUpdatedAt &&
        current.contentHash &&
        current.contentHash !== canonical.contentHash,
      );
      const shouldApply = isAtLeastCurrent && !reconciliationConflict;
      const privacyErased = current.privacyErasedAt !== null;
      let ownershipReview = false;
      if (!privacyErased && !current.ownerUserId && canonical.respondentEmail) {
        const completedDeletion = await tx.accountDeletionRequest.findFirst({
          where: {
            email: canonical.respondentEmail,
            status: AccountDeletionRequestStatus.COMPLETED,
          },
          select: { id: true },
        });
        ownershipReview = completedDeletion !== null;
      }
      const newerWorkArrived =
        (context.processingGeneration !== null &&
          current.generation > context.processingGeneration) ||
        (context.reconciled &&
          context.reconciliationGeneration !== undefined &&
          current.generation > context.reconciliationGeneration);
      const preserveProcessing =
        context.reconciled &&
        current.syncStatus === JotformSyncStatus.PROCESSING;
      const preserveQueuedWork =
        context.reconciled &&
        (current.syncStatus === JotformSyncStatus.PENDING ||
          current.syncStatus === JotformSyncStatus.RETRY_WAIT) &&
        (!shouldApply ||
          current.lastEnqueuedBy !== JotformSyncSource.RECONCILIATION);
      const forcePointFetch = reconciliationConflict && !preserveProcessing;
      const preserveTerminalState =
        context.reconciled &&
        !shouldApply &&
        (current.syncStatus === JotformSyncStatus.DEAD_LETTER ||
          current.syncStatus === JotformSyncStatus.REJECTED);

      await tx.jotformSubmission.update({
        where: { id: recordId },
        data: {
          ...(shouldApply
            ? {
                vendorCreatedAt: canonical.vendorCreatedAt,
                vendorUpdatedAt: canonical.vendorUpdatedAt,
                vendorStatus: canonical.vendorStatus,
                workflowStatus: canonical.workflowStatus,
                ...(privacyErased
                  ? {
                      contentHash: null,
                      respondentEmail: null,
                      companyName: null,
                      dealerNumber: null,
                      reviewReasonCode: 'ACCOUNT_PRIVACY_ERASED',
                      privacyErasedAt: current.privacyErasedAt ?? now,
                    }
                  : {
                      contentHash: canonical.contentHash,
                      respondentEmail: canonical.respondentEmail,
                      companyName: canonical.companyName,
                      dealerNumber: canonical.dealerNumber,
                      reviewReasonCode: ownershipReview
                        ? 'PRIVACY_OWNERSHIP_REVIEW'
                        : canonical.respondentEmail
                          ? null
                          : 'MISSING_RESPONDENT_EMAIL',
                    }),
              }
            : {}),
          lastVerifiedAt: now,
          ...(preserveProcessing
            ? {}
            : forcePointFetch
              ? {
                  syncStatus: JotformSyncStatus.PENDING,
                  processingGeneration: null,
                  attemptCount: 0,
                  nextAttemptAt: now,
                  leaseToken: null,
                  leaseExpiresAt: null,
                }
              : preserveQueuedWork
                ? {}
                : preserveTerminalState
                  ? {}
                  : {
                      syncStatus: newerWorkArrived
                        ? JotformSyncStatus.PENDING
                        : JotformSyncStatus.PROCESSED,
                      processingGeneration: null,
                      attemptCount: 0,
                      nextAttemptAt: now,
                      leaseToken: null,
                      leaseExpiresAt: null,
                      processedAt: now,
                      deadLetteredAt: null,
                      lastErrorCode: null,
                      lastErrorHttpStatus: null,
                      lastErrorRetryable: null,
                      lastErrorAt: null,
                    }),
        },
      });
      if (
        shouldApply &&
        !privacyErased &&
        !ownershipReview &&
        !current.ownerUserId
      ) {
        await provisionJotformAccount(tx, recordId, canonical);
      }
    });
  }

  private async recordFailure(
    claimed: ClaimedSubmission,
    failure: SafeFailure,
  ): Promise<'retryScheduled' | 'deadLettered' | 'rejected'> {
    return this.prisma.$transaction(async (tx) => {
      await lockJotformSubmission(tx, claimed.id);
      const current = await tx.jotformSubmission.findUnique({
        where: { id: claimed.id },
        select: {
          generation: true,
          leaseToken: true,
          syncStatus: true,
          privacyErasedAt: true,
        },
      });
      if (
        !current ||
        current.leaseToken !== claimed.leaseToken ||
        current.syncStatus !== JotformSyncStatus.PROCESSING
      ) {
        return 'retryScheduled' as const;
      }

      const now = new Date();
      if (current.generation > claimed.processingGeneration) {
        await tx.jotformSubmission.updateMany({
          where: { id: claimed.id, leaseToken: claimed.leaseToken },
          data: {
            syncStatus: JotformSyncStatus.PENDING,
            attemptCount: 0,
            nextAttemptAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
            processingGeneration: null,
            lastErrorCode: failure.code,
            lastErrorHttpStatus: failure.httpStatus,
            lastErrorRetryable: failure.retryable,
            lastErrorAt: now,
          },
        });
        return 'retryScheduled' as const;
      }

      const globalApiFailure = isGlobalApiFailure(failure);
      const retryNotFound =
        failure.code === 'NOT_FOUND' && claimed.attemptCount < 3;
      const shouldRetry =
        globalApiFailure ||
        ((failure.retryable || retryNotFound) &&
          claimed.attemptCount < this.config.maxProcessingAttempts);
      if (shouldRetry) {
        const delay = calculateJotformRetryDelayMs({
          attempt: claimed.attemptCount,
          baseDelayMs: this.config.retryBaseDelayMs,
          maxDelayMs: this.config.retryMaxDelayMs,
          retryAfterMs: failure.retryAfterMs,
        });
        await tx.jotformSubmission.updateMany({
          where: { id: claimed.id, leaseToken: claimed.leaseToken },
          data: {
            syncStatus: JotformSyncStatus.RETRY_WAIT,
            ...(globalApiFailure
              ? { attemptCount: Math.max(0, claimed.attemptCount - 1) }
              : {}),
            nextAttemptAt: new Date(now.getTime() + delay),
            leaseToken: null,
            leaseExpiresAt: null,
            processingGeneration: null,
            lastErrorCode: failure.code,
            lastErrorHttpStatus: failure.httpStatus,
            lastErrorRetryable: true,
            lastErrorAt: now,
          },
        });
        return 'retryScheduled' as const;
      }

      const rejected = failure.rejected || failure.code === 'NOT_FOUND';
      await tx.jotformSubmission.updateMany({
        where: { id: claimed.id, leaseToken: claimed.leaseToken },
        data: {
          syncStatus: rejected
            ? JotformSyncStatus.REJECTED
            : JotformSyncStatus.DEAD_LETTER,
          leaseToken: null,
          leaseExpiresAt: null,
          processingGeneration: null,
          deadLetteredAt: now,
          lastErrorCode: failure.code,
          lastErrorHttpStatus: failure.httpStatus,
          lastErrorRetryable: failure.retryable,
          lastErrorAt: now,
          ...(rejected
            ? {
                contentHash: null,
                respondentEmail: null,
                companyName: null,
                dealerNumber: null,
                reviewReasonCode: current.privacyErasedAt
                  ? 'ACCOUNT_PRIVACY_ERASED'
                  : failure.code,
              }
            : {}),
        },
      });
      return rejected ? ('rejected' as const) : ('deadLettered' as const);
    });
  }
}

function normalizeFailure(error: unknown): SafeFailure {
  if (error instanceof JotformCanonicalSubmissionError) {
    return {
      code: error.code,
      retryable: false,
      rejected: true,
      httpStatus: null,
      retryAfterMs: null,
      limitLeft: null,
    };
  }
  if (error instanceof JotformApiError) {
    return {
      code: error.code,
      retryable: error.transient,
      rejected: error.code === 'INVALID_REQUEST',
      httpStatus: error.statusCode,
      retryAfterMs: error.retryAfterMs,
      limitLeft: error.limitLeft,
    };
  }
  return {
    code: 'INTERNAL_PROCESSING_ERROR',
    retryable: true,
    rejected: false,
    httpStatus: null,
    retryAfterMs: null,
    limitLeft: null,
  };
}

const GLOBAL_API_FAILURE_CODES = new Set([
  'TIMEOUT',
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'UPSTREAM_SERVER_ERROR',
  'AUTHENTICATION_ERROR',
]);

function isGlobalApiFailure(failure: SafeFailure) {
  return GLOBAL_API_FAILURE_CODES.has(failure.code);
}

async function lockJotformSubmission(
  tx: Prisma.TransactionClient,
  recordId: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "JotformSubmission" WHERE "id" = ${recordId} FOR UPDATE`;
}

export function nextJotformQuotaReset(now: Date) {
  // Jotform documents its daily reset as midnight EST. A five-minute buffer
  // avoids a boundary race between the scheduler and the provider counter.
  const estCalendar = new Date(now.getTime() - 5 * 60 * 60_000);
  return new Date(
    Date.UTC(
      estCalendar.getUTCFullYear(),
      estCalendar.getUTCMonth(),
      estCalendar.getUTCDate() + 1,
      5,
      5,
    ),
  );
}

function readCanonicalIdentity(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.id !== 'string' ||
    typeof value.form_id !== 'string' ||
    !/^\d{1,64}$/.test(value.id) ||
    !/^\d{1,64}$/.test(value.form_id)
  ) {
    return null;
  }
  let updatedAt: string | null = null;
  if (typeof value.updated_at === 'string') {
    try {
      updatedAt = laterVendorTimestamp(null, value.updated_at);
    } catch {
      updatedAt = null;
    }
  }
  return { submissionId: value.id, formId: value.form_id, updatedAt };
}
