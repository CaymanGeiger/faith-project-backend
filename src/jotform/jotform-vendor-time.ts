const VENDOR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * Jotform documents a timezone-less timestamp. We preserve it as vendor text;
 * UTC is used here only for calendar arithmetic when creating an overlap.
 */
export function subtractVendorMinutes(value: string, minutes: number) {
  const parsed = parseVendorTimestamp(value);
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 7 * 24 * 60) {
    throw new Error('Invalid Jotform reconciliation overlap');
  }
  parsed.setUTCMinutes(parsed.getUTCMinutes() - minutes);
  return formatVendorTimestamp(parsed);
}

export function addVendorSeconds(value: string, seconds: number) {
  const parsed = parseVendorTimestamp(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 60) {
    throw new Error('Invalid Jotform timestamp increment');
  }
  parsed.setUTCSeconds(parsed.getUTCSeconds() + seconds);
  return formatVendorTimestamp(parsed);
}

export function laterVendorTimestamp(
  current: string | null,
  candidate: string,
) {
  parseVendorTimestamp(candidate);
  if (current === null) {
    return candidate;
  }
  parseVendorTimestamp(current);
  return candidate > current ? candidate : current;
}

export function isVendorTimestampAtLeast(
  candidate: string,
  current: string | null,
) {
  parseVendorTimestamp(candidate);
  if (current === null) {
    return true;
  }
  parseVendorTimestamp(current);
  return candidate >= current;
}

function parseVendorTimestamp(value: string) {
  const match = VENDOR_TIMESTAMP.exec(value);
  if (!match) {
    throw new Error('Invalid Jotform vendor timestamp');
  }
  const date = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ),
  );
  if (formatVendorTimestamp(date) !== value) {
    throw new Error('Invalid Jotform vendor timestamp');
  }
  return date;
}

function formatVendorTimestamp(date: Date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
