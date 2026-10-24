/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { PrismaService } from '../prisma/prisma.service';
import { JotformApiClient } from './jotform-api.client';
import { JotformConfig } from './jotform.config';
import { JotformReconciliationService } from './jotform-reconciliation.service';
import {
  JotformApiCallDeferredError,
  JotformSyncService,
} from './jotform-sync.service';
import { JotformCanonicalSubmissionError } from './jotform-submission.mapper';

const FORM_ID = '252405795315055';

type ModelMock = Record<string, jest.Mock>;

type PrismaMock = {
  jotformSyncState: ModelMock;
};

type SyncMock = {
  executeApiCall: jest.Mock;
  recordReconciledSubmission: jest.Mock;
  recordRejectedReconciliationSubmission: jest.Mock;
};

type ApiClientMock = {
  getFormSubmissions: jest.Mock;
};

function createPrismaMock(): PrismaMock {
  return {
    jotformSyncState: {
      upsert: jest.fn().mockResolvedValue({ formId: FORM_ID }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
    },
  };
}

function createConfig(
  override: Partial<JotformConfig> = {},
): Readonly<JotformConfig> {
  return {
    enabled: true,
    apiBaseUrl: 'https://api.jotform.com',
    requestTimeoutMs: 10_000,
    processingBatchSize: 25,
    reconciliationPageSize: 2,
    reconciliationMaxPages: 5,
    apiRateLimitReserve: 100,
    maxProcessingAttempts: 8,
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

function createSyncMock(): SyncMock {
  return {
    executeApiCall: jest.fn(async (operation: () => Promise<unknown>) => ({
      response: await operation(),
      quotaReached: false,
    })),
    recordReconciledSubmission: jest.fn(),
    recordRejectedReconciliationSubmission: jest.fn(),
  };
}

function createApiClientMock(): ApiClientMock {
  return {
    getFormSubmissions: jest.fn(),
  };
}

function syncState(override: Record<string, unknown> = {}) {
  return {
    formId: FORM_ID,
    watermark: '2026-09-05 12:00:00',
    reconciliationFrom: null,
    reconciliationOffset: 0,
    reconciliationHighWatermark: null,
    reconciliationAfterId: null,
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    consecutiveFailures: 0,
    leaseToken: 'active-lease',
    leaseExpiresAt: new Date(Date.now() + 120_000),
    lastErrorCode: null,
    apiLimitRemaining: 9_000,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...override,
  };
}

function createService(
  prisma: PrismaMock,
  sync: SyncMock,
  apiClient: ApiClientMock,
  config: Readonly<JotformConfig> = createConfig(),
) {
  return new JotformReconciliationService(
    prisma as unknown as PrismaService,
    sync as unknown as JotformSyncService,
    config,
    apiClient as unknown as JotformApiClient,
  );
}

describe('JotformReconciliationService', () => {
  it('skips API work when another worker owns the reconciliation lease', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await createService(prisma, sync, apiClient).reconcile();

    expect(result).toMatchObject({
      disabled: false,
      skippedForLease: true,
      pages: 0,
      submissions: 0,
      rejected: 0,
    });
    expect(sync.executeApiCall).not.toHaveBeenCalled();
    expect(apiClient.getFormSubmissions).not.toHaveBeenCalled();
    expect(sync.recordReconciledSubmission).not.toHaveBeenCalled();
  });

  it('resumes the durable cursor and checkpoints before pausing at the API reserve', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(
      syncState({
        reconciliationFrom: '2026-09-04 12:00:00',
        reconciliationOffset: 40,
        reconciliationHighWatermark: '2026-09-06 10:00:00',
        reconciliationAfterId: '9043',
      }),
    );
    apiClient.getFormSubmissions.mockResolvedValue({
      responseCode: 200,
      limitLeft: 100,
      content: [{ id: '9042' }, { id: '9041' }],
    });
    sync.executeApiCall.mockImplementationOnce(
      async (operation: () => Promise<unknown>) => ({
        response: await operation(),
        quotaReached: true,
      }),
    );
    sync.recordReconciledSubmission
      .mockResolvedValueOnce({
        recorded: true,
        vendorUpdatedAt: '2026-09-06 09:59:00',
      })
      .mockResolvedValueOnce({
        recorded: true,
        vendorUpdatedAt: '2026-09-06 09:58:00',
      });

    const result = await createService(prisma, sync, apiClient).reconcile();

    expect(apiClient.getFormSubmissions).toHaveBeenCalledWith(FORM_ID, {
      offset: 0,
      limit: 2,
      orderby: 'id',
      filter: {
        'updated_at:gt': '2026-09-04 12:00:00',
        'updated_at:lt': '2026-09-06 10:00:01',
        'id:lt': '9043',
      },
    });
    expect(result).toEqual({
      disabled: false,
      skippedForLease: false,
      complete: false,
      pausedForRateLimit: true,
      pausedForProvider: false,
      pages: 1,
      submissions: 2,
      rejected: 0,
      nextOffset: 42,
      watermark: '2026-09-06 10:00:00',
      apiLimitRemaining: 100,
    });

    const checkpoint = prisma.jotformSyncState.updateMany.mock.calls[1]?.[0];
    expect(checkpoint).toEqual({
      where: { formId: FORM_ID, leaseToken: expect.any(String) },
      data: expect.objectContaining({
        reconciliationFrom: '2026-09-04 12:00:00',
        reconciliationOffset: 42,
        reconciliationHighWatermark: '2026-09-06 10:00:00',
        reconciliationAfterId: '9041',
      }),
    });
    expect(checkpoint.data).not.toHaveProperty('apiLimitRemaining');

    const release = prisma.jotformSyncState.updateMany.mock.calls[2]?.[0];
    expect(release).toEqual({
      where: { formId: FORM_ID, leaseToken: expect.any(String) },
      data: {
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: 'API_RATE_LIMIT_RESERVE',
      },
    });
  });

  it('starts the first scan from the explicit baseline and completes a short final page', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(
      syncState({ watermark: null }),
    );
    apiClient.getFormSubmissions
      .mockResolvedValueOnce({
        responseCode: 200,
        limitLeft: 8_801,
        content: [{ id: '9002', updated_at: '2026-09-06 15:30:00' }],
      })
      .mockResolvedValueOnce({
        responseCode: 200,
        limitLeft: 8_800,
        content: [{ id: '9001', updated_at: '2026-09-06 15:29:00' }],
      });
    sync.recordReconciledSubmission.mockResolvedValue({
      recorded: true,
      vendorUpdatedAt: '2026-09-06 15:30:00',
    });

    const result = await createService(prisma, sync, apiClient).reconcile();

    expect(apiClient.getFormSubmissions).toHaveBeenNthCalledWith(1, FORM_ID, {
      offset: 0,
      limit: 2,
      orderby: 'updated_at',
      filter: { 'updated_at:gt': '2026-01-01 00:00:00' },
    });
    expect(apiClient.getFormSubmissions).toHaveBeenNthCalledWith(2, FORM_ID, {
      offset: 0,
      limit: 2,
      orderby: 'id',
      filter: {
        'updated_at:gt': '2026-01-01 00:00:00',
        'updated_at:lt': '2026-09-06 15:30:01',
      },
    });
    expect(result).toMatchObject({
      complete: true,
      pages: 2,
      submissions: 1,
      rejected: 0,
      nextOffset: 0,
      watermark: '2026-09-06 15:30:00',
    });
    expect(prisma.jotformSyncState.updateMany).toHaveBeenLastCalledWith({
      where: { formId: FORM_ID, leaseToken: expect.any(String) },
      data: expect.objectContaining({
        watermark: '2026-09-06 15:30:00',
        reconciliationFrom: null,
        reconciliationOffset: 0,
        reconciliationHighWatermark: null,
        reconciliationAfterId: null,
        consecutiveFailures: 0,
        lastErrorCode: null,
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    });
    const finish = prisma.jotformSyncState.updateMany.mock.calls[3]?.[0];
    expect(finish.data).not.toHaveProperty('apiLimitRemaining');
  });

  it('isolates a malformed submission, records the rejection, and advances through the page', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(syncState());
    const malformed = {
      id: '1002',
      form_id: FORM_ID,
      updated_at: '2026-09-06 10:01:00',
    };
    const valid = {
      id: '1001',
      form_id: FORM_ID,
      updated_at: '2026-09-06 10:02:00',
    };
    apiClient.getFormSubmissions
      .mockResolvedValueOnce({
        responseCode: 200,
        limitLeft: 8_701,
        content: [{ id: '1001', updated_at: '2026-09-06 10:02:00' }],
      })
      .mockResolvedValueOnce({
        responseCode: 200,
        limitLeft: 8_700,
        content: [malformed, valid],
      });
    sync.recordReconciledSubmission
      .mockRejectedValueOnce(
        new JotformCanonicalSubmissionError('EMAIL_QUESTION_TYPE_MISMATCH'),
      )
      .mockResolvedValueOnce({
        recorded: true,
        vendorUpdatedAt: '2026-09-06 10:02:00',
      });
    sync.recordRejectedReconciliationSubmission.mockResolvedValue({
      recorded: true,
    });

    const result = await createService(
      prisma,
      sync,
      apiClient,
      createConfig({ reconciliationPageSize: 3 }),
    ).reconcile();

    expect(result).toMatchObject({
      complete: true,
      pages: 2,
      submissions: 1,
      rejected: 1,
      nextOffset: 0,
      watermark: '2026-09-06 10:02:00',
    });
    expect(sync.recordRejectedReconciliationSubmission).toHaveBeenCalledWith(
      malformed,
      'EMAIL_QUESTION_TYPE_MISMATCH',
    );
    expect(sync.recordReconciledSubmission).toHaveBeenNthCalledWith(2, valid);
  });

  it('does not advance the cursor when a malformed row cannot be durably keyed to this form', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(
      syncState({
        reconciliationFrom: '2026-09-04 12:00:00',
        reconciliationHighWatermark: '2026-09-06 10:00:00',
      }),
    );
    const wrongFormSubmission = {
      id: '1001',
      form_id: '999999999999999',
      updated_at: '2026-09-06 09:58:00',
    };
    apiClient.getFormSubmissions.mockResolvedValue({
      responseCode: 200,
      limitLeft: 8_650,
      content: [wrongFormSubmission],
    });
    sync.recordReconciledSubmission.mockRejectedValue(
      new JotformCanonicalSubmissionError('FORM_ID_MISMATCH'),
    );
    sync.recordRejectedReconciliationSubmission.mockResolvedValue({
      recorded: false,
    });

    await expect(
      createService(prisma, sync, apiClient).reconcile(),
    ).rejects.toMatchObject({
      code: 'RECONCILIATION_UNKEYED_SUBMISSION',
    });
    expect(sync.recordRejectedReconciliationSubmission).toHaveBeenCalledWith(
      wrongFormSubmission,
      'FORM_ID_MISMATCH',
    );
    expect(prisma.jotformSyncState.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.jotformSyncState.updateMany).toHaveBeenLastCalledWith({
      where: { formId: FORM_ID, leaseToken: expect.any(String) },
      data: expect.objectContaining({
        lastErrorCode: 'RECONCILIATION_UNKEYED_SUBMISSION',
      }),
    });
  });

  it('does not advance the cursor when a returned row has no submission ID', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(
      syncState({
        reconciliationFrom: '2026-09-04 12:00:00',
        reconciliationHighWatermark: '2026-09-06 10:00:00',
      }),
    );
    apiClient.getFormSubmissions.mockResolvedValue({
      responseCode: 200,
      limitLeft: 8_625,
      content: [{ form_id: FORM_ID, updated_at: '2026-09-06 09:58:00' }],
    });

    await expect(
      createService(prisma, sync, apiClient).reconcile(),
    ).rejects.toMatchObject({
      code: 'RECONCILIATION_INVALID_SUBMISSION_ID',
    });
    expect(sync.recordReconciledSubmission).not.toHaveBeenCalled();
    expect(sync.recordRejectedReconciliationSubmission).not.toHaveBeenCalled();
    expect(prisma.jotformSyncState.updateMany).toHaveBeenCalledTimes(2);
  });

  it('continues below the durable ID cursor when an earlier row leaves the fixed window between runs', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(
      syncState({
        reconciliationFrom: '2026-09-04 12:00:00',
        reconciliationOffset: 2,
        reconciliationHighWatermark: '2026-09-06 10:00:00',
        reconciliationAfterId: '800',
      }),
    );
    const unseenSubmission = {
      id: '700',
      form_id: FORM_ID,
      updated_at: '2026-09-06 09:57:00',
    };
    apiClient.getFormSubmissions.mockResolvedValue({
      responseCode: 200,
      limitLeft: 8_600,
      content: [unseenSubmission],
    });
    sync.recordReconciledSubmission.mockResolvedValue({
      recorded: true,
      vendorUpdatedAt: '2026-09-06 09:57:00',
    });

    const result = await createService(prisma, sync, apiClient).reconcile();

    expect(apiClient.getFormSubmissions).toHaveBeenCalledWith(FORM_ID, {
      offset: 0,
      limit: 2,
      orderby: 'id',
      filter: {
        'updated_at:gt': '2026-09-04 12:00:00',
        'updated_at:lt': '2026-09-06 10:00:01',
        'id:lt': '800',
      },
    });
    expect(sync.recordReconciledSubmission).toHaveBeenCalledWith(
      unseenSubmission,
    );
    expect(result).toMatchObject({
      complete: true,
      pages: 1,
      submissions: 1,
      watermark: '2026-09-06 10:00:00',
    });
  });

  it('persists the provider-clock frontier before stopping a one-page partial run', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(syncState());
    apiClient.getFormSubmissions.mockResolvedValue({
      responseCode: 200,
      limitLeft: 8_500,
      content: [
        { id: '9002', updated_at: '2026-09-06 10:02:00' },
        { id: '9001', updated_at: '2026-09-06 10:01:00' },
      ],
    });

    const result = await createService(
      prisma,
      sync,
      apiClient,
      createConfig({ reconciliationMaxPages: 1 }),
    ).reconcile();

    expect(result).toMatchObject({
      complete: false,
      pages: 1,
      submissions: 0,
      nextOffset: 0,
      watermark: '2026-09-06 10:02:00',
    });
    expect(sync.recordReconciledSubmission).not.toHaveBeenCalled();
    const checkpoint = prisma.jotformSyncState.updateMany.mock.calls[1]?.[0];
    expect(checkpoint.data).toEqual(
      expect.objectContaining({
        reconciliationFrom: '2026-09-04 12:00:00',
        reconciliationOffset: 0,
        reconciliationHighWatermark: '2026-09-06 10:02:00',
        reconciliationAfterId: null,
      }),
    );
  });

  it('fails closed before checkpointing when Jotform does not return IDs in descending order', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(
      syncState({
        reconciliationFrom: '2026-09-04 12:00:00',
        reconciliationHighWatermark: '2026-09-06 10:00:00',
      }),
    );
    apiClient.getFormSubmissions.mockResolvedValue({
      responseCode: 200,
      limitLeft: 8_400,
      content: [
        { id: '700', updated_at: '2026-09-06 09:57:00' },
        { id: '800', updated_at: '2026-09-06 09:58:00' },
      ],
    });

    await expect(
      createService(prisma, sync, apiClient).reconcile(),
    ).rejects.toMatchObject({
      code: 'RECONCILIATION_UNSTABLE_ID_ORDER',
    });
    expect(sync.recordReconciledSubmission).not.toHaveBeenCalled();
    expect(prisma.jotformSyncState.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.jotformSyncState.updateMany).toHaveBeenLastCalledWith({
      where: { formId: FORM_ID, leaseToken: expect.any(String) },
      data: expect.objectContaining({
        lastErrorCode: 'RECONCILIATION_UNSTABLE_ID_ORDER',
      }),
    });
  });

  it('fails closed when Jotform ignores the durable id:lt cursor', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(
      syncState({
        reconciliationFrom: '2026-09-04 12:00:00',
        reconciliationHighWatermark: '2026-09-06 10:00:00',
        reconciliationAfterId: '800',
      }),
    );
    apiClient.getFormSubmissions.mockResolvedValue({
      responseCode: 200,
      limitLeft: 8_350,
      content: [{ id: '900', updated_at: '2026-09-06 09:58:00' }],
    });

    await expect(
      createService(prisma, sync, apiClient).reconcile(),
    ).rejects.toMatchObject({
      code: 'RECONCILIATION_CURSOR_NOT_ADVANCED',
    });
    expect(sync.recordReconciledSubmission).not.toHaveBeenCalled();
    expect(prisma.jotformSyncState.updateMany).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Jotform returns the strict lower window boundary', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(
      syncState({
        reconciliationFrom: '2026-09-04 12:00:00',
        reconciliationHighWatermark: '2026-09-06 10:00:00',
      }),
    );
    apiClient.getFormSubmissions.mockResolvedValue({
      responseCode: 200,
      limitLeft: 8_325,
      content: [{ id: '700', updated_at: '2026-09-04 12:00:00' }],
    });

    await expect(
      createService(prisma, sync, apiClient).reconcile(),
    ).rejects.toMatchObject({
      code: 'RECONCILIATION_RESULT_OUTSIDE_WINDOW',
    });
    expect(sync.recordReconciledSubmission).not.toHaveBeenCalled();
    expect(prisma.jotformSyncState.updateMany).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the updated-at frontier probe is not descending', async () => {
    const prisma = createPrismaMock();
    const sync = createSyncMock();
    const apiClient = createApiClientMock();
    prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(syncState());
    apiClient.getFormSubmissions.mockResolvedValue({
      responseCode: 200,
      limitLeft: 8_300,
      content: [
        { id: '700', updated_at: '2026-09-06 09:57:00' },
        { id: '800', updated_at: '2026-09-06 09:58:00' },
      ],
    });

    await expect(
      createService(prisma, sync, apiClient).reconcile(),
    ).rejects.toMatchObject({
      code: 'RECONCILIATION_UNSTABLE_UPDATED_AT_ORDER',
    });
    expect(sync.recordReconciledSubmission).not.toHaveBeenCalled();
    expect(prisma.jotformSyncState.updateMany).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['API_RATE_LIMIT_RESERVE', true, false],
    ['UPSTREAM_SERVER_ERROR', false, true],
  ])(
    'releases its lease without calling Jotform when shared API access is deferred for %s',
    async (reason, pausedForRateLimit, pausedForProvider) => {
      const prisma = createPrismaMock();
      const sync = createSyncMock();
      const apiClient = createApiClientMock();
      prisma.jotformSyncState.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.jotformSyncState.findUniqueOrThrow.mockResolvedValue(syncState());
      sync.executeApiCall.mockRejectedValue(
        new JotformApiCallDeferredError('API_CALL_PAUSED', reason),
      );

      const result = await createService(prisma, sync, apiClient).reconcile();

      expect(result).toMatchObject({
        complete: false,
        pausedForRateLimit,
        pausedForProvider,
        pages: 0,
        submissions: 0,
        rejected: 0,
        nextOffset: 0,
      });
      expect(apiClient.getFormSubmissions).not.toHaveBeenCalled();
      expect(prisma.jotformSyncState.updateMany).toHaveBeenLastCalledWith({
        where: { formId: FORM_ID, leaseToken: expect.any(String) },
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: reason,
        },
      });
    },
  );
});
