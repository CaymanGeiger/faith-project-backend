const MAX_SAFE_DELAY_MS = 24 * 60 * 60 * 1_000;

/** Full-jitter exponential backoff, bounded and with Retry-After as a floor. */
export function calculateJotformRetryDelayMs(options: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMs?: number | null;
  random?: () => number;
}) {
  const { attempt, baseDelayMs, maxDelayMs } = options;
  const random = options.random ?? Math.random;
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isSafeInteger(baseDelayMs) ||
    baseDelayMs < 1 ||
    !Number.isSafeInteger(maxDelayMs) ||
    maxDelayMs < baseDelayMs ||
    maxDelayMs > MAX_SAFE_DELAY_MS
  ) {
    throw new Error('Invalid Jotform retry configuration');
  }

  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.min(attempt - 1, 30),
  );
  const jitter = Math.max(
    1_000,
    Math.floor(exponential * boundedRandom(random)),
  );
  const retryAfter = Math.min(
    MAX_SAFE_DELAY_MS,
    Math.max(0, options.retryAfterMs ?? 0),
  );
  return Math.max(jitter, retryAfter);
}

function boundedRandom(random: () => number) {
  const value = random();
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}
