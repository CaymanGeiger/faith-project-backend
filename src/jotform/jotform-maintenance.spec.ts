/* eslint-disable @typescript-eslint/no-unsafe-assignment */

describe('Jotform maintenance command', () => {
  const originalExitCode = process.exitCode;
  const originalOperationsWebhookUrl = process.env.OPERATIONS_WEBHOOK_URL;

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    process.exitCode = originalExitCode;
    if (originalOperationsWebhookUrl === undefined) {
      delete process.env.OPERATIONS_WEBHOOK_URL;
    } else {
      process.env.OPERATIONS_WEBHOOK_URL = originalOperationsWebhookUrl;
    }
  });

  it('runs reconciliation and the final drain when the initial drain throws', async () => {
    delete process.env.OPERATIONS_WEBHOOK_URL;
    const processDue = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error(), { code: 'DRAIN_FAILED' }),
      )
      .mockResolvedValueOnce({ claimed: 0, processed: 0 });
    const reconcile = jest.fn().mockResolvedValue({ complete: true });
    const getOperationalStatus = jest.fn().mockResolvedValue({
      counts: {},
      reconciliation: null,
      oldestPendingAt: null,
    });
    const transactionClient = {
      $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: '' }]),
      jotformSyncState: {
        upsert: jest.fn().mockResolvedValue({ formId: '252405795315055' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          lastOperationalAlertAt: null,
          lastOperationalAlertHash: null,
        }),
        update: jest.fn(),
      },
    };
    const prisma = {
      jotformSubmission: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn(
        (operation: (tx: typeof transactionClient) => Promise<unknown>) =>
          operation(transactionClient),
      ),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    };
    jest.doMock('../../scripts/jotform-runtime', () => ({
      createJotformRuntime: jest.fn().mockResolvedValue({
        config: {
          enabled: true,
          formId: '252405795315055',
          apiRateLimitReserve: 100,
        },
        prisma,
        sync: { processDue, getOperationalStatus },
        reconciliation: { reconcile },
      }),
      safeJotformCliError: (error: { code?: string }) =>
        error.code ?? 'JOTFORM_OPERATION_FAILED',
    }));
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    jest.requireActual('../../scripts/jotform-maintenance');
    await waitForConsoleCall(log);

    expect(processDue).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(getOperationalStatus).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(transactionClient.$queryRaw).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);

    const output = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      enabled: true,
      status: 'UNHEALTHY',
      queueBeforeReconciliation: null,
      reconciliation: { complete: true },
      queueAfterReconciliation: { claimed: 0, processed: 0 },
      health: {
        unhealthy: true,
        reasons: ['MAINTENANCE_OPERATION_FAILED'],
        operationFailures: [
          {
            phase: 'QUEUE_DRAIN_BEFORE_RECONCILIATION',
            code: 'DRAIN_FAILED',
          },
        ],
      },
      alert: {
        sent: false,
        reason: 'OPERATIONS_WEBHOOK_NOT_CONFIGURED',
      },
    });
  });
});

async function waitForConsoleCall(spy: jest.SpyInstance) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (spy.mock.calls.length > 0) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Jotform maintenance command did not finish');
}
