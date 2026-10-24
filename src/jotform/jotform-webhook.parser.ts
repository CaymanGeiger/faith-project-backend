import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_JOTFORM_ENVELOPE_ID_LENGTH = 64;
export const MAX_JOTFORM_RAW_REQUEST_BYTES = 2_000_000;

export type JotformWebhookParseErrorCode =
  | 'INVALID_BODY'
  | 'INVALID_FORM_ID'
  | 'INVALID_SUBMISSION_ID'
  | 'INVALID_RAW_REQUEST';

export class JotformWebhookParseError extends Error {
  constructor(
    public readonly code: JotformWebhookParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JotformWebhookParseError';
  }
}

export interface JotformWebhookEnvelope {
  formId: string;
  submissionId: string;
  /** Stable, PII-free digest of the two immutable envelope identifiers. */
  fingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelopeId(value: unknown, kind: 'form' | 'submission'): string {
  const code = kind === 'form' ? 'INVALID_FORM_ID' : 'INVALID_SUBMISSION_ID';
  const label = kind === 'form' ? 'formID' : 'submissionID';

  // Numbers are intentionally rejected: large Jotform identifiers cannot be
  // safely round-tripped through JavaScript's numeric representation.
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_JOTFORM_ENVELOPE_ID_LENGTH ||
    !/^\d+$/.test(value)
  ) {
    throw new JotformWebhookParseError(
      code,
      `${label} must be a decimal digit string no longer than ${MAX_JOTFORM_ENVELOPE_ID_LENGTH} characters`,
    );
  }
  return value;
}

function parseRawRequest(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_JOTFORM_RAW_REQUEST_BYTES) {
      throw new JotformWebhookParseError(
        'INVALID_RAW_REQUEST',
        'rawRequest exceeds the permitted size',
      );
    }

    try {
      const parsed: unknown = JSON.parse(value);
      if (!isRecord(parsed)) {
        throw new Error('not an object');
      }
      return parsed;
    } catch {
      throw new JotformWebhookParseError(
        'INVALID_RAW_REQUEST',
        'rawRequest must contain a JSON object',
      );
    }
  }

  if (!isRecord(value)) {
    throw new JotformWebhookParseError(
      'INVALID_RAW_REQUEST',
      'rawRequest must contain a JSON object',
    );
  }
  return value;
}

function verifyNestedEnvelopeId(
  rawRequest: Record<string, unknown>,
  keys: readonly string[],
  expected: string,
  kind: 'form' | 'submission',
): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(rawRequest, key)) {
      continue;
    }

    const nested = parseEnvelopeId(rawRequest[key], kind);
    if (nested !== expected) {
      throw new JotformWebhookParseError(
        kind === 'form' ? 'INVALID_FORM_ID' : 'INVALID_SUBMISSION_ID',
        `rawRequest ${kind} identifier does not match the webhook envelope`,
      );
    }
  }
}

function fingerprintEnvelope(formId: string, submissionId: string): string {
  return createHash('sha256')
    .update('jotform-webhook-envelope:v1\0', 'utf8')
    .update(formId, 'utf8')
    .update('\0', 'utf8')
    .update(submissionId, 'utf8')
    .digest('hex');
}

/**
 * Extracts only the immutable Jotform envelope fields. Submitted answers and
 * rawRequest are validated when present but are never returned.
 */
export function parseJotformWebhookEnvelope(
  body: unknown,
): Readonly<JotformWebhookEnvelope> {
  if (!isRecord(body)) {
    throw new JotformWebhookParseError(
      'INVALID_BODY',
      'Webhook body must be an object',
    );
  }

  const formId = parseEnvelopeId(body.formID, 'form');
  const submissionId = parseEnvelopeId(body.submissionID, 'submission');

  if (Object.prototype.hasOwnProperty.call(body, 'rawRequest')) {
    const rawRequest = parseRawRequest(body.rawRequest);
    verifyNestedEnvelopeId(rawRequest, ['formID', 'formId'], formId, 'form');
    verifyNestedEnvelopeId(
      rawRequest,
      ['submissionID', 'submissionId', 'submission_id'],
      submissionId,
      'submission',
    );
  }

  return Object.freeze({
    formId,
    submissionId,
    fingerprint: fingerprintEnvelope(formId, submissionId),
  });
}

function digestSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Verifies a supplied webhook secret against both rotation slots. Hashing
 * first keeps timingSafeEqual inputs fixed-width even when string lengths vary.
 */
export function verifyJotformWebhookSecret(
  candidate: unknown,
  currentSecret: string | null | undefined,
  previousSecret?: string | null,
): boolean {
  const candidateIsUsable =
    typeof candidate === 'string' && candidate.length <= 4_096;
  const candidateDigest = digestSecret(
    candidateIsUsable ? candidate : '__invalid_jotform_webhook_secret__',
  );
  const dummyDigest = digestSecret('__unconfigured_jotform_webhook_secret__');

  const currentIsConfigured =
    typeof currentSecret === 'string' && currentSecret.length > 0;
  const previousIsConfigured =
    typeof previousSecret === 'string' && previousSecret.length > 0;
  const currentDigest = currentIsConfigured
    ? digestSecret(currentSecret)
    : dummyDigest;
  const previousDigest = previousIsConfigured
    ? digestSecret(previousSecret)
    : dummyDigest;

  const currentMatch = timingSafeEqual(candidateDigest, currentDigest);
  const previousMatch = timingSafeEqual(candidateDigest, previousDigest);

  return (
    candidateIsUsable &&
    ((currentIsConfigured && currentMatch) ||
      (previousIsConfigured && previousMatch))
  );
}
