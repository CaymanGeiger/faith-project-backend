import { createHash } from 'node:crypto';
import { createJotformRuntime, safeJotformCliError } from './jotform-runtime';

async function main() {
  const runtime = await createJotformRuntime({ backgroundProcessing: false });
  try {
    if (!runtime.config.enabled) {
      console.log(JSON.stringify({ enabled: false, status: 'SKIPPED' }));
      return;
    }

    let before: unknown = null;
    let reconciliation: unknown = null;
    let after: unknown = null;
    const operationFailures: Array<{ phase: string; code: string }> = [];
    before = await runMaintenancePhase(
      'QUEUE_DRAIN_BEFORE_RECONCILIATION',
      () => runtime.sync.processDue(),
      operationFailures,
    );
    reconciliation = await runMaintenancePhase(
      'RECONCILIATION',
      () => runtime.reconciliation.reconcile(),
      operationFailures,
    );
    after = await runMaintenancePhase(
      'QUEUE_DRAIN_AFTER_RECONCILIATION',
      () => runtime.sync.processDue(),
      operationFailures,
    );
    const operational = await runtime.sync.getOperationalStatus();
    const health = summarizeHealth(
      operational,
      runtime.config.apiRateLimitReserve,
      operationFailures,
      reconciliation,
    );
    const ownershipReviews = await runtime.prisma.jotformSubmission.count({ where: { formId: runtime.config.formId, reviewReasonCode: 'PRIVACY_OWNERSHIP_REVIEW' } });
    if (ownershipReviews) { health.unhealthy = true; health.reasons.push('PRIVACY_OWNERSHIP_REVIEW'); }
    const alert = health.unhealthy
      ? await sendDeduplicatedAlert(
          runtime.prisma,
          runtime.config.formId,
          health,
        )
      : { sent: false, reason: 'HEALTHY' };
    console.log(
      JSON.stringify({
        enabled: true,
        status: health.unhealthy ? 'UNHEALTHY' : 'OK',
        queueBeforeReconciliation: before,
        reconciliation,
        queueAfterReconciliation: after,
        health,
        alert,
      }),
    );
    if (health.unhealthy) {
      process.exitCode = 2;
    }
  } finally {
    await runtime.prisma.$disconnect();
  }
}

async function runMaintenancePhase<T>(
  phase: string,
  operation: () => Promise<T>,
  failures: Array<{ phase: string; code: string }>,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error: unknown) {
    failures.push({ phase, code: safeJotformCliError(error) });
    return null;
  }
}

function summarizeHealth(
  operational: Awaited<
    ReturnType<
      import('../src/jotform/jotform-sync.service').JotformSyncService['getOperationalStatus']
    >
  >,
  apiRateLimitReserve: number,
  operationFailures: ReadonlyArray<{ phase: string; code: string }>,
  reconciliationResult: unknown,
) {
  const reconciliation = operational.reconciliation;
  const deadLettered = operational.counts.DEAD_LETTER ?? 0;
  const rejected = operational.counts.REJECTED ?? 0;
  const activeCircuit = Boolean(
    reconciliation?.apiCircuitOpenUntil &&
    reconciliation.apiCircuitOpenUntil > new Date(),
  );
  const quotaPaused = Boolean(
    reconciliation?.apiLimitRemaining !== null &&
    reconciliation?.apiLimitRemaining !== undefined &&
    reconciliation.apiLimitRemaining <= apiRateLimitReserve &&
    reconciliation.apiLimitResetAt &&
    reconciliation.apiLimitResetAt > new Date(),
  );
  const consecutiveFailures = reconciliation?.consecutiveFailures ?? 0;
  const reconciliationRejected = readSafeCount(
    reconciliationResult,
    'rejected',
  );
  const reasons = [
    ...(deadLettered > 0 ? ['DEAD_LETTER_PRESENT'] : []),
    ...(rejected > 0 ? ['REJECTED_PRESENT'] : []),
    ...(activeCircuit ? ['API_CIRCUIT_OPEN'] : []),
    ...(quotaPaused ? ['API_RATE_LIMIT_RESERVE'] : []),
    ...(consecutiveFailures > 0 ? ['RECONCILIATION_FAILURE'] : []),
    ...(reconciliationRejected > 0 ? ['RECONCILIATION_REJECTION'] : []),
    ...(operationFailures.length > 0 ? ['MAINTENANCE_OPERATION_FAILED'] : []),
  ];
  return {
    unhealthy: reasons.length > 0,
    reasons,
    deadLettered,
    rejected,
    reconciliationRejected,
    consecutiveFailures,
    circuitReason: activeCircuit
      ? (reconciliation?.apiCircuitReason ?? 'API_CIRCUIT_OPEN')
      : null,
    operationFailures,
  };
}

