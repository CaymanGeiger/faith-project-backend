import { isProductionLikeRuntime } from './runtime';

export function loadHttpRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  const isProduction = isProductionLikeRuntime(env);
  const requireOperations = isProduction && env.APP_ENV !== 'preview';
  const corsOrigins = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const blockedMessageTerms = (env.MESSAGE_BLOCKED_TERMS ?? '')
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);
  if (isProduction && corsOrigins.length === 0)
    throw new Error('CORS_ORIGIN must be configured in production');
  if (
    isProduction &&
    corsOrigins.some((origin) => !origin.startsWith('https://'))
  )
    throw new Error('CORS_ORIGIN entries must use HTTPS in production');
  if (requireOperations && blockedMessageTerms.length === 0)
    throw new Error('MESSAGE_BLOCKED_TERMS must be configured in production');
  const operationsWebhookUrl = env.OPERATIONS_WEBHOOK_URL?.trim();
  if (requireOperations && !operationsWebhookUrl)
    throw new Error('OPERATIONS_WEBHOOK_URL must be configured in production');
  if (isProduction && operationsWebhookUrl) {
    try {
      if (new URL(operationsWebhookUrl).protocol !== 'https:')
        throw new Error();
    } catch {
      throw new Error(
        'OPERATIONS_WEBHOOK_URL must be a valid HTTPS URL in production',
      );
    }
  }
  return { corsOrigins };
}
