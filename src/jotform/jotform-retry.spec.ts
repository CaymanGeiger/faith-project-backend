import { calculateJotformRetryDelayMs } from './jotform-retry';

describe('calculateJotformRetryDelayMs', () => {
  it('uses bounded exponential full jitter', () => {
    expect(
      calculateJotformRetryDelayMs({
        attempt: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        random: () => 0.5,
      }),
    ).toBe(2_000);
  });

  it('honors Retry-After even when it exceeds the exponential-backoff cap', () => {
    expect(
      calculateJotformRetryDelayMs({
        attempt: 1,
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        retryAfterMs: 45_000,
        random: () => 0,
      }),
    ).toBe(45_000);
    expect(
      calculateJotformRetryDelayMs({
        attempt: 1,
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        retryAfterMs: 120_000,
        random: () => 0,
      }),
    ).toBe(120_000);
  });
});
