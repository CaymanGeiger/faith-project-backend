const DEFAULT_BASE_URL = 'https://api.jotform.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_FILTER_BYTES = 16 * 1024;
const MAX_API_KEY_LENGTH = 1_024;
const MAX_ORDER_BY_LENGTH = 128;
const MAX_PAGE_SIZE = 1_000;

const ALLOWED_BASE_URLS = new Set([
  'https://api.jotform.com',
  'https://eu-api.jotform.com',
  'https://hipaa-api.jotform.com',
]);

const DIGIT_STRING = /^\d+$/;
const ORDER_BY_VALUE = /^[A-Za-z0-9_.:-]+$/;

export type JotformSubmission = Readonly<Record<string, unknown>>;

export interface JotformApiClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type JotformFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface JotformApiClientDependencies {
  fetch?: JotformFetch;
  now?: () => number;
}

export interface JotformFormSubmissionsQuery {
  offset?: number;
  limit?: number;
  filter?: Readonly<Record<string, unknown>> | string;
  orderby?: string;
}

export interface JotformApiResult<T> {
  content: T;
  /** Remaining daily API calls reported by Jotform's `limit-left` field. */
  limitLeft: number | null;
  responseCode: number;
}

export type JotformApiErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'UPSTREAM_SERVER_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'NOT_FOUND'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE';

interface JotformApiErrorOptions {
  code: JotformApiErrorCode;
  transient: boolean;
  statusCode?: number | null;
  retryAfterMs?: number | null;
  limitLeft?: number | null;
}

/**
 * An operational error safe to classify, retry, and log without including a
 * Jotform response body, API key, or submitted form data.
 */
export class JotformApiError extends Error {
  readonly code: JotformApiErrorCode;
  readonly transient: boolean;
  readonly statusCode: number | null;
  readonly retryAfterMs: number | null;
  readonly limitLeft: number | null;

  constructor(message: string, options: JotformApiErrorOptions) {
    super(message);
    this.name = 'JotformApiError';
    this.code = options.code;
    this.transient = options.transient;
    this.statusCode = options.statusCode ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.limitLeft = options.limitLeft ?? null;
  }
}

type ContentValidator<T> = (content: unknown) => T;

interface JotformEnvelope {
  responseCode: number;
  content: unknown;
  limitLeft: number | null;
  apiLimitExceeded: boolean;
}

/**
 * Minimal, read-only Jotform REST client. Authentication is sent exclusively
 * in the `APIKEY` request header, and redirects are rejected so credentials
 * cannot be forwarded to an unapproved host.
 */
