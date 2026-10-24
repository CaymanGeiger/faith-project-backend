import {
  addVendorSeconds,
  isVendorTimestampAtLeast,
  laterVendorTimestamp,
  subtractVendorMinutes,
} from './jotform-vendor-time';

describe('Jotform vendor timestamp helpers', () => {
  it('builds an overlap without assigning a real-world timezone', () => {
    expect(subtractVendorMinutes('2026-01-01 00:05:00', 10)).toBe(
      '2025-12-31 23:55:00',
    );
  });

  it('builds an exclusive fixed-window boundary across calendar edges', () => {
    expect(addVendorSeconds('2026-12-31 23:59:59', 1)).toBe(
      '2027-01-01 00:00:00',
    );
  });

  it('compares the fixed-width vendor values deterministically', () => {
    expect(
      laterVendorTimestamp('2026-09-06 12:00:00', '2026-09-06 12:01:00'),
    ).toBe('2026-09-06 12:01:00');
    expect(
      isVendorTimestampAtLeast('2026-09-06 12:00:00', '2026-09-06 12:00:00'),
    ).toBe(true);
  });

  it('rejects impossible calendar values', () => {
    expect(() => subtractVendorMinutes('2026-02-30 12:00:00', 10)).toThrow(
      'Invalid Jotform vendor timestamp',
    );
  });
});
