import {
  JotformApiClient,
  JotformApiError,
  JotformFetch,
} from './jotform-api.client';

const API_KEY = 'test-api-key';

describe('JotformApiClient', () => {
  it('gets one submission with API key header authentication only', async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      jsonResponse({
        responseCode: 200,
        message: 'success',
        content: { id: '235194815571509962', answers: {} },
        'limit-left': 9_991,
      }),
    );
    const client = createClient(fetchMock);

    await expect(client.getSubmission('235194815571509962')).resolves.toEqual({
      content: { id: '235194815571509962', answers: {} },
      limitLeft: 9_991,
      responseCode: 200,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    const url = toUrl(input);
    const headers = new Headers(init?.headers);
    expect(url.toString()).toBe(
      'https://api.jotform.com/submission/235194815571509962',
    );
    expect(url.searchParams.has('apiKey')).toBe(false);
    expect(url.searchParams.has('apikey')).toBe(false);
    expect(headers.get('APIKEY')).toBe(API_KEY);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('accept')).toBe('application/json');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    'https://api.jotform.com',
    'https://eu-api.jotform.com/',
    'https://hipaa-api.jotform.com',
  ])('permits the official API origin %s', async (baseUrl) => {
    const fetchMock = createFetchMock().mockResolvedValue(
      successfulListResponse(),
    );
    const client = createClient(fetchMock, { baseUrl });

    await client.getFormSubmissions('252405795315055');

    const [input] = fetchMock.mock.calls[0];
    expect(toUrl(input).origin).toBe(new URL(baseUrl).origin);
  });

  it.each([
    'http://api.jotform.com',
    'https://api.jotform.com.evil.example',
    'https://api.jotform.com/v1',
    'https://user:pass@api.jotform.com',
    'https://api.jotform.com?target=elsewhere',
    'not-a-url',
  ])('rejects an unapproved API base URL: %s', (baseUrl) => {
    expect(
      getSyncError(() => createClient(createFetchMock(), { baseUrl })),
    ).toMatchObject({
      code: 'INVALID_CONFIGURATION',
      transient: false,
    });
  });

  it.each(['', '   ', 'key\nwith-newline', 'key\u0000value'])(
    'rejects an invalid API key without revealing it',
    (apiKey) => {
      expect(
        getSyncError(
          () => new JotformApiClient({ apiKey }, { fetch: createFetchMock() }),
        ),
      ).toMatchObject({
        code: 'INVALID_CONFIGURATION',
        transient: false,
      });
    },
  );

  it.each(['', 'abc', '123abc', ' 123', '123 ', '-123', '1.23'])(
    'rejects a non-digit submission ID: %s',
    async (submissionId) => {
      const fetchMock = createFetchMock();
      const client = createClient(fetchMock);

      await expect(client.getSubmission(submissionId)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        transient: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('encodes pagination, filter, and orderby for form submissions', async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      successfulListResponse('4998'),
    );
    const client = createClient(fetchMock);

    const result = await client.getFormSubmissions('252405795315055', {
      offset: 40,
      limit: 100,
      filter: {
        'created_at:gt': '2026-09-01 00:00:00',
        status: 'ACTIVE',
      },
      orderby: 'updated_at',
    });

    const [input] = fetchMock.mock.calls[0];
    const url = toUrl(input);
    expect(url.pathname).toBe('/form/252405795315055/submissions');
    expect(url.searchParams.get('offset')).toBe('40');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('filter')).toBe(
      JSON.stringify({
        'created_at:gt': '2026-09-01 00:00:00',
        status: 'ACTIVE',
      }),
    );
    expect(url.searchParams.get('orderby')).toBe('updated_at');
    expect(result.limitLeft).toBe(4_998);
  });

  it('accepts and canonicalizes a JSON object filter string', async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      successfulListResponse(),
    );
    const client = createClient(fetchMock);

    await client.getFormSubmissions('252405795315055', {
      filter: '{ "status": "ACTIVE" }',
    });

    const [input] = fetchMock.mock.calls[0];
    expect(toUrl(input).searchParams.get('filter')).toBe('{"status":"ACTIVE"}');
  });

  it.each([
    { offset: -1 },
    { offset: 1.5 },
    { limit: 0 },
    { limit: 1_001 },
    { orderby: '' },
    { orderby: 'updated_at desc' },
    { filter: '[]' },
    { filter: 'not-json' },
  ])('rejects invalid list query input %#', async (query) => {
    const fetchMock = createFetchMock();
    const client = createClient(fetchMock);

    await expect(
      client.getFormSubmissions('252405795315055', query),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      transient: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a filter that cannot be serialized', async () => {
    const fetchMock = createFetchMock();
    const client = createClient(fetchMock);
    const filter: Record<string, unknown> = {};
    filter.self = filter;

    await expect(
      client.getFormSubmissions('252405795315055', { filter }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      transient: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['not-json', 'INVALID_RESPONSE'],
    [JSON.stringify([]), 'INVALID_RESPONSE'],
    [JSON.stringify({ message: 'success', content: {} }), 'INVALID_RESPONSE'],
    [
      JSON.stringify({ responseCode: 200, message: 'success', content: [] }),
      'INVALID_RESPONSE',
    ],
    [
      JSON.stringify({
        responseCode: 200,
        message: 'success',
        content: {},
        'limit-left': 'unknown',
      }),
      'INVALID_RESPONSE',
    ],
  ])('rejects an invalid single-submission response', async (body, code) => {
    const client = createClient(
      createFetchMock().mockResolvedValue(new Response(body)),
    );

    await expect(client.getSubmission('123')).rejects.toMatchObject({
      code,
      transient: true,
    });
  });

  it('validates every item in a form submission list', async () => {
    const client = createClient(
      createFetchMock().mockResolvedValue(
        jsonResponse({
          responseCode: 200,
          message: 'success',
          content: [{ id: '123' }, null],
          'limit-left': 100,
        }),
      ),
    );

    await expect(
      client.getFormSubmissions('252405795315055'),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      transient: true,
    });
  });

  it('classifies rate limiting and parses delta-seconds Retry-After', async () => {
    const privateBody = 'private-submission-data-and-api-key';
    const client = createClient(
      createFetchMock().mockResolvedValue(
        new Response(privateBody, {
          status: 429,
          headers: { 'Retry-After': '7' },
        }),
      ),
    );

    const error = await getError(client.getSubmission('123'));
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      transient: true,
      statusCode: 429,
      retryAfterMs: 7_000,
    });
    expect(error.message).not.toContain(privateBody);
    expect(error).not.toHaveProperty('responseBody');
  });

  it('parses an HTTP-date Retry-After value', async () => {
    const now = Date.parse('2026-09-06T12:00:00.000Z');
    const client = createClient(
      createFetchMock().mockResolvedValue(
        new Response(null, {
          status: 503,
          headers: { 'Retry-After': 'Sun, 06 Sep 2026 12:00:30 GMT' },
        }),
      ),
      { now: () => now },
    );

    await expect(client.getSubmission('123')).rejects.toMatchObject({
      code: 'UPSTREAM_SERVER_ERROR',
      transient: true,
      statusCode: 503,
      retryAfterMs: 30_000,
    });
  });

  it.each([
    [500, 'UPSTREAM_SERVER_ERROR', true],
    [503, 'UPSTREAM_SERVER_ERROR', true],
    [408, 'UPSTREAM_SERVER_ERROR', true],
    [401, 'AUTHENTICATION_ERROR', false],
    [403, 'AUTHENTICATION_ERROR', false],
    [404, 'NOT_FOUND', false],
    [400, 'HTTP_ERROR', false],
  ])('classifies HTTP %i as %s', async (status, code, transient) => {
    const client = createClient(
      createFetchMock().mockResolvedValue(
        new Response('not exposed', { status }),
      ),
    );

    await expect(client.getSubmission('123')).rejects.toMatchObject({
      code,
      transient,
      statusCode: status,
    });
  });

  it('classifies an error response carried in a successful HTTP envelope', async () => {
    const client = createClient(
      createFetchMock().mockResolvedValue(
        jsonResponse({
          responseCode: 429,
          message: 'limit reached',
          content: {},
          'limit-left': 0,
        }),
      ),
    );

    await expect(client.getSubmission('123')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      transient: true,
      statusCode: 429,
      limitLeft: 0,
    });
  });

  it.each([
    [
      403,
      {
        responseCode: 403,
        message: 'API-Limit exceeded',
        content: {},
        'limit-left': 0,
      },
    ],
    [
      200,
      {
        responseCode: 401,
        error: 'API-Limit exceeded',
        'limit-left': '0',
      },
    ],
  ])(
    'recognizes Jotform quota exhaustion returned through HTTP %i',
    async (httpStatus, body) => {
      const client = createClient(
        createFetchMock().mockResolvedValue(
          new Response(JSON.stringify(body), {
            status: httpStatus,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      await expect(client.getSubmission('123')).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        transient: true,
        statusCode: body.responseCode,
        limitLeft: 0,
      });
    },
  );

  it('does not treat arbitrary 403 text as quota exhaustion', async () => {
    const client = createClient(
      createFetchMock().mockResolvedValue(
        new Response(
          JSON.stringify({ message: 'API permission denied', error: 'denied' }),
          { status: 403 },
        ),
      ),
    );

    await expect(client.getSubmission('123')).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
      transient: false,
      statusCode: 403,
    });
  });

  it('classifies network failures without copying the underlying message', async () => {
    const privateMessage = 'network error containing private data';
    const client = createClient(
      createFetchMock().mockRejectedValue(new Error(privateMessage)),
    );

    const error = await getError(client.getSubmission('123'));
    expect(error).toMatchObject({
      code: 'NETWORK_ERROR',
      transient: true,
      statusCode: null,
    });
    expect(error.message).not.toContain(privateMessage);
    expect(error.cause).toBeUndefined();
  });

  it('aborts and classifies a timed-out request', async () => {
    const fetchMock: JotformFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            const error = new Error('abort details');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    const client = createClient(fetchMock, { timeoutMs: 5 });

    await expect(client.getSubmission('123')).rejects.toMatchObject({
      code: 'TIMEOUT',
      transient: true,
      statusCode: null,
    });
  });

  it('bounds response bytes and does not include the body in its error', async () => {
    const privateBody = JSON.stringify({
      responseCode: 200,
      message: 'success',
      content: { secret: 'private-submission-value' },
    });
    const client = createClient(
      createFetchMock().mockResolvedValue(new Response(privateBody)),
      { maxResponseBytes: 24 },
    );

    const error = await getError(client.getSubmission('123'));
    expect(error).toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      transient: true,
    });
    expect(error.message).not.toContain('private-submission-value');
  });

  it('rejects invalid timeout and response-size configuration', () => {
    expect(
      getSyncError(() => createClient(createFetchMock(), { timeoutMs: 0 })),
    ).toMatchObject({
      code: 'INVALID_CONFIGURATION',
      transient: false,
    });
    expect(
      getSyncError(() =>
        createClient(createFetchMock(), { maxResponseBytes: 0 }),
      ),
    ).toMatchObject({
      code: 'INVALID_CONFIGURATION',
      transient: false,
    });
  });
});

function createClient(
  fetchImplementation: JotformFetch,
  options: {
    apiKey?: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    now?: () => number;
  } = {},
): JotformApiClient {
  return new JotformApiClient(
    {
      apiKey: options.apiKey ?? API_KEY,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
    },
    { fetch: fetchImplementation, now: options.now },
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function successfulListResponse(limitLeft: number | string = 5_000): Response {
  return jsonResponse({
    responseCode: 200,
    message: 'success',
    content: [{ id: '123', answers: {} }],
    'limit-left': limitLeft,
  });
}

function createFetchMock() {
  return jest.fn<ReturnType<JotformFetch>, Parameters<JotformFetch>>();
}

function toUrl(input: string | URL | Request): URL {
  if (input instanceof URL) {
    return input;
  }
  return new URL(typeof input === 'string' ? input : input.url);
}

function getSyncError(operation: () => unknown): JotformApiError {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(JotformApiError);
    return error as JotformApiError;
  }

  throw new Error('Expected operation to throw');
}

async function getError(promise: Promise<unknown>): Promise<JotformApiError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(JotformApiError);
    return error as JotformApiError;
  }

  throw new Error('Expected operation to reject');
}