export class JotformApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImplementation: JotformFetch;
  private readonly now: () => number;

  constructor(
    config: JotformApiClientConfig,
    dependencies: JotformApiClientDependencies = {},
  ) {
    const runtimeConfig = config as JotformApiClientConfig | null | undefined;
    this.apiKey = validateApiKey(runtimeConfig?.apiKey);
    this.baseUrl = validateBaseUrl(runtimeConfig?.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = validateBoundedInteger(
      runtimeConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeout',
      1,
      MAX_TIMEOUT_MS,
      'INVALID_CONFIGURATION',
    );
    this.maxResponseBytes = validateBoundedInteger(
      runtimeConfig?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'response size',
      1,
      MAX_RESPONSE_BYTES,
      'INVALID_CONFIGURATION',
    );
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;

    if (typeof this.fetchImplementation !== 'function') {
      throw configurationError('A fetch implementation is required');
    }
    if (typeof this.now !== 'function') {
      throw configurationError('A clock implementation is required');
    }
  }

  async getSubmission(
    submissionId: string,
  ): Promise<JotformApiResult<JotformSubmission>> {
    const id = validateId(submissionId, 'submission');
    const url = new URL(`/submission/${id}`, this.baseUrl);

    return this.get(url, validateSubmission);
  }

  async getFormSubmissions(
    formId: string,
    query: JotformFormSubmissionsQuery = {},
  ): Promise<JotformApiResult<JotformSubmission[]>> {
    const id = validateId(formId, 'form');
    const url = new URL(`/form/${id}/submissions`, this.baseUrl);

    if (query.offset !== undefined) {
      url.searchParams.set(
        'offset',
        String(
          validateBoundedInteger(
            query.offset,
            'offset',
            0,
            Number.MAX_SAFE_INTEGER,
            'INVALID_REQUEST',
          ),
        ),
      );
    }

    if (query.limit !== undefined) {
      url.searchParams.set(
        'limit',
        String(
          validateBoundedInteger(
            query.limit,
            'limit',
            1,
            MAX_PAGE_SIZE,
            'INVALID_REQUEST',
          ),
        ),
      );
    }

    if (query.filter !== undefined) {
      url.searchParams.set('filter', serializeFilter(query.filter));
    }

    if (query.orderby !== undefined) {
      url.searchParams.set('orderby', validateOrderBy(query.orderby));
    }

    return this.get(url, validateSubmissionList);
  }

  private async get<T>(
    url: URL,
    validateContent: ContentValidator<T>,
  ): Promise<JotformApiResult<T>> {
    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.timeoutMs);

    try {
      const headers = new Headers({
        Accept: 'application/json',
        APIKEY: this.apiKey,
      });
      const response = await this.fetchImplementation(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: abortController.signal,
      });
      const retryAfterMs = parseRetryAfter(
        response.headers.get('retry-after'),
        this.now(),
      );

      if (!response.ok) {
        const body = await readBoundedBody(response, this.maxResponseBytes);
        const metadata = parseErrorMetadata(body);
        throw classifyHttpError(
          response.status,
          retryAfterMs,
          metadata.limitLeft,
          metadata.apiLimitExceeded,
        );
      }

      const body = await readBoundedBody(response, this.maxResponseBytes);
      const envelope = parseEnvelope(body);

      if (envelope.responseCode < 200 || envelope.responseCode >= 300) {
        throw classifyHttpError(
          envelope.responseCode,
          retryAfterMs,
          envelope.limitLeft,
          envelope.apiLimitExceeded,
        );
      }

      return {
        content: validateContent(envelope.content),
        limitLeft: envelope.limitLeft,
        responseCode: envelope.responseCode,
      };
    } catch (error: unknown) {
      if (error instanceof JotformApiError) {
        throw error;
      }

      if (timedOut || isAbortError(error)) {
        throw new JotformApiError('Jotform API request timed out', {
          code: 'TIMEOUT',
          transient: true,
        });
      }

      throw new JotformApiError('Jotform API network request failed', {
        code: 'NETWORK_ERROR',
        transient: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateApiKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw configurationError('Jotform API key is required');
  }

  const apiKey = value.trim();
  if (
    apiKey.length === 0 ||
    apiKey.length > MAX_API_KEY_LENGTH ||
    containsControlCharacter(apiKey)
  ) {
    throw configurationError('Jotform API key is invalid');
  }

  return apiKey;
}

function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw configurationError('Jotform API base URL is invalid');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError('Jotform API base URL is invalid');
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== '' ||
    !ALLOWED_BASE_URLS.has(url.origin)
  ) {
    throw configurationError('Jotform API base URL is not allowed');
  }

  return url.origin;
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGIT_STRING.test(value)) {
    throw new JotformApiError(`Jotform ${label} ID must contain only digits`, {
      code: 'INVALID_REQUEST',
      transient: false,
    });
  }

  return value;
}

function validateBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  code: 'INVALID_CONFIGURATION' | 'INVALID_REQUEST',
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new JotformApiError(`Jotform ${label} is invalid`, {
      code,
      transient: false,
    });
  }

  return value;
}

function validateOrderBy(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ORDER_BY_LENGTH ||
    !ORDER_BY_VALUE.test(value)
  ) {
    throw new JotformApiError('Jotform orderby is invalid', {
      code: 'INVALID_REQUEST',
      transient: false,
    });
  }

  return value;
}

function serializeFilter(
  filter: Readonly<Record<string, unknown>> | string,
): string {
  let parsedFilter: unknown = filter;

  if (typeof filter === 'string') {
    try {
      parsedFilter = JSON.parse(filter) as unknown;
    } catch {
      throw invalidFilterError();
    }
  }

  if (!isObject(parsedFilter)) {
    throw invalidFilterError();
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(parsedFilter);
  } catch {
    throw invalidFilterError();
  }

  if (
    serialized.length === 0 ||
    Buffer.byteLength(serialized, 'utf8') > MAX_FILTER_BYTES
  ) {
    throw invalidFilterError();
  }

  try {
    if (!isObject(JSON.parse(serialized) as unknown)) {
      throw invalidFilterError();
    }
  } catch (error: unknown) {
    if (error instanceof JotformApiError) {
      throw error;
    }
    throw invalidFilterError();
  }

  return serialized;
}

function parseEnvelope(body: string): JotformEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw invalidResponseError();
  }

  if (!isObject(parsed)) {
    throw invalidResponseError();
  }

  const responseCode = parsed.responseCode;
  const successful =
    typeof responseCode === 'number' &&
    responseCode >= 200 &&
    responseCode < 300;
  if (
    typeof responseCode !== 'number' ||
    !Number.isSafeInteger(responseCode) ||
    responseCode < 100 ||
    responseCode > 599 ||
    (successful &&
      (typeof parsed.message !== 'string' ||
        !Object.prototype.hasOwnProperty.call(parsed, 'content')))
  ) {
    throw invalidResponseError();
  }

  return {
    responseCode,
    content: parsed.content,
    limitLeft: parseLimitLeft(parsed['limit-left']),
    apiLimitExceeded: hasApiLimitExceededToken(parsed),
  };
}

