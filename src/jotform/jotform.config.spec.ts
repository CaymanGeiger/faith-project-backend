import {
  JotformConfigurationError,
  OFFICIAL_JOTFORM_API_BASE_URLS,
  loadJotformConfig,
} from './jotform.config';

const enabledEnvironment = (): NodeJS.ProcessEnv => ({
  JOTFORM_INTEGRATION_ENABLED: 'true',
  JOTFORM_API_KEY: 'api-key-for-tests',
  JOTFORM_FORM_ID: '252405795315055',
  JOTFORM_WEBHOOK_SECRET: 'c'.repeat(32),
  JOTFORM_RECONCILIATION_START_AT: '2026-09-06 00:00:00',
  JOTFORM_EMAIL_QID: '13',
  JOTFORM_COMPANY_QID: '14',
  JOTFORM_NAME_QID: '4',
});

describe('loadJotformConfig', () => {
  it('boots disabled without credentials and uses safe defaults', () => {
    const config = loadJotformConfig({});

    expect(config).toMatchObject({
      enabled: false,
      apiBaseUrl: 'https://api.jotform.com',
      requestTimeoutMs: 10_000,
      processingBatchSize: 25,
      reconciliationPageSize: 100,
      reconciliationMaxPages: 10,
      apiRateLimitReserve: 100,
      maxProcessingAttempts: 8,
      retryBaseDelayMs: 30_000,
      retryMaxDelayMs: 3_600_000,
      reconciliationLookbackMinutes: 1_440,
      reconciliationStartAt: null,
      processingLeaseSeconds: 120,
      formId: '252405795315055',
      questionIds: {
        email: '13',
        company: '14',
        name: '4',
        dealerNumber: null,
      },
    });
    expect(config.apiKey).toBeNull();
    expect(config.webhookSecret).toBeNull();
    expect(config.previousWebhookSecret).toBeNull();
  });

  it('requires every security-critical setting when enabled', () => {
    const requiredVariables = [
      'JOTFORM_API_KEY',
      'JOTFORM_FORM_ID',
      'JOTFORM_WEBHOOK_SECRET',
      'JOTFORM_RECONCILIATION_START_AT',
      'JOTFORM_EMAIL_QID',
      'JOTFORM_COMPANY_QID',
      'JOTFORM_NAME_QID',
    ] as const;

    for (const variable of requiredVariables) {
      const env = enabledEnvironment();
      delete env[variable];

      expect(() => loadJotformConfig(env)).toThrow(
        new JotformConfigurationError(`${variable} is required`),
      );
    }
  });

  it('loads enabled credentials, rotation secret, QIDs, and bounded tuning', () => {
    const currentSecret = `current-${'a'.repeat(40)}`;
    const previousSecret = `previous-${'b'.repeat(40)}`;
    const config = loadJotformConfig({
      ...enabledEnvironment(),
      JOTFORM_API_KEY: 'realistic-key',
      JOTFORM_FORM_ID: '000252405795315055',
      JOTFORM_WEBHOOK_SECRET: currentSecret,
      JOTFORM_WEBHOOK_PREVIOUS_SECRET: previousSecret,
      JOTFORM_API_BASE_URL: 'https://eu-api.jotform.com/',
      JOTFORM_REQUEST_TIMEOUT_MS: '30000',
      JOTFORM_PROCESSING_BATCH_SIZE: '100',
      JOTFORM_RECONCILIATION_PAGE_SIZE: '1000',
      JOTFORM_RECONCILIATION_MAX_PAGES: '100',
      JOTFORM_API_RATE_LIMIT_RESERVE: '0',
      JOTFORM_MAX_PROCESSING_ATTEMPTS: '25',
      JOTFORM_RETRY_BASE_DELAY_MS: '1000',
      JOTFORM_RETRY_MAX_DELAY_MS: '86400000',
      JOTFORM_RECONCILIATION_LOOKBACK_MINUTES: '10080',
      JOTFORM_PROCESSING_LEASE_SECONDS: '900',
      JOTFORM_RECONCILIATION_START_AT: '2026-09-01 14:31:00',
      JOTFORM_EMAIL_QID: '113',
      JOTFORM_COMPANY_QID: '114',
      JOTFORM_NAME_QID: '104',
      JOTFORM_DEALER_NUMBER_QID: '120',
    });

    expect(config).toMatchObject({
      enabled: true,
      apiBaseUrl: 'https://eu-api.jotform.com',
      formId: '000252405795315055',
      requestTimeoutMs: 30_000,
      processingBatchSize: 100,
      reconciliationPageSize: 1_000,
      reconciliationMaxPages: 100,
      apiRateLimitReserve: 0,
      maxProcessingAttempts: 25,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 86_400_000,
      reconciliationLookbackMinutes: 10_080,
      reconciliationStartAt: '2026-09-01 14:31:00',
      processingLeaseSeconds: 900,
      questionIds: {
        email: '113',
        company: '114',
        name: '104',
        dealerNumber: '120',
      },
    });
    expect(config.apiKey).toBe('realistic-key');
    expect(config.webhookSecret).toBe(currentSecret);
    expect(config.previousWebhookSecret).toBe(previousSecret);
  });

  it('never serializes integration credentials', () => {
    const env = enabledEnvironment();
    const apiKey = 'api-key-for-tests';
    const currentSecret = 'c'.repeat(32);
    const previousSecret = 'p'.repeat(32);
    env.JOTFORM_WEBHOOK_PREVIOUS_SECRET = previousSecret;
    const config = loadJotformConfig(env);
    const serialized = JSON.stringify(config);

    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(currentSecret);
    expect(serialized).not.toContain(previousSecret);
    expect(Object.keys(config)).not.toEqual(
      expect.arrayContaining([
        'apiKey',
        'webhookSecret',
        'previousWebhookSecret',
      ]),
    );
  });

  it.each(OFFICIAL_JOTFORM_API_BASE_URLS)(
    'allows the official API base %s',
    (apiBaseUrl) => {
      expect(
        loadJotformConfig({ JOTFORM_API_BASE_URL: apiBaseUrl }).apiBaseUrl,
      ).toBe(apiBaseUrl);
    },
  );

  it.each([
    'http://api.jotform.com',
    'https://api.jotform.com.attacker.example',
    'https://api.jotform.com/v1',
    'https://api.jotform.com?token=secret',
    'https://api.jotform.com:444',
    'not a URL',
  ])('rejects non-official or non-base API URL %s', (apiBaseUrl) => {
    expect(() =>
      loadJotformConfig({ JOTFORM_API_BASE_URL: apiBaseUrl }),
    ).toThrow(JotformConfigurationError);
  });

  it.each([
    ['JOTFORM_REQUEST_TIMEOUT_MS', '999'],
    ['JOTFORM_PROCESSING_BATCH_SIZE', '101'],
    ['JOTFORM_RECONCILIATION_PAGE_SIZE', '1.5'],
    ['JOTFORM_RECONCILIATION_MAX_PAGES', '-1'],
    ['JOTFORM_API_RATE_LIMIT_RESERVE', '10001'],
    ['JOTFORM_MAX_PROCESSING_ATTEMPTS', '0'],
    ['JOTFORM_RETRY_BASE_DELAY_MS', '999'],
    ['JOTFORM_RETRY_MAX_DELAY_MS', '9007199254740993'],
    ['JOTFORM_RECONCILIATION_LOOKBACK_MINUTES', '10081'],
    ['JOTFORM_PROCESSING_LEASE_SECONDS', '14'],
  ])('rejects unsafe integer setting %s=%s', (name, value) => {
    expect(() => loadJotformConfig({ [name]: value })).toThrow(
      JotformConfigurationError,
    );
  });

  it('rejects a retry ceiling below the retry base', () => {
    expect(() =>
      loadJotformConfig({
        JOTFORM_RETRY_BASE_DELAY_MS: '5000',
        JOTFORM_RETRY_MAX_DELAY_MS: '4999',
      }),
    ).toThrow(
      new JotformConfigurationError(
        'JOTFORM_RETRY_MAX_DELAY_MS must be greater than or equal to JOTFORM_RETRY_BASE_DELAY_MS',
      ),
    );
  });

  it.each([
    ['JOTFORM_FORM_ID', '12.5'],
    ['JOTFORM_EMAIL_QID', '-1'],
    ['JOTFORM_COMPANY_QID', 'company'],
    ['JOTFORM_NAME_QID', '4 ' + '0'.repeat(64)],
    ['JOTFORM_DEALER_NUMBER_QID', '[]'],
  ])('rejects a non-numeric or oversized ID in %s', (name, value) => {
    expect(() => loadJotformConfig({ [name]: value })).toThrow(
      JotformConfigurationError,
    );
  });

  it('rejects question IDs that alias two canonical fields', () => {
    expect(() =>
      loadJotformConfig({
        ...enabledEnvironment(),
        JOTFORM_COMPANY_QID: '13',
      }),
    ).toThrow(
      new JotformConfigurationError('Jotform question IDs must be distinct'),
    );

    expect(() =>
      loadJotformConfig({
        ...enabledEnvironment(),
        JOTFORM_DEALER_NUMBER_QID: '4',
      }),
    ).toThrow(
      new JotformConfigurationError('Jotform question IDs must be distinct'),
    );
  });

  it('requires rotation secrets to meet the same minimum length', () => {
    expect(() =>
      loadJotformConfig({ JOTFORM_WEBHOOK_PREVIOUS_SECRET: 'too-short' }),
    ).toThrow(
      new JotformConfigurationError(
        'JOTFORM_WEBHOOK_PREVIOUS_SECRET must contain at least 32 characters',
      ),
    );
  });

  it.each(['a'.repeat(31) + '!', `safe-${'a'.repeat(27)}@`])(
    'rejects a webhook secret that is unsafe in HTTP Basic userinfo',
    (secret) => {
      expect(() =>
        loadJotformConfig({
          ...enabledEnvironment(),
          JOTFORM_WEBHOOK_SECRET: secret,
        }),
      ).toThrow(JotformConfigurationError);
    },
  );

  it('rejects ambiguous integration-enabled values', () => {
    expect(() =>
      loadJotformConfig({ JOTFORM_INTEGRATION_ENABLED: 'yes' }),
    ).toThrow(
      new JotformConfigurationError(
        'JOTFORM_INTEGRATION_ENABLED must be either true or false',
      ),
    );
  });

  it.each([
    '2026-09-01',
    '2026-09-01T14:31:00Z',
    '2026-02-30 00:00:00',
    '2026-09-01 24:00:00',
  ])('rejects invalid reconciliation start timestamp %s', (value) => {
    expect(() =>
      loadJotformConfig({
        ...enabledEnvironment(),
        JOTFORM_RECONCILIATION_START_AT: value,
      }),
    ).toThrow(JotformConfigurationError);
  });
});
