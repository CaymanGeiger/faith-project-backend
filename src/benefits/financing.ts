import { ConfigService } from '@nestjs/config';

export type FinancingInformation =
  | { title: string; available: false; description: null; url: null }
  | { title: string; available: true; description: string; url: string };

// Match the existing in-app viewer's public HTTPS policy. Configuration is
// supplied by the program owner; a host name alone is not proof of approval.
function isSupportedDestination(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      host.includes('.') &&
      !host.includes(':') &&
      !/^\d+(\.\d+){3}$/.test(host) &&
      !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
    );
  } catch {
    return false;
  }
}

export function financingInformation(
  config: ConfigService,
): FinancingInformation {
  const url = config.get<string>('SYNCHRONY_FINANCING_URL')?.trim();
  const description = config
    .get<string>('SYNCHRONY_FINANCING_DESCRIPTION')
    ?.trim();
  const title = 'Synchrony Financing';

  if (!url || !description || !isSupportedDestination(url)) {
    return { title, available: false, description: null, url: null };
  }

  return { title, available: true, description, url };
}
