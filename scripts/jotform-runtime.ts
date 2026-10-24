import { PrismaService } from '../src/prisma/prisma.service';
import { JotformApiClient } from '../src/jotform/jotform-api.client';
import { loadJotformConfig } from '../src/jotform/jotform.config';
import { JotformReconciliationService } from '../src/jotform/jotform-reconciliation.service';
import { JotformSyncService } from '../src/jotform/jotform-sync.service';

export async function createJotformRuntime(options?: {
  backgroundProcessing?: boolean;
}) {
  const config = loadJotformConfig();
  const prisma = new PrismaService();
  let connected = false;
  try {
    await prisma.$connect();
    connected = true;
    const apiClient =
      config.enabled && config.apiKey
        ? new JotformApiClient({
            apiKey: config.apiKey,
            baseUrl: config.apiBaseUrl,
            timeoutMs: config.requestTimeoutMs,
          })
        : null;
    const sync = new JotformSyncService(prisma, config, apiClient);
    if (options?.backgroundProcessing === false) {
      sync.disableBackgroundProcessing();
    }
    const reconciliation = new JotformReconciliationService(
      prisma,
      sync,
      config,
      apiClient,
    );
    return { config, prisma, sync, reconciliation };
  } catch (error: unknown) {
    if (connected) {
      await prisma.$disconnect().catch(() => undefined);
    }
    throw error;
  }
}

export function safeJotformCliError(error: unknown) {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
  ) {
    return error.code;
  }
  if (error instanceof Error && error.name === 'JotformConfigurationError') {
    return 'INVALID_CONFIGURATION';
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)) {
    return error.message;
  }
  return 'JOTFORM_OPERATION_FAILED';
}
