export const JOTFORM_CONFIG = Symbol('JOTFORM_CONFIG');

export const OFFICIAL_JOTFORM_API_BASE_URLS = [
  'https://api.jotform.com',
  'https://eu-api.jotform.com',
  'https://hipaa-api.jotform.com',
] as const;

export type OfficialJotformApiBaseUrl =
  (typeof OFFICIAL_JOTFORM_API_BASE_URLS)[number];

export interface JotformQuestionIds {
  email: string;
  company: string;
  name: string;
  dealerNumber: string | null;
}

export interface JotformConfig {
  enabled: boolean;
  apiBaseUrl: OfficialJotformApiBaseUrl;
  requestTimeoutMs: number;
  processingBatchSize: number;
  reconciliationPageSize: number;
  reconciliationMaxPages: number;
  apiRateLimitReserve: number;
  maxProcessingAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  reconciliationLookbackMinutes: number;
  reconciliationStartAt: string | null;
  processingLeaseSeconds: number;
  formId: string;
  questionIds: Readonly<JotformQuestionIds>;

  /** Secret properties are deliberately non-enumerable on the returned object. */
  apiKey: string | null;
  webhookSecret: string | null;
  previousWebhookSecret: string | null;
}

export class JotformConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JotformConfigurationError';
  }
}

const DEFAULT_FORM_ID = '252405795315055';
const DEFAULT_QUESTION_IDS = Object.freeze({
  email: '13',
  company: '14',
  name: '4',
  dealerNumber: null,
}) satisfies Readonly<JotformQuestionIds>;

type IntegerSetting = Readonly<{
  envName: string;
  defaultValue: number;
  minimum: number;
  maximum: number;
}>;

const INTEGER_SETTINGS = Object.freeze({
  requestTimeoutMs: {
    envName: 'JOTFORM_REQUEST_TIMEOUT_MS',
    defaultValue: 10_000,
    minimum: 1_000,
    maximum: 30_000,
  },
  processingBatchSize: {
    envName: 'JOTFORM_PROCESSING_BATCH_SIZE',
    defaultValue: 25,
    minimum: 1,
    maximum: 100,
  },
  reconciliationPageSize: {
    envName: 'JOTFORM_RECONCILIATION_PAGE_SIZE',
    defaultValue: 100,
    minimum: 1,
    maximum: 1_000,
  },
  reconciliationMaxPages: {
    envName: 'JOTFORM_RECONCILIATION_MAX_PAGES',
    defaultValue: 10,
    minimum: 1,
    maximum: 100,
  },
  apiRateLimitReserve: {
    envName: 'JOTFORM_API_RATE_LIMIT_RESERVE',
    defaultValue: 100,
    minimum: 0,
    maximum: 10_000,
  },
  maxProcessingAttempts: {
    envName: 'JOTFORM_MAX_PROCESSING_ATTEMPTS',
    defaultValue: 8,
    minimum: 1,
    maximum: 25,
  },
  retryBaseDelayMs: {
    envName: 'JOTFORM_RETRY_BASE_DELAY_MS',
    defaultValue: 30_000,
    minimum: 1_000,
    maximum: 600_000,
  },
  retryMaxDelayMs: {
    envName: 'JOTFORM_RETRY_MAX_DELAY_MS',
    defaultValue: 3_600_000,
    minimum: 1_000,
    maximum: 86_400_000,
  },
  reconciliationLookbackMinutes: {
    envName: 'JOTFORM_RECONCILIATION_LOOKBACK_MINUTES',
    defaultValue: 1_440,
    minimum: 1,
    maximum: 10_080,
  },
  processingLeaseSeconds: {
    envName: 'JOTFORM_PROCESSING_LEASE_SECONDS',
    defaultValue: 120,
    minimum: 15,
    maximum: 900,
  },
} satisfies Record<string, IntegerSetting>);

type JotformIntegerConfig = {
  [Key in keyof typeof INTEGER_SETTINGS]: number;
};

function parseEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new JotformConfigurationError(
    'JOTFORM_INTEGRATION_ENABLED must be either true or false',
  );
}

function readOptionalText(
  env: NodeJS.ProcessEnv,
  name: string,
  maximumLength: number,
): string | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const value = raw.trim();
  if (value.length > maximumLength) {
    throw new JotformConfigurationError(`${name} is too long`);
  }
  return value;
}

function readDigitString(
  env: NodeJS.ProcessEnv,
  name: string,
  options: { required: boolean; fallback?: string },
): string | null {
  const value = readOptionalText(env, name, 64) ?? options.fallback ?? null;
  if (value === null) {
    if (options.required) {
      throw new JotformConfigurationError(`${name} is required`);
    }
    return null;
  }

  if (!/^\d{1,64}$/.test(value)) {
    throw new JotformConfigurationError(
      `${name} must contain only decimal digits`,
    );
  }
  return value;
}

function readSecret(
  env: NodeJS.ProcessEnv,
  name: string,
  required: boolean,
): string | null {
  const value = readOptionalText(env, name, 256);
  if (value === null) {
    if (required) {
      throw new JotformConfigurationError(`${name} is required`);
    }
    return null;
  }

  if (value.length < 32) {
    throw new JotformConfigurationError(
      `${name} must contain at least 32 characters`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new JotformConfigurationError(
      `${name} must use only ASCII letters, digits, underscore, or hyphen`,
    );
  }
  return value;
}

function readInteger(env: NodeJS.ProcessEnv, setting: IntegerSetting): number {
  const raw = env[setting.envName];
  if (raw === undefined || raw.trim() === '') {
    return setting.defaultValue;
  }

  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new JotformConfigurationError(
      `${setting.envName} must be a whole number`,
    );
  }

  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < setting.minimum ||
    parsed > setting.maximum
  ) {
    throw new JotformConfigurationError(
      `${setting.envName} must be between ${setting.minimum} and ${setting.maximum}`,
    );
  }
  return parsed;
}

