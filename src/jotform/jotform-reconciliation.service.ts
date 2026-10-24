import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JotformApiClient, JotformApiError } from './jotform-api.client';
import { JOTFORM_CONFIG, JotformConfig } from './jotform.config';
import {
  JOTFORM_API_CLIENT,
  JotformApiCallDeferredError,
  JotformSyncService,
} from './jotform-sync.service';
import { JotformCanonicalSubmissionError } from './jotform-submission.mapper';
import {
  addVendorSeconds,
  laterVendorTimestamp,
  subtractVendorMinutes,
} from './jotform-vendor-time';

const JOTFORM_SUBMISSION_ID = /^\d{1,64}$/;

export type JotformReconciliationSummary = {
  disabled: boolean;
  skippedForLease: boolean;
  complete: boolean;
  pausedForRateLimit: boolean;
  pausedForProvider: boolean;
  pages: number;
  submissions: number;
  rejected: number;
  nextOffset: number;
  watermark: string | null;
  apiLimitRemaining: number | null;
};

export class JotformReconciliationError extends Error {
  constructor(public readonly code: string) {
    super('Jotform reconciliation failed');
    this.name = 'JotformReconciliationError';
  }
}

@Injectable()
export class JotformReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: JotformSyncService,
    @Inject(JOTFORM_CONFIG) private readonly config: Readonly<JotformConfig>,
    @Inject(JOTFORM_API_CLIENT)
    private readonly apiClient: JotformApiClient | null,
  ) {}

  async reconcile(): Promise<JotformReconciliationSummary> {
    const empty = {
      disabled: !this.config.enabled,
      skippedForLease: false,
      complete: false,
      pausedForRateLimit: false,
      pausedForProvider: false,
      pages: 0,
      submissions: 0,
      rejected: 0,
      nextOffset: 0,
      watermark: null,
      apiLimitRemaining: null,
    };
    if (!this.config.enabled || !this.apiClient) {
      return empty;
    }

    const leaseToken = randomUUID();
    const startedAt = new Date();
    await this.prisma.jotformSyncState.upsert({
      where: { formId: this.config.formId },
      create: { formId: this.config.formId },
      update: {},
    });
    const lease = await this.prisma.jotformSyncState.updateMany({
      where: {
        formId: this.config.formId,
        OR: [
          { leaseToken: null },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: startedAt } },
        ],
      },
      data: {
        leaseToken,
        leaseExpiresAt: this.leaseExpiry(startedAt),
        lastAttemptAt: startedAt,
      },
    });
    if (lease.count !== 1) {
      return { ...empty, disabled: false, skippedForLease: true };
    }

    try {
      const state = await this.prisma.jotformSyncState.findUniqueOrThrow({
        where: { formId: this.config.formId },
      });
      const continuingScan = Boolean(
        state.reconciliationFrom && state.reconciliationHighWatermark,
      );
      // Every completed provider frontier is rewound by the configured overlap
      // before the next scan. That makes the strict lower bound safe at
      // second-level timestamp boundaries and rechecks recent Jotform edits.
      const reconciliationFrom = continuingScan
        ? state.reconciliationFrom!
        : state.watermark
          ? subtractVendorMinutes(
              state.watermark,
              this.config.reconciliationLookbackMinutes,
            )
          : this.config.reconciliationStartAt;
      if (!reconciliationFrom) {
        throw new JotformReconciliationError(
          'RECONCILIATION_START_NOT_CONFIGURED',
        );
      }
      let offset = continuingScan ? state.reconciliationOffset : 0;
      let highWatermark = continuingScan
        ? state.reconciliationHighWatermark
        : null;
      let afterSubmissionId = continuingScan
        ? state.reconciliationAfterId
        : null;
      if (afterSubmissionId && !JOTFORM_SUBMISSION_ID.test(afterSubmissionId)) {
        throw new JotformReconciliationError(
          'RECONCILIATION_INVALID_DURABLE_CURSOR',
        );
      }
      let submissions = 0;
      let rejected = 0;
      let pages = 0;
      let apiLimitRemaining = state.apiLimitRemaining;

      // Jotform's submission collection uses index-based offsets and its
      // documented ordering is descending. Offsets are unsafe for a live set:
      // an edit can move a row out of an earlier page and shift an unseen row
      // behind the saved offset. First capture a provider-clock frontier, then
      // walk the fixed time window by the immutable submission ID instead.
      if (!continuingScan) {
        let apiCall;
        try {
          apiCall = await this.sync.executeApiCall(() =>
            this.apiClient!.getFormSubmissions(this.config.formId, {
              offset: 0,
              limit: 2,
              orderby: 'updated_at',
              filter: { 'updated_at:gt': reconciliationFrom },
            }),
          );
        } catch (error: unknown) {
          if (!(error instanceof JotformApiCallDeferredError)) {
            throw error;
          }
          await this.releasePartialScan(leaseToken, error.reason);
          return pausedSummary(
            empty,
            error.reason,
            pages,
            submissions,
            rejected,
            offset,
            highWatermark,
            apiLimitRemaining,
          );
        }

        const { response, quotaReached } = apiCall;
        pages += 1;
        apiLimitRemaining = response.limitLeft;
        highWatermark = readDescendingUpdatedAtFrontier(response.content);

        if (highWatermark && highWatermark <= reconciliationFrom) {
          throw new JotformReconciliationError(
            'RECONCILIATION_RESULT_OUTSIDE_WINDOW',
          );
        }
        if (!highWatermark) {
          await this.finishScan(leaseToken, state.watermark);
          return {
            disabled: false,
            skippedForLease: false,
            complete: true,
            pausedForRateLimit: false,
            pausedForProvider: false,
            pages,
            submissions,
            rejected,
            nextOffset: 0,
            watermark: state.watermark,
            apiLimitRemaining,
          };
        }

        await this.updateCheckpoint(leaseToken, {
          reconciliationFrom,
          reconciliationOffset: 0,
          reconciliationHighWatermark: highWatermark,
          reconciliationAfterId: null,
          leaseExpiresAt: this.leaseExpiry(new Date()),
        });

        if (quotaReached || pages >= this.config.reconciliationMaxPages) {
          const reason = quotaReached ? 'API_RATE_LIMIT_RESERVE' : null;
          await this.releasePartialScan(leaseToken, reason);
          return {
            ...pausedSummary(
              empty,
              reason,
              pages,
              submissions,
              rejected,
              offset,
              highWatermark,
              apiLimitRemaining,
            ),
            pausedForRateLimit: quotaReached,
          };
        }
      }

      for (let page = 0; page < this.config.reconciliationMaxPages; page += 1) {
        if (pages >= this.config.reconciliationMaxPages) {
          break;
        }
        let apiCall;
        try {
          const filter: Record<string, string> = {
            'updated_at:gt': reconciliationFrom,
            'updated_at:lt': addVendorSeconds(highWatermark!, 1),
          };
          if (afterSubmissionId) {
            filter['id:lt'] = afterSubmissionId;
          }
          apiCall = await this.sync.executeApiCall(() =>
            this.apiClient!.getFormSubmissions(this.config.formId, {
              offset: 0,
              limit: this.config.reconciliationPageSize,
              orderby: 'id',
              filter,
            }),
          );
        } catch (error: unknown) {
          if (!(error instanceof JotformApiCallDeferredError)) {
            throw error;
          }
          await this.releasePartialScan(leaseToken, error.reason);
          return pausedSummary(
            empty,
            error.reason,
            pages,
            submissions,
            rejected,
            offset,
            highWatermark,
            apiLimitRemaining,
          );
        }
        const { response, quotaReached } = apiCall;
        pages += 1;
        apiLimitRemaining = response.limitLeft;
        validatePageWindow(
          response.content,
          reconciliationFrom,
          highWatermark!,
        );
        const pageCursor = readDescendingPageCursor(
          response.content,
          afterSubmissionId,
        );

        for (
          let submissionIndex = 0;
          submissionIndex < response.content.length;
          submissionIndex += 1
        ) {
          if (submissionIndex > 0 && submissionIndex % 25 === 0) {
            const heartbeatAt = new Date();
            await this.updateCheckpoint(leaseToken, {
              leaseExpiresAt: this.leaseExpiry(heartbeatAt),
            });
          }
          const submission = response.content[submissionIndex];
          try {
            const recorded =
              await this.sync.recordReconciledSubmission(submission);
            if (recorded.recorded) {
              submissions += 1;
            }
          } catch (error: unknown) {
            if (!(error instanceof JotformCanonicalSubmissionError)) {
              throw error;
            }
            const durableRejection =
              await this.sync.recordRejectedReconciliationSubmission(
                submission,
                error.code,
              );
            if (!durableRejection.recorded) {
              throw new JotformReconciliationError(
                'RECONCILIATION_UNKEYED_SUBMISSION',
              );
            }
            rejected += 1;
          }
        }

        offset += response.content.length;
        if (pageCursor) {
          afterSubmissionId = pageCursor;
        }
        const pageFinishedAt = new Date();
        await this.updateCheckpoint(leaseToken, {
          reconciliationFrom,
          reconciliationOffset: offset,
          reconciliationHighWatermark: highWatermark,
          reconciliationAfterId: afterSubmissionId,
          leaseExpiresAt: this.leaseExpiry(pageFinishedAt),
        });

        if (response.content.length < this.config.reconciliationPageSize) {
          await this.finishScan(leaseToken, highWatermark);
          return {
            disabled: false,
            skippedForLease: false,
            complete: true,
            pausedForRateLimit: false,
            pausedForProvider: false,
            pages,
            submissions,
            rejected,
            nextOffset: 0,
            watermark: highWatermark,
            apiLimitRemaining,
          };
        }

        if (quotaReached) {
          await this.releasePartialScan(leaseToken, 'API_RATE_LIMIT_RESERVE');
          return {
            disabled: false,
            skippedForLease: false,
            complete: false,
            pausedForRateLimit: true,
            pausedForProvider: false,
            pages,
            submissions,
            rejected,
            nextOffset: offset,
            watermark: highWatermark,
            apiLimitRemaining,
          };
        }
      }

      await this.releasePartialScan(leaseToken, null);
      return {
        disabled: false,
        skippedForLease: false,
        complete: false,
        pausedForRateLimit: false,
        pausedForProvider: false,
        pages,
        submissions,
        rejected,
        nextOffset: offset,
        watermark: highWatermark,
        apiLimitRemaining,
      };
    } catch (error: unknown) {
      const code = safeReconciliationErrorCode(error);
      await this.prisma.jotformSyncState.updateMany({
        where: { formId: this.config.formId, leaseToken },
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
          consecutiveFailures: { increment: 1 },
          lastErrorCode: code,
        },
      });
      throw new JotformReconciliationError(code);
    }
  }

  private async updateCheckpoint(
    leaseToken: string,
    data: Prisma.JotformSyncStateUpdateManyMutationInput,
  ) {
    const result = await this.prisma.jotformSyncState.updateMany({
      where: { formId: this.config.formId, leaseToken },
      data,
    });
    if (result.count !== 1) {
      throw new JotformReconciliationError('RECONCILIATION_LEASE_LOST');
    }
  }

  private async finishScan(leaseToken: string, watermark: string | null) {
    const now = new Date();
    await this.updateCheckpoint(leaseToken, {
      watermark,
      reconciliationFrom: null,
      reconciliationOffset: 0,
      reconciliationHighWatermark: null,
      reconciliationAfterId: null,
      lastSuccessfulAt: now,
      consecutiveFailures: 0,
      lastErrorCode: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  }

  private async releasePartialScan(leaseToken: string, reason: string | null) {
    await this.updateCheckpoint(leaseToken, {
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: reason,
    });
  }

  private leaseExpiry(now: Date) {
    const leaseDurationMs = Math.max(
      this.config.processingLeaseSeconds * 1_000,
      this.config.requestTimeoutMs + 60_000,
      5 * 60_000,
    );
    return new Date(now.getTime() + leaseDurationMs);
  }
}

function pausedSummary(
  empty: JotformReconciliationSummary,
  reason: string | null,
  pages: number,
  submissions: number,
  rejected: number,
  nextOffset: number,
  watermark: string | null,
  apiLimitRemaining: number | null,
): JotformReconciliationSummary {
  return {
    ...empty,
    disabled: false,
    complete: false,
    pausedForRateLimit: reason === 'API_RATE_LIMIT_RESERVE',
    pausedForProvider: reason !== null && reason !== 'API_RATE_LIMIT_RESERVE',
    pages,
    submissions,
    rejected,
    nextOffset,
    watermark,
    apiLimitRemaining,
  };
}

function readDescendingPageCursor(
  content: readonly unknown[],
  afterSubmissionId: string | null,
) {
  let previousId: string | null = null;
  for (const submission of content) {
    if (
      !submission ||
      typeof submission !== 'object' ||
      Array.isArray(submission) ||
      typeof (submission as Record<string, unknown>).id !== 'string' ||
      !JOTFORM_SUBMISSION_ID.test(
        (submission as Record<string, unknown>).id as string,
      )
    ) {
      throw new JotformReconciliationError(
        'RECONCILIATION_INVALID_SUBMISSION_ID',
      );
    }
    const currentId = (submission as Record<string, unknown>).id as string;
    if (
      previousId === null &&
      afterSubmissionId !== null &&
      compareDigitStrings(afterSubmissionId, currentId) <= 0
    ) {
      throw new JotformReconciliationError(
        'RECONCILIATION_CURSOR_NOT_ADVANCED',
      );
    }
    if (previousId && compareDigitStrings(previousId, currentId) <= 0) {
      throw new JotformReconciliationError('RECONCILIATION_UNSTABLE_ID_ORDER');
    }
    previousId = currentId;
  }
  return previousId;
}

function readDescendingUpdatedAtFrontier(content: readonly unknown[]) {
  let frontier: string | null = null;
  let previousTimestamp: string | null = null;
  for (const submission of content) {
    const timestamp = readValidUpdatedAt(submission);
    if (!timestamp) {
      throw new JotformReconciliationError('RECONCILIATION_INVALID_FRONTIER');
    }
    if (previousTimestamp && timestamp > previousTimestamp) {
      throw new JotformReconciliationError(
        'RECONCILIATION_UNSTABLE_UPDATED_AT_ORDER',
      );
    }
    frontier ??= timestamp;
    previousTimestamp = timestamp;
  }
  return frontier;
}

function validatePageWindow(
  content: readonly unknown[],
  reconciliationFrom: string,
  highWatermark: string,
) {
  for (const submission of content) {
    const timestamp = readValidUpdatedAt(submission);
    // Invalid timestamps are isolated by the canonical rejection path. A valid
    // timestamp outside this scan's fixed window means the provider did not
    // honor the filter, so advancing the cursor would no longer be safe.
    if (
      timestamp &&
      (timestamp <= reconciliationFrom || timestamp > highWatermark)
    ) {
      throw new JotformReconciliationError(
        'RECONCILIATION_RESULT_OUTSIDE_WINDOW',
      );
    }
  }
}

function compareDigitStrings(left: string, right: string) {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  if (normalizedLeft === normalizedRight) {
    return 0;
  }
  return normalizedLeft > normalizedRight ? 1 : -1;
}

function readValidUpdatedAt(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const value = (input as Record<string, unknown>).updated_at;
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return laterVendorTimestamp(null, value);
  } catch {
    return null;
  }
}

function safeReconciliationErrorCode(error: unknown) {
  if (
    error instanceof JotformApiError ||
    error instanceof JotformCanonicalSubmissionError ||
    error instanceof JotformReconciliationError
  ) {
    return error.code;
  }
  return 'RECONCILIATION_INTERNAL_ERROR';
}
