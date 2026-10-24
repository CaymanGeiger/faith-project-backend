export const AFTER_HOURS_NOTICE =
  'This is outside of normal business hours. There may be a delayed response.';

export type AvailabilityMode = 'SCHEDULE' | 'AVAILABLE' | 'AWAY';
export type AvailabilityHours = { day: number; start: string; end: string }[];
export type AvailabilitySettings = {
  timezone: string | null;
  hours: AvailabilityHours;
  mode: AvailabilityMode;
  overrideUntil: Date | null;
  silenceWhenUnavailable: boolean;
  outOfOfficeMessage: string | null;
};

const minutes = (value: string) => {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};

/** Evaluate wall-clock hours in the manager's zone, including DST and overnight shifts. */
export function evaluateAvailability(
  settings: AvailabilitySettings,
  now = new Date(),
) {
  const overrideActive =
    settings.mode !== 'SCHEDULE' &&
    (!settings.overrideUntil || settings.overrideUntil > now);
  let available = true;
  if (overrideActive) {
    available = settings.mode === 'AVAILABLE';
  } else if (settings.timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: settings.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type: string) =>
      parts.find((part) => part.type === type)!.value;
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      get('weekday'),
    );
    const currentMinute = Number(get('hour')) * 60 + Number(get('minute'));
    available = settings.hours.some((hours) => {
      const start = minutes(hours.start);
      const end = minutes(hours.end);
      if (start < end)
        return (
          hours.day === day && currentMinute >= start && currentMinute < end
        );
      return (
        (hours.day === day && currentMinute >= start) ||
        ((hours.day + 1) % 7 === day && currentMinute < end)
      );
    });
  }
  return {
    available,
    effectiveMode: overrideActive ? settings.mode : ('SCHEDULE' as const),
    notice: available
      ? null
      : settings.outOfOfficeMessage?.trim() || AFTER_HOURS_NOTICE,
    // Sending keeps its existing behavior until the organization approves a change.
    sendingAllowed: true,
    notificationsSilenced: !available && settings.silenceWhenUnavailable,
    evaluatedAt: now.toISOString(),
  };
}
