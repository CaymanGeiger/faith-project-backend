/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { JotformSyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JotformApiClient, JotformApiError } from './jotform-api.client';
import { JotformConfig } from './jotform.config';
import {
  JotformApiCallDeferredError,
  JotformSyncService,
} from './jotform-sync.service';

const FORM_ID = '252405795315055';
const SUBMISSION_ID = '6097407143436278355';

type ModelMock = Record<string, jest.Mock>;

type ApiClientMock = {
  getSubmission: jest.Mock;
  getFormSubmissions: jest.Mock;
};

type PrismaMock = {
  jotformSubmission: ModelMock;
  jotformSyncState: ModelMock;
  user: ModelMock;
  accountDeletionRequest: ModelMock;
  prospectProfile: ModelMock;
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
};

function createPrismaMock(): PrismaMock {
  const prisma: PrismaMock = {
    jotformSubmission: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      groupBy: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    jotformSyncState: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    accountDeletionRequest: {
      findFirst: jest.fn(),
    },
    prospectProfile: {
      create: jest.fn(),
      update: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: '' }]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (operation: (transaction: PrismaMock) => unknown) =>
      Promise.resolve(operation(prisma)),
  );
  prisma.jotformSyncState.findUnique.mockResolvedValue(null);
  prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue({
    apiLimitRemaining: null,
    apiLimitResetAt: null,
    apiCircuitOpenUntil: null,
  });
  prisma.jotformSyncState.update.mockResolvedValue({ formId: FORM_ID });
  prisma.jotformSyncState.updateMany.mockResolvedValue({ count: 1 });
  prisma.jotformSyncState.upsert.mockResolvedValue({ formId: FORM_ID });
  prisma.accountDeletionRequest.findFirst.mockResolvedValue(null);
  return prisma;
}

function createApiClientMock(): ApiClientMock {
  return {
    getSubmission: jest.fn(),
    getFormSubmissions: jest.fn(),
  };
}

function asApiClient(mock: ApiClientMock) {
  return mock as unknown as JotformApiClient;
}

function createConfig(
  override: Partial<JotformConfig> = {},
): Readonly<JotformConfig> {
  return {
    enabled: true,
    apiBaseUrl: 'https://api.jotform.com',
    requestTimeoutMs: 10_000,
    processingBatchSize: 5,
    reconciliationPageSize: 100,
    reconciliationMaxPages: 10,
    apiRateLimitReserve: 100,
    maxProcessingAttempts: 3,
    retryBaseDelayMs: 30_000,
    retryMaxDelayMs: 3_600_000,
    reconciliationLookbackMinutes: 1_440,
    reconciliationStartAt: '2026-01-01 00:00:00',
    processingLeaseSeconds: 120,
    formId: FORM_ID,
    questionIds: {
      email: '13',
      company: '14',
      name: '4',
      dealerNumber: null,
    },
    apiKey: 'test-api-key',
    webhookSecret: 's'.repeat(32),
    previousWebhookSecret: null,
    ...override,
  };
}

function canonicalSubmission(
  override: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: SUBMISSION_ID,
    form_id: FORM_ID,
    created_at: '2026-09-06 12:00:00',
    updated_at: '2026-09-06 12:01:00',
    status: 'ACTIVE',
    workflowStatus: 'Pending review',
    answers: {
      '13': { type: 'control_email', answer: ' Dealer@Example.com ' },
      '14': { type: 'control_textbox', answer: ' Example HVAC ' },
      '4': {
        type: 'control_fullname',
        answer: { first: 'Ada', last: 'Dealer' },
      },
    },
    ...override,
  };
}

function arrangeClaim(prisma: PrismaMock, attemptCount: number) {
  prisma.jotformSubmission.findFirst.mockResolvedValueOnce({
    id: 'queue-1',
    generation: 4,
  });
  prisma.jotformSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
  prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
    id: 'queue-1',
    submissionId: SUBMISSION_ID,
    attemptCount,
    processingGeneration: 4,
    leaseToken: 'lease-1',
  });
}

