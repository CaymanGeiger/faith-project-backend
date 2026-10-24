const JOTFORM_ENVIRONMENT_VARIABLES = [
  'JOTFORM_INTEGRATION_ENABLED',
  'JOTFORM_API_KEY',
  'JOTFORM_FORM_ID',
  'JOTFORM_WEBHOOK_SECRET',
  'JOTFORM_WEBHOOK_PREVIOUS_SECRET',
  'JOTFORM_API_BASE_URL',
  'JOTFORM_REQUEST_TIMEOUT_MS',
  'JOTFORM_RECONCILIATION_START_AT',
  'JOTFORM_EMAIL_QID',
  'JOTFORM_COMPANY_QID',
  'JOTFORM_NAME_QID',
  'JOTFORM_WEBHOOK_ADMIN_API_KEY',
  'JOTFORM_WEBHOOK_PUBLIC_BASE_URL',
] as const;

const FORM_ID = '252405795315055';
const WEBHOOK_SECRET = `webhook-${'s'.repeat(32)}`;
const READ_ONLY_API_KEY = 'read-only-runtime-key';
const ADMIN_API_KEY = 'full-access-setup-key';
const PUBLIC_BASE_URL = 'https://dealer-api.example.com';
const targetUrl = new URL('/integrations/jotform/webhooks', PUBLIC_BASE_URL);
targetUrl.username = 'jotform';
targetUrl.password = WEBHOOK_SECRET;
const TARGET_URL = targetUrl.toString();

type ConsoleSpy = jest.SpyInstance<
  void,
  [message?: unknown, ...optional: unknown[]]
>;