function readSafeCount(value: unknown, property: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 0;
  }
  const count = (value as Record<string, unknown>)[property];
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    ? count
    : 0;
}

async function sendDeduplicatedAlert(
  prisma: import('../src/prisma/prisma.service').PrismaService,
  formId: string,
  health: ReturnType<typeof summarizeHealth>,
) {
  const alertHash = createHash('sha256')
    .update(JSON.stringify(health), 'utf8')
    .digest('hex');
  const lockId = createHash('sha256')
    .update('jotform-operational-alert:v1\0', 'utf8')
    .update(formId, 'utf8')
    .digest()
    .readBigInt64BE(0);

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockId})::text`;
      await tx.jotformSyncState.upsert({
        where: { formId },
        create: { formId },
        update: {},
      });
      const state = await tx.jotformSyncState.findUniqueOrThrow({
        where: { formId },
        select: {
          lastOperationalAlertAt: true,
          lastOperationalAlertHash: true,
        },
      });
      const dedupeWindowMs = 60 * 60_000;
      if (
        state.lastOperationalAlertHash === alertHash &&
        state.lastOperationalAlertAt &&
        Date.now() - state.lastOperationalAlertAt.getTime() < dedupeWindowMs
      ) {
        return { sent: false, reason: 'DEDUPLICATED' };
      }

      const delivered = await deliverOperationsAlert({
        event: 'jotform_integration_unhealthy',
        eventId: alertHash,
        health,
        observedAt: new Date().toISOString(),
      });
      if (!delivered) {
        return { sent: false, reason: 'OPERATIONS_WEBHOOK_NOT_CONFIGURED' };
      }
      await tx.jotformSyncState.update({
        where: { formId },
        data: {
          lastOperationalAlertAt: new Date(),
          lastOperationalAlertHash: alertHash,
        },
      });
      return { sent: true, reason: null };
    },
    { maxWait: 10_000, timeout: 15_000 },
  );
}

async function deliverOperationsAlert(payload: Record<string, unknown>) {
  const rawUrl = process.env.OPERATIONS_WEBHOOK_URL?.trim();
  if (!rawUrl) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('OPERATIONS_WEBHOOK_URL_INVALID');
  }
  if (url.protocol !== 'https:') {
    throw new Error('OPERATIONS_WEBHOOK_URL_INVALID');
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    throw new Error('OPERATIONS_WEBHOOK_DELIVERY_FAILED');
  }
  return true;
}

async function reportFailure(error: unknown) {
  const code = safeJotformCliError(error);
  const health = {
    unhealthy: true,
    reasons: ['MAINTENANCE_FATAL_ERROR'],
    operationFailures: [{ phase: 'MAINTENANCE', code }],
  };
  const eventId = createHash('sha256')
    .update(JSON.stringify(health), 'utf8')
    .digest('hex');
  try {
    await deliverOperationsAlert({
      event: 'jotform_integration_unhealthy',
      eventId,
      health,
      observedAt: new Date().toISOString(),
    });
  } catch {
    // The scheduler's nonzero exit and safe stderr record remain fallbacks.
  }
  console.error(JSON.stringify({ status: 'FAILED', code }));
  process.exitCode = 1;
}

async function run() {
  const watch = process.argv.includes('--watch');
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => { stopping = true; wake?.(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  do {
    process.exitCode = 0;
    await main().catch(reportFailure);
    if (!watch || stopping) break;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 10 * 60_000);
      wake = () => { clearTimeout(timer); resolve(); };
    });
    wake = undefined;
  } while (!stopping);
}
void run();
