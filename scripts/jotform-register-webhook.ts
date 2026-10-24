import { loadJotformConfig } from '../src/jotform/jotform.config';
import { safeJotformCliError } from './jotform-runtime';

type ApiEnvelope = {
  responseCode: number;
  content: unknown;
};

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REQUEST_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 30_000;

async function main() {
  const config = loadJotformConfig();
  if (!config.enabled || !config.webhookSecret) {
    throw new Error('JOTFORM_INTEGRATION_DISABLED');
  }
  const adminApiKey = requiredSecret('JOTFORM_WEBHOOK_ADMIN_API_KEY');
  const publicBaseUrl = requiredPublicBaseUrl();
  const targetUrl = new URL('/integrations/jotform/webhooks', publicBaseUrl);
  targetUrl.username = 'jotform';
  targetUrl.password = config.webhookSecret;
  const target = targetUrl.toString();
  const endpoint = new URL(
    `/form/${config.formId}/webhooks`,
    config.apiBaseUrl,
  );
  const questionsEndpoint = new URL(
    `/form/${config.formId}/questions`,
    config.apiBaseUrl,
  );

  const questions = await request(
    questionsEndpoint,
    adminApiKey,
    config.requestTimeoutMs,
  );
  verifyQuestionContracts(questions.content, [
    [config.questionIds.email, 'control_email'],
    [config.questionIds.company, 'control_textbox'],
    [config.questionIds.name, 'control_fullname'],
    ...(config.questionIds.dealerNumber
      ? ([[config.questionIds.dealerNumber, 'control_textbox']] as const)
      : []),
  ]);

  const existing = await request(
    endpoint,
    adminApiKey,
    config.requestTimeoutMs,
  );
  const existingUrls = collectWebhookUrls(existing.content);
  if (existingUrls.includes(target)) {
    console.log(
      JSON.stringify({ status: 'OK', created: false, webhookConfigured: true }),
    );
    return;
  }

  await request(
    endpoint,
    adminApiKey,
    config.requestTimeoutMs,
    target,
    async () => {
      const probe = await request(
        endpoint,
        adminApiKey,
        config.requestTimeoutMs,
      );
      return collectWebhookUrls(probe.content).includes(target);
    },
  );
  const verified = await request(
    endpoint,
    adminApiKey,
    config.requestTimeoutMs,
  );
  if (!collectWebhookUrls(verified.content).includes(target)) {
    throw new Error('JOTFORM_WEBHOOK_VERIFICATION_FAILED');
  }
  console.log(
    JSON.stringify({ status: 'OK', created: true, webhookConfigured: true }),
  );
}

async function request(
  endpoint: URL,
  apiKey: string,
  timeoutMs: number,
  webhookUrl?: string,
  confirmAmbiguousWrite?: () => Promise<boolean>,
): Promise<ApiEnvelope> {
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: webhookUrl ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          APIKEY: apiKey,
          ...(webhookUrl
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        ...(webhookUrl
          ? { body: new URLSearchParams({ webhookURL: webhookUrl }).toString() }
          : {}),
      });
    } catch (error: unknown) {
      if (attempt < MAX_REQUEST_ATTEMPTS && isTransientFetchError(error)) {
        if (webhookUrl && confirmAmbiguousWrite) {
          if (await confirmAmbiguousWrite()) {
            return { responseCode: 200, content: {} };
          }
        }
        await wait(retryDelayMs(attempt, null));
        continue;
      }
      throw new Error('JOTFORM_WEBHOOK_API_REQUEST_FAILED');
    }

    const retryAfterMs = parseRetryAfter(
      response.headers.get('retry-after'),
      Date.now(),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (
        attempt < MAX_REQUEST_ATTEMPTS &&
        isTransientStatus(response.status)
      ) {
        if (webhookUrl && confirmAmbiguousWrite) {
          if (await confirmAmbiguousWrite()) {
            return { responseCode: 200, content: {} };
          }
        }
        await wait(retryDelayMs(attempt, retryAfterMs));
        continue;
      }
      throw new Error('JOTFORM_WEBHOOK_API_HTTP_ERROR');
    }

    let envelope: ApiEnvelope;
    try {
      envelope = await parseResponseEnvelope(response);
    } catch (error: unknown) {
      if (webhookUrl && confirmAmbiguousWrite) {
        if (await confirmAmbiguousWrite()) {
          return { responseCode: 200, content: {} };
        }
      }
      if (attempt < MAX_REQUEST_ATTEMPTS && isTransientFetchError(error)) {
        await response.body?.cancel().catch(() => undefined);
        await wait(retryDelayMs(attempt, retryAfterMs));
        continue;
      }
      if (
        error instanceof Error &&
        /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
      ) {
        throw error;
      }
      throw new Error('JOTFORM_WEBHOOK_API_REQUEST_FAILED');
    }
    if (envelope.responseCode === 200) {
      return envelope;
    }
    if (
      attempt < MAX_REQUEST_ATTEMPTS &&
      isTransientStatus(envelope.responseCode)
    ) {
      if (webhookUrl && confirmAmbiguousWrite) {
        if (await confirmAmbiguousWrite()) {
          return { responseCode: 200, content: {} };
        }
      }
      await wait(retryDelayMs(attempt, retryAfterMs));
      continue;
    }
    throw new Error('JOTFORM_WEBHOOK_API_HTTP_ERROR');
  }

  throw new Error('JOTFORM_WEBHOOK_API_REQUEST_FAILED');
}

