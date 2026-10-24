import {
  AFTER_HOURS_NOTICE,
  AvailabilitySettings,
  evaluateAvailability,
} from './availability-policy';

describe('Manager availability policy', () => {
  const settings: AvailabilitySettings = {
    timezone: 'America/Denver',
    hours: [{ day: 1, start: '09:00', end: '17:00' }],
    mode: 'SCHEDULE',
    overrideUntil: null,
    silenceWhenUnavailable: false,
    outOfOfficeMessage: null,
  };
  const availableAt = (
    time: string,
    override: Partial<AvailabilitySettings> = {},
  ) => evaluateAvailability({ ...settings, ...override }, new Date(time));

  it('includes opening and excludes closing in the chosen time zone', () => {
    expect(availableAt('2026-10-19T14:59:59Z').available).toBe(false);
    expect(availableAt('2026-10-19T15:00:00Z').available).toBe(true);
    expect(availableAt('2026-10-19T22:59:59Z').available).toBe(true);
    expect(availableAt('2026-10-19T23:00:00Z').available).toBe(false);
    expect(availableAt('2026-10-20T15:00:00Z').available).toBe(false);
  });

  it('uses winter timezone offsets without changing the saved wall-clock hours', () => {
    expect(availableAt('2026-11-02T15:59:59Z').available).toBe(false);
    expect(availableAt('2026-11-02T16:00:00Z').available).toBe(true);
  });

  it('handles overnight hours across the week boundary', () => {
    const hours = [{ day: 6, start: '22:00', end: '02:00' }];
    expect(availableAt('2026-10-25T03:59:59Z', { hours }).available).toBe(
      false,
    );
    expect(availableAt('2026-10-25T04:00:00Z', { hours }).available).toBe(true);
    expect(availableAt('2026-10-25T07:59:59Z', { hours }).available).toBe(true);
    expect(availableAt('2026-10-25T08:00:00Z', { hours }).available).toBe(
      false,
    );
  });

  it('follows the repeated fall DST hour and skipped spring hour', () => {
    const hours = [{ day: 0, start: '01:00', end: '03:00' }];
    expect(availableAt('2026-11-01T07:30:00Z', { hours }).available).toBe(true);
    expect(availableAt('2026-11-01T08:30:00Z', { hours }).available).toBe(true);
    expect(availableAt('2026-11-01T10:00:00Z', { hours }).available).toBe(
      false,
    );
    expect(availableAt('2026-03-08T08:59:59Z', { hours }).available).toBe(true);
    expect(availableAt('2026-03-08T09:00:00Z', { hours }).available).toBe(
      false,
    );
  });

  it('allows manual on and off until changed or the exact expiration', () => {
    expect(
      availableAt('2026-10-19T23:00:00Z', { mode: 'AVAILABLE' }).available,
    ).toBe(true);
    expect(
      availableAt('2026-10-19T15:00:00Z', { mode: 'AWAY' }).available,
    ).toBe(false);
    const override = {
      mode: 'AWAY' as const,
      overrideUntil: new Date('2026-10-19T16:00:00Z'),
    };
    expect(availableAt('2026-10-19T15:59:59Z', override).available).toBe(false);
    expect(availableAt('2026-10-19T16:00:00Z', override).available).toBe(true);
    expect(availableAt('2026-10-19T16:00:00Z', override).effectiveMode).toBe(
      'SCHEDULE',
    );
  });

  it('preserves sending and alert defaults until explicitly configured', () => {
    expect(availableAt('2026-10-19T23:00:00Z')).toMatchObject({
      available: false,
      sendingAllowed: true,
      notificationsSilenced: false,
      notice:
        'This is outside of normal business hours. There may be a delayed response.',
    });
    expect(
      availableAt('2026-10-19T23:00:00Z', { silenceWhenUnavailable: true })
        .notificationsSilenced,
    ).toBe(true);
    expect(
      availableAt('2026-10-19T15:00:00Z', { silenceWhenUnavailable: true })
        .notificationsSilenced,
    ).toBe(false);
    expect(
      availableAt('2026-10-19T23:00:00Z', { timezone: null, hours: [] })
        .available,
    ).toBe(true);
    expect(availableAt('2026-10-19T23:00:00Z', { hours: [] }).available).toBe(
      false,
    );
  });

  it('shows the saved message after hours and during a manual away override', () => {
    const outOfOfficeMessage =
      'I am away this week. Please contact the office.';
    expect(
      availableAt('2026-10-19T23:00:00Z', { outOfOfficeMessage }).notice,
    ).toBe(outOfOfficeMessage);
    expect(
      availableAt('2026-10-19T15:00:00Z', {
        outOfOfficeMessage,
        mode: 'AWAY',
      }).notice,
    ).toBe(outOfOfficeMessage);
    expect(
      availableAt('2026-10-19T15:00:00Z', { outOfOfficeMessage }).notice,
    ).toBeNull();
    expect(
      availableAt('2026-10-19T23:00:00Z', {
        outOfOfficeMessage,
        mode: 'AVAILABLE',
      }).notice,
    ).toBeNull();
  });

  it.each([null, '', '  \n '])(
    'uses the existing default for an empty saved message (%p)',
    (outOfOfficeMessage) => {
      expect(
        availableAt('2026-10-19T23:00:00Z', { outOfOfficeMessage }).notice,
      ).toBe(AFTER_HOURS_NOTICE);
    },
  );
});