describe('Jotform webhook registration command', () => {
  const originalEnvironment = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;
  const originalExitCode = process.exitCode;
  let logSpy: ConsoleSpy;
  let errorSpy: ConsoleSpy;

  beforeAll(() => {
    for (const name of JOTFORM_ENVIRONMENT_VARIABLES) {
      originalEnvironment.set(name, process.env[name]);
    }
  });

  beforeEach(() => {
    jest.resetModules();
    for (const name of JOTFORM_ENVIRONMENT_VARIABLES) {
      delete process.env[name];
    }
    Object.assign(process.env, {
      JOTFORM_INTEGRATION_ENABLED: 'true',
      JOTFORM_API_KEY: READ_ONLY_API_KEY,
      JOTFORM_FORM_ID: FORM_ID,
      JOTFORM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      JOTFORM_API_BASE_URL: 'https://api.jotform.com',
      JOTFORM_REQUEST_TIMEOUT_MS: '1000',
      JOTFORM_RECONCILIATION_START_AT: '2026-09-06 00:00:00',
      JOTFORM_EMAIL_QID: '13',
      JOTFORM_COMPANY_QID: '14',
      JOTFORM_NAME_QID: '4',
      JOTFORM_WEBHOOK_ADMIN_API_KEY: ADMIN_API_KEY,
      JOTFORM_WEBHOOK_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
    });
    process.exitCode = undefined;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
  });

  afterAll(() => {
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('is idempotent when the exact authenticated webhook URL already exists', async () => {
    const fetchMock = createFetchMock()
      .mockResolvedValueOnce(questionResponse())
      .mockResolvedValueOnce(jsonResponse({ existingWebhookId: TARGET_URL }));
    globalThis.fetch = fetchMock;

    runRegistrationCommand();
    await waitForConsoleCall(logSpy);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [input, init] = fetchMock.mock.calls[1];
    expect(toUrl(input).toString()).toBe(
      `https://api.jotform.com/form/${FORM_ID}/webhooks`,
    );
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(new Headers(init?.headers).get('APIKEY')).toBe(ADMIN_API_KEY);
    expect(toUrl(input).toString()).not.toContain(ADMIN_API_KEY);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'OK',
        created: false,
        webhookConfigured: true,
      }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('creates a missing webhook and verifies the exact URL afterward', async () => {
    const fetchMock = createFetchMock()
      .mockResolvedValueOnce(questionResponse())
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ webhookId: TARGET_URL }))
      .mockResolvedValueOnce(jsonResponse({ webhookId: TARGET_URL }));
    globalThis.fetch = fetchMock;

    runRegistrationCommand();
    await waitForConsoleCall(logSpy);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      'GET',
      'GET',
      'POST',
      'GET',
    ]);

    const [postInput, postInit] = fetchMock.mock.calls[2];
    expect(toUrl(postInput).toString()).toBe(
      `https://api.jotform.com/form/${FORM_ID}/webhooks`,
    );
    expect(new Headers(postInit?.headers).get('APIKEY')).toBe(ADMIN_API_KEY);
    expect(new Headers(postInit?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(
      new URLSearchParams(requireTextBody(postInit?.body)).get('webhookURL'),
    ).toBe(TARGET_URL);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'OK',
        created: true,
        webhookConfigured: true,
      }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not expose credentials, webhook URLs, or upstream bodies on failure', async () => {
    const privateUpstreamBody = `private:${ADMIN_API_KEY}:${WEBHOOK_SECRET}`;
    const fetchMock = createFetchMock().mockResolvedValue(
      new Response(privateUpstreamBody, {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    globalThis.fetch = fetchMock;

    runRegistrationCommand();
    await waitForConsoleCall(errorSpy);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'FAILED',
        code: 'JOTFORM_WEBHOOK_API_HTTP_ERROR',
      }),
    );
    const consoleOutput = JSON.stringify(errorSpy.mock.calls);
    expect(consoleOutput).not.toContain(ADMIN_API_KEY);
    expect(consoleOutput).not.toContain(READ_ONLY_API_KEY);
    expect(consoleOutput).not.toContain(WEBHOOK_SECRET);
    expect(consoleOutput).not.toContain(TARGET_URL);
    expect(consoleOutput).not.toContain(privateUpstreamBody);
    expect(process.exitCode).toBe(1);
  });

  it('retries transient API failures and honors a zero-second Retry-After', async () => {
    const fetchMock = createFetchMock()
      .mockResolvedValueOnce(
        new Response('temporarily unavailable', {
          status: 503,
          headers: { 'Retry-After': '0' },
        }),
      )
      .mockResolvedValueOnce(questionResponse())
      .mockResolvedValueOnce(jsonResponse({ existingWebhookId: TARGET_URL }));
    globalThis.fetch = fetchMock;

    runRegistrationCommand();
    await waitForConsoleCall(logSpy);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'OK',
        created: false,
        webhookConfigured: true,
      }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('re-lists before retrying an ambiguously committed webhook POST', async () => {
    const fetchMock = createFetchMock()
      .mockResolvedValueOnce(questionResponse())
      .mockResolvedValueOnce(jsonResponse({}))
      .mockRejectedValueOnce(new TypeError('connection closed after commit'))
      .mockResolvedValueOnce(jsonResponse({ webhookId: TARGET_URL }))
      .mockResolvedValueOnce(jsonResponse({ webhookId: TARGET_URL }));
    globalThis.fetch = fetchMock;

    runRegistrationCommand();
    await waitForConsoleCall(logSpy);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      'GET',
      'GET',
      'POST',
      'GET',
      'GET',
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'OK',
        created: true,
        webhookConfigured: true,
      }),
    );
  });

  it('re-lists after a committed POST response stream fails before retrying', async () => {
    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('response stream reset'));
      },
    });
    const fetchMock = createFetchMock()
      .mockResolvedValueOnce(questionResponse())
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(new Response(failedBody, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ webhookId: TARGET_URL }))
      .mockResolvedValueOnce(jsonResponse({ webhookId: TARGET_URL }));
    globalThis.fetch = fetchMock;

    runRegistrationCommand();
    await waitForConsoleCall(logSpy);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      'GET',
      'GET',
      'POST',
      'GET',
      'GET',
    ]);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'OK',
        created: true,
        webhookConfigured: true,
      }),
    );
  });

  it('rejects a streaming response that exceeds the body limit', async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      new Response('x'.repeat(1_000_001), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock;

    runRegistrationCommand();
    await waitForConsoleCall(errorSpy);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'FAILED',
        code: 'JOTFORM_WEBHOOK_API_RESPONSE_TOO_LARGE',
      }),
    );
  });

  it('refuses registration when configured question contracts drift', async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      jsonResponse({
        4: { qid: '4', type: 'control_fullname' },
        13: { qid: '13', type: 'control_textbox' },
        14: { qid: '14', type: 'control_textbox' },
      }),
    );
    globalThis.fetch = fetchMock;

    runRegistrationCommand();
    await waitForConsoleCall(errorSpy);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'FAILED',
        code: 'JOTFORM_FORM_MAPPING_MISMATCH',
      }),
    );
  });

  it('accepts numeric question IDs returned by Jotform', async () => {
    const fetchMock = createFetchMock()
      .mockResolvedValueOnce(
        jsonResponse([
          { qid: 4, type: 'control_fullname' },
          { qid: 13, type: 'control_email' },
          { qid: 14, type: 'control_textbox' },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ existingWebhookId: TARGET_URL }));
    globalThis.fetch = fetchMock;

    runRegistrationCommand();
    await waitForConsoleCall(logSpy);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'OK',
        created: false,
        webhookConfigured: true,
      }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects a public base URL containing a path', async () => {
    process.env.JOTFORM_WEBHOOK_PUBLIC_BASE_URL =
      'https://dealer-api.example.com/backend';
    const fetchMock = createFetchMock();
    globalThis.fetch = fetchMock;

    runRegistrationCommand();
    await waitForConsoleCall(errorSpy);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'FAILED',
        code: 'JOTFORM_WEBHOOK_PUBLIC_BASE_URL_INVALID',
      }),
    );
  });
});

function runRegistrationCommand() {
  // The operational script currently invokes main() at module load time.
  // resetModules() above gives every test an isolated command execution.
  jest.requireActual('../../scripts/jotform-register-webhook');
}

async function waitForConsoleCall(spy: ConsoleSpy) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (spy.mock.calls.length > 0) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Jotform webhook registration command did not finish');
}

function jsonResponse(content: unknown) {
  return new Response(
    JSON.stringify({ responseCode: 200, message: 'success', content }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function questionResponse() {
  return jsonResponse({
    4: { qid: '4', type: 'control_fullname' },
    13: { qid: '13', type: 'control_email' },
    14: { qid: '14', type: 'control_textbox' },
  });
}

function createFetchMock() {
  return jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
}

function toUrl(input: string | URL | Request) {
  if (input instanceof URL) {
    return input;
  }
  return new URL(typeof input === 'string' ? input : input.url);
}

function requireTextBody(body: BodyInit | null | undefined) {
  if (typeof body !== 'string') {
    throw new Error('Expected a URL-encoded string request body');
  }
  return body;
}