function readApiBaseUrl(env: NodeJS.ProcessEnv): OfficialJotformApiBaseUrl {
  const raw = readOptionalText(env, 'JOTFORM_API_BASE_URL', 256);
  const candidate = raw ?? OFFICIAL_JOTFORM_API_BASE_URLS[0];

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new JotformConfigurationError(
      'JOTFORM_API_BASE_URL must be an official Jotform HTTPS API base URL',
    );
  }

  const normalized = parsed.origin;
  const hasUnexpectedParts =
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '';
  if (
    hasUnexpectedParts ||
    !OFFICIAL_JOTFORM_API_BASE_URLS.includes(
      normalized as OfficialJotformApiBaseUrl,
    )
  ) {
    throw new JotformConfigurationError(
      'JOTFORM_API_BASE_URL must be an official Jotform HTTPS API base URL',
    );
  }

  return normalized as OfficialJotformApiBaseUrl;
}

function readIntegerConfig(env: NodeJS.ProcessEnv): JotformIntegerConfig {
  return Object.fromEntries(
    Object.entries(INTEGER_SETTINGS).map(([property, setting]) => [
      property,
      readInteger(env, setting),
    ]),
  ) as JotformIntegerConfig;
}

function readReconciliationStartAt(
  env: NodeJS.ProcessEnv,
  required: boolean,
): string | null {
  const value = readOptionalText(env, 'JOTFORM_RECONCILIATION_START_AT', 19);
  if (value === null) {
    if (required) {
      throw new JotformConfigurationError(
        'JOTFORM_RECONCILIATION_START_AT is required',
      );
    }
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new JotformConfigurationError(
      'JOTFORM_RECONCILIATION_START_AT must use YYYY-MM-DD HH:MM:SS',
    );
  }
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  const roundTrip = parsed.toISOString().slice(0, 19).replace('T', ' ');
  if (roundTrip !== value) {
    throw new JotformConfigurationError(
      'JOTFORM_RECONCILIATION_START_AT must be a valid calendar timestamp',
    );
  }
  return value;
}

/**
 * Loads and validates Jotform configuration directly from an environment map.
 * Integration credentials are non-enumerable to prevent accidental serialization.
 */
export function loadJotformConfig(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<JotformConfig> {
  const enabled = parseEnabled(env.JOTFORM_INTEGRATION_ENABLED);
  const apiKey = readOptionalText(env, 'JOTFORM_API_KEY', 512);
  const webhookSecret = readSecret(env, 'JOTFORM_WEBHOOK_SECRET', enabled);
  const previousWebhookSecret = readSecret(
    env,
    'JOTFORM_WEBHOOK_PREVIOUS_SECRET',
    false,
  );
  const formId = readDigitString(env, 'JOTFORM_FORM_ID', {
    required: enabled,
    fallback: enabled ? undefined : DEFAULT_FORM_ID,
  });
  const reconciliationStartAt = readReconciliationStartAt(env, enabled);

  if (enabled && apiKey === null) {
    throw new JotformConfigurationError('JOTFORM_API_KEY is required');
  }

  const integerConfig = readIntegerConfig(env);
  if (integerConfig.retryMaxDelayMs < integerConfig.retryBaseDelayMs) {
    throw new JotformConfigurationError(
      'JOTFORM_RETRY_MAX_DELAY_MS must be greater than or equal to JOTFORM_RETRY_BASE_DELAY_MS',
    );
  }

  const questionIds = Object.freeze({
    email:
      readDigitString(env, 'JOTFORM_EMAIL_QID', {
        required: enabled,
        fallback: enabled ? undefined : DEFAULT_QUESTION_IDS.email,
      }) ?? DEFAULT_QUESTION_IDS.email,
    company:
      readDigitString(env, 'JOTFORM_COMPANY_QID', {
        required: enabled,
        fallback: enabled ? undefined : DEFAULT_QUESTION_IDS.company,
      }) ?? DEFAULT_QUESTION_IDS.company,
    name:
      readDigitString(env, 'JOTFORM_NAME_QID', {
        required: enabled,
        fallback: enabled ? undefined : DEFAULT_QUESTION_IDS.name,
      }) ?? DEFAULT_QUESTION_IDS.name,
    dealerNumber: readDigitString(env, 'JOTFORM_DEALER_NUMBER_QID', {
      required: false,
    }),
  });
  const configuredQuestionIds = [
    questionIds.email,
    questionIds.company,
    questionIds.name,
    ...(questionIds.dealerNumber ? [questionIds.dealerNumber] : []),
  ];
  if (new Set(configuredQuestionIds).size !== configuredQuestionIds.length) {
    throw new JotformConfigurationError(
      'Jotform question IDs must be distinct',
    );
  }

  const enumerableConfig = {
    enabled,
    apiBaseUrl: readApiBaseUrl(env),
    ...integerConfig,
    reconciliationStartAt,
    formId: formId ?? DEFAULT_FORM_ID,
    questionIds,
  };
  const config = { ...enumerableConfig } as JotformConfig;

  Object.defineProperties(config, {
    apiKey: {
      value: apiKey,
      enumerable: false,
      writable: false,
      configurable: false,
    },
    webhookSecret: {
      value: webhookSecret,
      enumerable: false,
      writable: false,
      configurable: false,
    },
    previousWebhookSecret: {
      value: previousWebhookSecret,
      enumerable: false,
      writable: false,
      configurable: false,
    },
  });

  return Object.freeze(config);
}
