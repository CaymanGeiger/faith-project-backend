const localRuntimeNames = new Set(['development', 'test']);

/**
 * An omitted or unfamiliar NODE_ENV must never silently enable development
 * security defaults on a deployed service.
 */
export function isProductionLikeRuntime(env: NodeJS.ProcessEnv = process.env) {
  return !localRuntimeNames.has((env.NODE_ENV ?? '').toLowerCase());
}
