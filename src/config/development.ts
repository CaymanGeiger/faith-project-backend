import { isProductionLikeRuntime } from './runtime';

export function areDevelopmentFeaturesEnabled() {
  if (process.env.DEV_FEATURES_ENABLED !== 'true') return false;
  // APP_ENV describes the deployment. NODE_ENV stays production on hosted
  // previews so JWT, CORS and other production security checks still apply.
  if (process.env.APP_ENV === 'preview') return true;
  if (process.env.APP_ENV !== undefined)
    return process.env.APP_ENV === 'development' && !isProductionLikeRuntime();
  // Preserve explicitly local/test workflows without enabling an unlabelled
  // hosted deployment, where NODE_ENV is production or omitted.
  return !isProductionLikeRuntime();
}

export function isDevelopmentAccount(email: string | undefined) {
  return /@(?:[^@]+\.)?hercules\.local$/i.test(email?.trim() ?? '');
}

export function isAccountAllowedInRuntime(email: string | undefined) {
  return !isDevelopmentAccount(email) || areDevelopmentFeaturesEnabled();
}

export function isLocalDevelopmentDatabase(
  databaseUrl: string | undefined,
  additionalDatabaseNames: readonly string[] = [],
) {
  if (!databaseUrl) return false;
  try {
    const url = new URL(databaseUrl);
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      (/_(dev|test)$/.test(url.pathname) ||
        additionalDatabaseNames.includes(url.pathname.slice(1))) &&
      !url.searchParams.has('host')
    );
  } catch {
    return false;
  }
}

export function isDevelopmentSeedEnabled() {
  return (
    areDevelopmentFeaturesEnabled() &&
    process.env.ALLOW_DEMO_SEED === 'true' &&
    // Preserve the documented local setup without allowing a remote database.
    isLocalDevelopmentDatabase(process.env.DATABASE_URL, ['faith_project'])
  );
}

export function isDevelopmentSwaggerEnabled() {
  return (
    areDevelopmentFeaturesEnabled() && process.env.ENABLE_SWAGGER === 'true'
  );
}