async function parseResponseEnvelope(response: Response): Promise<ApiEnvelope> {
  const text = await readBoundedResponse(response, MAX_RESPONSE_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('JOTFORM_WEBHOOK_API_INVALID_RESPONSE');
  }
  if (
    !isRecord(value) ||
    typeof value.responseCode !== 'number' ||
    !Number.isInteger(value.responseCode) ||
    !('content' in value)
  ) {
    throw new Error('JOTFORM_WEBHOOK_API_INVALID_RESPONSE');
  }
  return { responseCode: value.responseCode, content: value.content };
}

async function readBoundedResponse(response: Response, maximumBytes: number) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('JOTFORM_WEBHOOK_API_RESPONSE_TOO_LARGE');
    }
  }
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('JOTFORM_WEBHOOK_API_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function isTransientFetchError(error: unknown) {
  return (
    error instanceof TypeError ||
    (error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
}

function isTransientStatus(status: number) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1_000, RETRY_MAX_DELAY_MS);
  }
  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) {
    return null;
  }
  return Math.min(Math.max(0, retryAt - now), RETRY_MAX_DELAY_MS);
}

function retryDelayMs(attempt: number, retryAfterMs: number | null) {
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }
  const ceiling = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
  );
  return Math.floor(Math.random() * (ceiling + 1));
}

async function wait(delayMs: number) {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function collectWebhookUrls(content: unknown) {
  const values = Array.isArray(content)
    ? content
    : isRecord(content)
      ? Object.values(content)
      : [];
  return values.filter(
    (value): value is string =>
      typeof value === 'string' && value.length < 8_192,
  );
}

function verifyQuestionContracts(
  content: unknown,
  contracts: ReadonlyArray<readonly [string, string]>,
) {
  if (!isRecord(content) && !Array.isArray(content)) {
    throw new Error('JOTFORM_FORM_MAPPING_MISMATCH');
  }
  const questions: unknown[] = Array.isArray(content)
    ? [...(content as unknown[])]
    : Object.entries(content).map(([key, value]) =>
        isRecord(value) && value.qid === undefined
          ? { ...value, qid: key }
          : value,
      );
  for (const [questionId, expectedType] of contracts) {
    const match = questions.find(
      (question) =>
        isRecord(question) && normalizeQuestionId(question.qid) === questionId,
    );
    if (!isRecord(match) || match.type !== expectedType) {
      throw new Error('JOTFORM_FORM_MAPPING_MISMATCH');
    }
  }
}

function normalizeQuestionId(value: unknown) {
  if (typeof value === 'string' && /^\d{1,64}$/.test(value)) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

function requiredSecret(name: string) {
  const value = process.env[name]?.trim();
  if (!value || value.length > 512) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function requiredPublicBaseUrl() {
  const raw = process.env.JOTFORM_WEBHOOK_PUBLIC_BASE_URL?.trim();
  if (!raw) {
    throw new Error('JOTFORM_WEBHOOK_PUBLIC_BASE_URL_INVALID');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('JOTFORM_WEBHOOK_PUBLIC_BASE_URL_INVALID');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    throw new Error('JOTFORM_WEBHOOK_PUBLIC_BASE_URL_INVALID');
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ status: 'FAILED', code: safeJotformCliError(error) }),
  );
  process.exitCode = 1;
});