describe('JotformSyncService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists only an API-verified submission without mutating or linking an app account', async () => {
    const prisma = createPrismaMock();
    const apiClient = createApiClientMock();
    arrangeClaim(prisma, 1);
    jest.mocked(apiClient.getSubmission).mockResolvedValue({
      responseCode: 200,
      limitLeft: 9_000,
      content: canonicalSubmission(),
    });
    prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
      id: 'queue-1',
      generation: 4,
      syncStatus: JotformSyncStatus.PROCESSING,
      leaseToken: 'lease-1',
      vendorUpdatedAt: null,
      contentHash: null,
      privacyErasedAt: null,
    });
    prisma.jotformSubmission.update.mockResolvedValue({ id: 'queue-1' });

    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      asApiClient(apiClient),
    );
    const summary = await service.processDue(1);

    expect(summary).toEqual({
      claimed: 1,
      processed: 1,
      retryScheduled: 0,
      deadLettered: 0,
      rejected: 0,
    });
    expect(apiClient.getSubmission).toHaveBeenCalledWith(SUBMISSION_ID);
    expect(prisma.jotformSubmission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'queue-1' },
        data: expect.objectContaining({
          respondentEmail: 'dealer@example.com',
          companyName: 'Example HVAC',
          reviewReasonCode: null,
          syncStatus: JotformSyncStatus.PROCESSED,
        }),
      }),
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.prospectProfile.create).not.toHaveBeenCalled();
    expect(prisma.prospectProfile.update).not.toHaveBeenCalled();
  });

  it.each([
    ['form', { form_id: '999999999999999' }],
    ['submission', { id: '6097407143436278356' }],
  ])(
    'rejects a canonical %s ID mismatch without linking an account',
    async (_kind, canonicalOverride) => {
      const prisma = createPrismaMock();
      const apiClient = createApiClientMock();
      arrangeClaim(prisma, 1);
      jest.mocked(apiClient.getSubmission).mockResolvedValue({
        responseCode: 200,
        limitLeft: 8_999,
        content: canonicalSubmission(canonicalOverride),
      });
      prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
        generation: 4,
        leaseToken: 'lease-1',
        syncStatus: JotformSyncStatus.PROCESSING,
      });
      prisma.jotformSubmission.updateMany.mockResolvedValueOnce({ count: 1 });

      const service = new JotformSyncService(
        prisma as unknown as PrismaService,
        createConfig(),
        asApiClient(apiClient),
      );
      const summary = await service.processDue(1);

      expect(summary.rejected).toBe(1);
      expect(prisma.jotformSubmission.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'queue-1', leaseToken: 'lease-1' },
        data: expect.objectContaining({
          syncStatus: JotformSyncStatus.REJECTED,
          lastErrorCode: 'CANONICAL_ID_MISMATCH',
          lastErrorRetryable: false,
        }),
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.jotformSubmission.update).not.toHaveBeenCalled();
    },
  );

  it('opens the shared API circuit and preserves the row retry budget for an upstream failure', async () => {
    const prisma = createPrismaMock();
    const apiClient = createApiClientMock();
    arrangeClaim(prisma, 1);
    jest.mocked(apiClient.getSubmission).mockRejectedValue(
      new JotformApiError('upstream unavailable', {
        code: 'UPSTREAM_SERVER_ERROR',
        transient: true,
        statusCode: 503,
        retryAfterMs: 45_000,
      }),
    );
    prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
      generation: 4,
      leaseToken: 'lease-1',
      syncStatus: JotformSyncStatus.PROCESSING,
    });
    prisma.jotformSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const startedAt = Date.now();

    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      asApiClient(apiClient),
    );
    const summary = await service.processDue(1);

    expect(summary.retryScheduled).toBe(1);
    const retryWrite =
      prisma.jotformSubmission.updateMany.mock.calls.at(-1)?.[0];
    expect(retryWrite).toEqual({
      where: { id: 'queue-1', leaseToken: 'lease-1' },
      data: expect.objectContaining({
        syncStatus: JotformSyncStatus.RETRY_WAIT,
        attemptCount: 0,
        lastErrorCode: 'UPSTREAM_SERVER_ERROR',
        lastErrorHttpStatus: 503,
        lastErrorRetryable: true,
        nextAttemptAt: expect.any(Date),
      }),
    });
    expect(retryWrite.data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      startedAt + 45_000,
    );
    expect(prisma.jotformSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          apiCircuitOpenUntil: expect.any(Date),
          apiCircuitReason: 'UPSTREAM_SERVER_ERROR',
        }),
      }),
    );
  });

  it('treats a global authentication failure as a provider pause without consuming the item retry budget', async () => {
    const prisma = createPrismaMock();
    const apiClient = createApiClientMock();
    arrangeClaim(prisma, 3);
    apiClient.getSubmission.mockRejectedValue(
      new JotformApiError('authentication failed', {
        code: 'AUTHENTICATION_ERROR',
        transient: false,
        statusCode: 403,
      }),
    );
    prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
      generation: 4,
      leaseToken: 'lease-1',
      syncStatus: JotformSyncStatus.PROCESSING,
    });
    prisma.jotformSubmission.updateMany.mockResolvedValueOnce({ count: 1 });

    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig({ maxProcessingAttempts: 3 }),
      asApiClient(apiClient),
    );
    const summary = await service.processDue(1);

    expect(summary).toMatchObject({
      claimed: 1,
      retryScheduled: 1,
      deadLettered: 0,
      rejected: 0,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.jotformSubmission.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'queue-1', leaseToken: 'lease-1' },
      data: expect.objectContaining({
        syncStatus: JotformSyncStatus.RETRY_WAIT,
        attemptCount: 2,
        lastErrorCode: 'AUTHENTICATION_ERROR',
        lastErrorHttpStatus: 403,
        lastErrorRetryable: true,
      }),
    });
    expect(prisma.jotformSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          apiCircuitOpenUntil: expect.any(Date),
          apiCircuitReason: 'AUTHENTICATION_ERROR',
        }),
      }),
    );
  });

  it('leaves a newer webhook generation pending after an in-flight fetch succeeds', async () => {
    const prisma = createPrismaMock();
    const apiClient = createApiClientMock();
    arrangeClaim(prisma, 1);
    apiClient.getSubmission.mockResolvedValue({
      responseCode: 200,
      limitLeft: 9_000,
      content: canonicalSubmission(),
    });
    prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
      id: 'queue-1',
      generation: 5,
      syncStatus: JotformSyncStatus.PROCESSING,
      leaseToken: 'lease-1',
      vendorUpdatedAt: null,
      contentHash: null,
      privacyErasedAt: null,
    });
    prisma.jotformSubmission.update.mockResolvedValue({ id: 'queue-1' });

    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      asApiClient(apiClient),
    );
    const summary = await service.processDue(1);

    expect(summary.processed).toBe(1);
    expect(prisma.jotformSubmission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'queue-1' },
        data: expect.objectContaining({
          respondentEmail: 'dealer@example.com',
          syncStatus: JotformSyncStatus.PENDING,
          attemptCount: 0,
          processingGeneration: null,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      }),
    );
  });

  it('leaves a newer webhook generation pending when an in-flight final attempt fails', async () => {
    const prisma = createPrismaMock();
    const apiClient = createApiClientMock();
    arrangeClaim(prisma, 3);
    apiClient.getSubmission.mockRejectedValue(
      new Error('unsafe internal detail'),
    );
    prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
      generation: 5,
      leaseToken: 'lease-1',
      syncStatus: JotformSyncStatus.PROCESSING,
    });
    prisma.jotformSubmission.updateMany.mockResolvedValueOnce({ count: 1 });

    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig({ maxProcessingAttempts: 3 }),
      asApiClient(apiClient),
    );
    const summary = await service.processDue(1);

    expect(summary).toMatchObject({
      claimed: 1,
      retryScheduled: 1,
      deadLettered: 0,
      rejected: 0,
    });
    expect(prisma.jotformSubmission.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'queue-1', leaseToken: 'lease-1' },
      data: expect.objectContaining({
        syncStatus: JotformSyncStatus.PENDING,
        attemptCount: 0,
        nextAttemptAt: expect.any(Date),
        leaseToken: null,
        leaseExpiresAt: null,
        processingGeneration: null,
        lastErrorCode: 'INTERNAL_PROCESSING_ERROR',
      }),
    });
  });

  it('dead-letters an unclassified per-record failure after the configured final attempt', async () => {
    const prisma = createPrismaMock();
    const apiClient = createApiClientMock();
    arrangeClaim(prisma, 3);
    jest
      .mocked(apiClient.getSubmission)
      .mockRejectedValue(new Error('unsafe internal detail'));
    prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
      generation: 4,
      leaseToken: 'lease-1',
      syncStatus: JotformSyncStatus.PROCESSING,
    });
    prisma.jotformSubmission.updateMany.mockResolvedValueOnce({ count: 1 });

    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig({ maxProcessingAttempts: 3 }),
      asApiClient(apiClient),
    );
    const summary = await service.processDue(1);

    expect(summary.deadLettered).toBe(1);
    expect(prisma.jotformSubmission.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'queue-1', leaseToken: 'lease-1' },
      data: expect.objectContaining({
        syncStatus: JotformSyncStatus.DEAD_LETTER,
        lastErrorCode: 'INTERNAL_PROCESSING_ERROR',
        lastErrorRetryable: true,
        deadLetteredAt: expect.any(Date),
      }),
    });
  });

  it.each(['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'] as const)(
    'bounds a per-submission %s failure to the row retry budget instead of opening a global circuit',
    async (code) => {
      const prisma = createPrismaMock();
      const apiClient = createApiClientMock();
      arrangeClaim(prisma, 3);
      apiClient.getSubmission.mockRejectedValue(
        new JotformApiError('safe provider response failure', {
          code,
          transient: true,
        }),
      );
      prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
        generation: 4,
        leaseToken: 'lease-1',
        syncStatus: JotformSyncStatus.PROCESSING,
      });
      prisma.jotformSubmission.updateMany.mockResolvedValueOnce({ count: 1 });

      const service = new JotformSyncService(
        prisma as unknown as PrismaService,
        createConfig({ maxProcessingAttempts: 3 }),
        asApiClient(apiClient),
      );
      const summary = await service.processDue(1);

      expect(summary.deadLettered).toBe(1);
      expect(prisma.jotformSubmission.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'queue-1', leaseToken: 'lease-1' },
        data: expect.objectContaining({
          syncStatus: JotformSyncStatus.DEAD_LETTER,
          lastErrorCode: code,
          lastErrorRetryable: true,
          deadLetteredAt: expect.any(Date),
        }),
      });
      const terminalWrite =
        prisma.jotformSubmission.updateMany.mock.calls.at(-1)?.[0].data;
      expect(terminalWrite).not.toHaveProperty('attemptCount');
      expect(prisma.jotformSyncState.upsert).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'] as const)(
    'continues the batch to a valid row after a per-item %s failure reaches its terminal attempt',
    async (code) => {
      const prisma = createPrismaMock();
      const apiClient = createApiClientMock();
      const oversizedId = '6097407143436278354';
      const validId = '6097407143436278356';
      prisma.jotformSubmission.findFirst
        .mockResolvedValueOnce({ id: 'queue-oversized', generation: 1 })
        .mockResolvedValueOnce({ id: 'queue-valid', generation: 1 });
      prisma.jotformSubmission.updateMany.mockResolvedValue({ count: 1 });
      prisma.jotformSubmission.findUnique
        .mockResolvedValueOnce({
          id: 'queue-oversized',
          submissionId: oversizedId,
          attemptCount: 3,
          processingGeneration: 1,
          leaseToken: 'lease-oversized',
        })
        .mockResolvedValueOnce({
          generation: 1,
          leaseToken: 'lease-oversized',
          syncStatus: JotformSyncStatus.PROCESSING,
        })
        .mockResolvedValueOnce({
          id: 'queue-valid',
          submissionId: validId,
          attemptCount: 1,
          processingGeneration: 1,
          leaseToken: 'lease-valid',
        })
        .mockResolvedValueOnce({
          id: 'queue-valid',
          generation: 1,
          syncStatus: JotformSyncStatus.PROCESSING,
          leaseToken: 'lease-valid',
          vendorUpdatedAt: null,
          contentHash: null,
          privacyErasedAt: null,
        });
      apiClient.getSubmission
        .mockRejectedValueOnce(
          new JotformApiError('invalid item response', {
            code,
            transient: true,
          }),
        )
        .mockResolvedValueOnce({
          responseCode: 200,
          limitLeft: 8_999,
          content: canonicalSubmission({ id: validId }),
        });
      prisma.jotformSubmission.update.mockResolvedValue({ id: 'queue-valid' });

      const service = new JotformSyncService(
        prisma as unknown as PrismaService,
        createConfig({ maxProcessingAttempts: 3 }),
        asApiClient(apiClient),
      );
      const summary = await service.processDue(2);

      expect(summary).toEqual({
        claimed: 2,
        processed: 1,
        retryScheduled: 0,
        deadLettered: 1,
        rejected: 0,
      });
      expect(apiClient.getSubmission.mock.calls[0]?.[0]).toBe(oversizedId);
      expect(apiClient.getSubmission.mock.calls[1]?.[0]).toBe(validId);
      expect(prisma.jotformSubmission.updateMany).toHaveBeenCalledWith({
        where: { id: 'queue-oversized', leaseToken: 'lease-oversized' },
        data: expect.objectContaining({
          syncStatus: JotformSyncStatus.DEAD_LETTER,
          lastErrorCode: code,
        }),
      });
      expect(prisma.jotformSubmission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'queue-valid' },
          data: expect.objectContaining({
            respondentEmail: 'dealer@example.com',
            syncStatus: JotformSyncStatus.PROCESSED,
          }),
        }),
      );
    },
  );

  it('does not look up any app account even when the submission email could match one', async () => {
    const prisma = createPrismaMock();
    const apiClient = createApiClientMock();
    arrangeClaim(prisma, 1);
    jest.mocked(apiClient.getSubmission).mockResolvedValue({
      responseCode: 200,
      limitLeft: 9_000,
      content: canonicalSubmission(),
    });
    prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
      id: 'queue-1',
      generation: 4,
      syncStatus: JotformSyncStatus.PROCESSING,
      leaseToken: 'lease-1',
      vendorUpdatedAt: null,
      contentHash: null,
      privacyErasedAt: null,
    });
    prisma.jotformSubmission.update.mockResolvedValue({ id: 'queue-1' });

    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      asApiClient(apiClient),
    );
    await service.processDue(1);

    expect(prisma.jotformSubmission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          respondentEmail: 'dealer@example.com',
          syncStatus: JotformSyncStatus.PROCESSED,
        }),
      }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.prospectProfile.update).not.toHaveBeenCalled();
  });

  it('flags unowned imports for review instead of inferring ownership from a deleted email', async () => {
    const prisma = createPrismaMock();
    const apiClient = createApiClientMock();
    arrangeClaim(prisma, 1);
    jest.mocked(apiClient.getSubmission).mockResolvedValue({
      responseCode: 200,
      limitLeft: 9_000,
      content: canonicalSubmission(),
    });
    prisma.jotformSubmission.findUnique.mockResolvedValueOnce({
      id: 'queue-1',
      generation: 4,
      syncStatus: JotformSyncStatus.PROCESSING,
      leaseToken: 'lease-1',
      vendorUpdatedAt: null,
      contentHash: null,
      privacyErasedAt: null,
    });
    prisma.accountDeletionRequest.findFirst.mockResolvedValueOnce({
      id: 'completed-deletion-1',
    });
    prisma.jotformSubmission.update.mockResolvedValue({ id: 'queue-1' });

    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      asApiClient(apiClient),
    );
    const summary = await service.processDue(1);

    expect(summary.processed).toBe(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.accountDeletionRequest.findFirst).toHaveBeenCalledWith({
      where: {
        email: 'dealer@example.com',
        status: 'COMPLETED',
      },
      select: { id: true },
    });
    expect(prisma.jotformSubmission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'queue-1' },
        data: expect.objectContaining({
          respondentEmail: 'dealer@example.com',
          reviewReasonCode: 'PRIVACY_OWNERSHIP_REVIEW',
          syncStatus: JotformSyncStatus.PROCESSED,
        }),
      }),
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$queryRaw.mock.invocationCallOrder[1],
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      prisma.accountDeletionRequest.findFirst.mock.invocationCallOrder[0],
    );
    expect(
      prisma.accountDeletionRequest.findFirst.mock.invocationCallOrder[0],
    ).toBeLessThan(
      prisma.jotformSubmission.update.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('does not let a stale malformed reconciliation item replace newer verified canonical data', async () => {
    const prisma = createPrismaMock();
    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      null,
    );
    prisma.jotformSubmission.upsert.mockResolvedValueOnce({ id: 'queue-1' });
    prisma.jotformSubmission.findUniqueOrThrow.mockResolvedValueOnce({
      id: 'queue-1',
      syncStatus: JotformSyncStatus.PROCESSED,
      vendorUpdatedAt: '2026-09-06 12:02:00',
      respondentEmail: 'dealer@example.com',
      companyName: 'Example HVAC',
      contentHash: 'verified-content-hash',
    });
    prisma.jotformSubmission.update.mockResolvedValue({ id: 'queue-1' });

    const result = await service.recordRejectedReconciliationSubmission(
      {
        id: SUBMISSION_ID,
        form_id: FORM_ID,
        updated_at: '2026-09-06 12:01:00',
      },
      'EMAIL_QUESTION_TYPE_MISMATCH',
    );

    expect(result).toEqual({ recorded: true, outcome: 'preserved' });
    expect(prisma.jotformSubmission.create).not.toHaveBeenCalled();
    expect(prisma.jotformSubmission.update).toHaveBeenCalledWith({
      where: { id: 'queue-1' },
      data: {
        lastErrorCode: 'EMAIL_QUESTION_TYPE_MISMATCH',
        lastErrorRetryable: false,
        lastErrorAt: expect.any(Date),
      },
    });
    const update = prisma.jotformSubmission.update.mock.calls[0]?.[0].data;
    expect(update).not.toHaveProperty('syncStatus');
    expect(update).not.toHaveProperty('respondentEmail');
    expect(update).not.toHaveProperty('companyName');
    expect(update).not.toHaveProperty('contentHash');
  });

  it('keeps a stable malformed reconciliation observation terminal instead of scheduling a point-fetch loop', async () => {
    const prisma = createPrismaMock();
    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      null,
    );
    const kick = jest.spyOn(service, 'kick');
    prisma.jotformSubmission.upsert.mockResolvedValueOnce({ id: 'queue-1' });
    prisma.jotformSubmission.findUniqueOrThrow.mockResolvedValueOnce({
      id: 'queue-1',
      syncStatus: JotformSyncStatus.REJECTED,
      vendorUpdatedAt: '2026-09-06 12:01:00',
      respondentEmail: null,
      companyName: null,
      contentHash: null,
    });
    prisma.jotformSubmission.update.mockResolvedValue({ id: 'queue-1' });

    const result = await service.recordRejectedReconciliationSubmission(
      {
        id: SUBMISSION_ID,
        form_id: FORM_ID,
        updated_at: '2026-09-06 12:01:00',
      },
      'EMAIL_QUESTION_TYPE_MISMATCH',
    );

    expect(result).toEqual({ recorded: true, outcome: 'preserved' });
    expect(kick).not.toHaveBeenCalled();
    expect(prisma.jotformSubmission.update).toHaveBeenCalledWith({
      where: { id: 'queue-1' },
      data: {
        lastErrorCode: 'EMAIL_QUESTION_TYPE_MISMATCH',
        lastErrorRetryable: false,
        lastErrorAt: expect.any(Date),
      },
    });
    const update = prisma.jotformSubmission.update.mock.calls[0]?.[0].data;
    expect(update).not.toHaveProperty('syncStatus');
    expect(update).not.toHaveProperty('generation');
    expect(update).not.toHaveProperty('nextAttemptAt');
  });

  it('invalidates an in-flight point fetch when reconciliation observes a newer malformed generation', async () => {
    const prisma = createPrismaMock();
    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      null,
    );
    const kick = jest.spyOn(service, 'kick');
    prisma.jotformSubmission.upsert.mockResolvedValueOnce({ id: 'queue-1' });
    prisma.jotformSubmission.findUniqueOrThrow.mockResolvedValueOnce({
      id: 'queue-1',
      syncStatus: JotformSyncStatus.PROCESSING,
      generation: 7,
      processingGeneration: 7,
      leaseToken: 'lease-1',
      vendorUpdatedAt: '2026-09-06 12:01:00',
      respondentEmail: 'dealer@example.com',
      companyName: 'Example HVAC',
      dealerNumber: null,
      contentHash: 'verified-content-hash',
      privacyErasedAt: null,
    });
    prisma.jotformSubmission.update.mockResolvedValue({ id: 'queue-1' });

    const result = await service.recordRejectedReconciliationSubmission(
      {
        id: SUBMISSION_ID,
        form_id: FORM_ID,
        updated_at: '2026-09-06 12:02:00',
      },
      'EMAIL_QUESTION_TYPE_MISMATCH',
    );

    expect(result).toEqual({
      recorded: true,
      outcome: 'processing-invalidated',
    });
    expect(kick).not.toHaveBeenCalled();
    expect(prisma.jotformSubmission.update).toHaveBeenCalledWith({
      where: { id: 'queue-1' },
      data: expect.objectContaining({
        lastEnqueuedBy: 'RECONCILIATION',
        generation: { increment: 1 },
        nextAttemptAt: expect.any(Date),
        lastErrorCode: 'EMAIL_QUESTION_TYPE_MISMATCH',
        lastErrorRetryable: false,
      }),
    });
    const update = prisma.jotformSubmission.update.mock.calls[0]?.[0].data;
    expect(update).not.toHaveProperty('syncStatus');
    expect(update).not.toHaveProperty('leaseToken');
    expect(update).not.toHaveProperty('leaseExpiresAt');
    expect(update).not.toHaveProperty('processingGeneration');
    expect(update).not.toHaveProperty('vendorUpdatedAt');
    expect(update).not.toHaveProperty('respondentEmail');
    expect(update).not.toHaveProperty('contentHash');
  });

  it('resets a terminal row retry budget when a fresh webhook delivery arrives', async () => {
    const prisma = createPrismaMock();
    prisma.jotformSubmission.upsert.mockResolvedValue({
      id: 'queue-1',
      syncStatus: JotformSyncStatus.DEAD_LETTER,
      webhookDeliveryCount: 4,
    });
    prisma.jotformSubmission.update.mockResolvedValue({ id: 'queue-1' });
    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      null,
    );

    const result = await service.acceptWebhook({
      formId: FORM_ID,
      submissionId: SUBMISSION_ID,
      fingerprint: 'f'.repeat(64),
    });

    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(prisma.jotformSubmission.update).toHaveBeenCalledWith({
      where: { id: 'queue-1' },
      data: expect.objectContaining({
        syncStatus: JotformSyncStatus.PENDING,
        attemptCount: 0,
        deadLetteredAt: null,
        lastErrorCode: null,
      }),
    });
  });

  it('requeues a terminal row without starting background work in a CLI runtime', async () => {
    const prisma = createPrismaMock();
    prisma.jotformSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      asApiClient(createApiClientMock()),
    );
    service.disableBackgroundProcessing();
    const kick = jest.spyOn(service, 'kick');

    const result = await service.replay(SUBMISSION_ID);

    expect(result).toEqual({ requeued: 1 });
    expect(kick).not.toHaveBeenCalled();
    expect(prisma.jotformSubmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          formId: FORM_ID,
          submissionId: SUBMISSION_ID,
        }),
        data: expect.objectContaining({
          syncStatus: JotformSyncStatus.PENDING,
          generation: { increment: 1 },
          attemptCount: 0,
        }),
      }),
    );
  });

  it('exposes a bounded PII-free terminal worklist for operators', async () => {
    const prisma = createPrismaMock();
    prisma.jotformSubmission.groupBy.mockResolvedValue([
      { syncStatus: JotformSyncStatus.REJECTED, _count: { _all: 1 } },
    ]);
    prisma.jotformSubmission.findFirst.mockResolvedValue(null);
    prisma.jotformSubmission.findMany.mockResolvedValue([
      {
        submissionId: SUBMISSION_ID,
        syncStatus: JotformSyncStatus.REJECTED,
        attemptCount: 3,
        lastErrorCode: 'INVALID_EMAIL_ANSWER',
        lastErrorAt: new Date('2026-09-06T12:05:00.000Z'),
        deadLetteredAt: new Date('2026-09-06T12:05:00.000Z'),
      },
    ]);

    const result = await new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      null,
    ).getOperationalStatus();

    expect(result.terminalRecords).toHaveLength(1);
    expect(prisma.jotformSubmission.findMany).toHaveBeenCalledWith({
      where: {
        formId: FORM_ID,
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
    });
    expect(JSON.stringify(result)).not.toContain('dealer@example.com');
    expect(JSON.stringify(result)).not.toContain('Example HVAC');
  });

  it.each([
    [
      'quota reserve',
      {
        apiLimitRemaining: 100,
        apiLimitResetAt: new Date(Date.now() + 60_000),
        apiCircuitOpenUntil: null,
        apiCircuitReason: null,
      },
    ],
    [
      'provider circuit',
      {
        apiLimitRemaining: 9_000,
        apiLimitResetAt: new Date(Date.now() + 60_000),
        apiCircuitOpenUntil: new Date(Date.now() + 60_000),
        apiCircuitReason: 'UPSTREAM_SERVER_ERROR',
      },
    ],
  ])(
    'does not claim work while the shared %s pause is active',
    async (_name, state) => {
      const prisma = createPrismaMock();
      const apiClient = createApiClientMock();
      prisma.jotformSyncState.findUnique.mockResolvedValue(state);

      const service = new JotformSyncService(
        prisma as unknown as PrismaService,
        createConfig(),
        asApiClient(apiClient),
      );
      const summary = await service.processDue(1);

      expect(summary).toEqual({
        claimed: 0,
        processed: 0,
        retryScheduled: 0,
        deadLettered: 0,
        rejected: 0,
      });
      expect(prisma.jotformSubmission.findFirst).not.toHaveBeenCalled();
      expect(apiClient.getSubmission).not.toHaveBeenCalled();
    },
  );

  it('defers without making a provider request when another worker owns the shared API lease', async () => {
    const prisma = createPrismaMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.updateMany.mockResolvedValueOnce({ count: 0 });
    const operation = jest.fn();
    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      asApiClient(apiClient),
    );

    await expect(service.executeApiCall(operation)).rejects.toEqual(
      expect.objectContaining<Partial<JotformApiCallDeferredError>>({
        code: 'API_CALL_BUSY',
        reason: 'API_CALL_LEASE_BUSY',
      }),
    );

    expect(operation).not.toHaveBeenCalled();
    expect(prisma.jotformSyncState.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.jotformSyncState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ formId: FORM_ID }),
        data: {
          apiLeaseToken: expect.any(String),
          apiLeaseExpiresAt: expect.any(Date),
        },
      }),
    );
  });

  it('clears an expired quota observation when a successful response omits limit-left', async () => {
    const prisma = createPrismaMock();
    const apiClient = createApiClientMock();
    const expiredAt = new Date(Date.now() - 60_000);
    prisma.jotformSyncState.findUnique.mockResolvedValueOnce({
      apiLimitRemaining: 0,
      apiLimitResetAt: expiredAt,
      apiCircuitOpenUntil: null,
      apiCircuitReason: null,
    });
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValueOnce({
      apiLimitRemaining: 0,
      apiLimitResetAt: expiredAt,
      apiCircuitOpenUntil: null,
    });
    const operation = jest.fn().mockResolvedValue({
      limitLeft: null,
      marker: 'success',
    });
    const service = new JotformSyncService(
      prisma as unknown as PrismaService,
      createConfig(),
      asApiClient(apiClient),
    );

    await expect(service.executeApiCall(operation)).resolves.toEqual({
      response: { limitLeft: null, marker: 'success' },
      quotaReached: false,
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(prisma.jotformSyncState.update).toHaveBeenCalledWith({
      where: { formId: FORM_ID },
      data: {
        apiLimitRemaining: null,
        apiLimitResetAt: null,
        apiCircuitOpenUntil: null,
        apiCircuitReason: null,
      },
    });
  });
});