function parseErrorMetadata(body: string) {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isObject(parsed)) {
      return { apiLimitExceeded: false, limitLeft: null };
    }
    let limitLeft: number | null = null;
    try {
      limitLeft = parseLimitLeft(parsed['limit-left']);
    } catch {
      // The HTTP status remains authoritative when optional metadata is bad.
    }
    return {
      apiLimitExceeded: hasApiLimitExceededToken(parsed),
      limitLeft,
    };
  } catch {
    return { apiLimitExceeded: false, limitLeft: null };
  }
}

function hasApiLimitExceededToken(value: Record<string, unknown>) {
  return [value.message, value.error].some((candidate) => {
    if (typeof candidate !== 'string' || candidate.length > 80) {
      return false;
    }
    const normalized = candidate
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, ' ')
      .replace(/[.!]$/, '');
    return normalized === 'api limit exceeded';
  });
}

function parseLimitLeft(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized =
    typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;

  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized)) {
    throw invalidResponseError();
  }

  return normalized;
}

function validateSubmission(content: unknown): JotformSubmission {
  if (!isObject(content)) {
    throw invalidResponseError();
  }
  return content;
}

function validateSubmissionList(content: unknown): JotformSubmission[] {
  if (!Array.isArray(content) || !content.every(isObject)) {
    throw invalidResponseError();
  }
  return content;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const length = Number(declaredLength);
    if (Number.isSafeInteger(length) && length > maxBytes) {
      await cancelResponseBody(response);
      throw responseTooLargeError();
    }
  }

  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0;
  let body = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw responseTooLargeError();
      }
      try {
        body += decoder.decode(value, { stream: true });
      } catch {
        throw invalidResponseError();
      }
    }
    try {
      body += decoder.decode();
    } catch {
      throw invalidResponseError();
    }
    return body;
  } catch (error: unknown) {
    if (error instanceof JotformApiError) {
      throw error;
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) {
    return;
  }
  try {
    await response.body.cancel();
  } catch {
    // The HTTP status remains authoritative if the body cannot be cancelled.
  }
}

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    const milliseconds = seconds * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }

  const dateMs = Date.parse(normalized);
  if (!Number.isFinite(dateMs)) {
    return null;
  }

  return Math.max(0, dateMs - nowMs);
}

function classifyHttpError(
  statusCode: number,
  retryAfterMs: number | null,
  limitLeft: number | null,
  apiLimitExceeded = false,
): JotformApiError {
  if (statusCode === 429 || apiLimitExceeded) {
    return new JotformApiError('Jotform API rate limit exceeded', {
      code: 'RATE_LIMITED',
      transient: true,
      statusCode,
      retryAfterMs,
      limitLeft,
    });
  }

  if (statusCode >= 500 || statusCode === 408 || statusCode === 425) {
    return new JotformApiError('Jotform API is temporarily unavailable', {
      code: 'UPSTREAM_SERVER_ERROR',
      transient: true,
      statusCode,
      retryAfterMs,
      limitLeft,
    });
  }

  if (statusCode === 401 || statusCode === 403) {
    return new JotformApiError('Jotform API authentication failed', {
      code: 'AUTHENTICATION_ERROR',
      transient: false,
      statusCode,
      retryAfterMs,
      limitLeft,
    });
  }

  if (statusCode === 404) {
    return new JotformApiError('Jotform API resource was not found', {
      code: 'NOT_FOUND',
      transient: false,
      statusCode,
      retryAfterMs,
      limitLeft,
    });
  }

  return new JotformApiError('Jotform API request was rejected', {
    code: 'HTTP_ERROR',
    transient: false,
    statusCode,
    retryAfterMs,
    limitLeft,
  });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function configurationError(message: string): JotformApiError {
  return new JotformApiError(message, {
    code: 'INVALID_CONFIGURATION',
    transient: false,
  });
}

function invalidFilterError(): JotformApiError {
  return new JotformApiError('Jotform filter is invalid', {
    code: 'INVALID_REQUEST',
    transient: false,
  });
}

function invalidResponseError(): JotformApiError {
  return new JotformApiError('Jotform API returned an invalid response', {
    code: 'INVALID_RESPONSE',
    transient: true,
  });
}

function responseTooLargeError(): JotformApiError {
  return new JotformApiError('Jotform API response exceeded the size limit', {
    code: 'RESPONSE_TOO_LARGE',
    transient: true,
  });
}
