import { createHash } from 'node:crypto';

const VENDOR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_QUESTION_TYPES = new Set(['control_email']);
const COMPANY_QUESTION_TYPES = new Set(['control_textbox']);
const NAME_QUESTION_TYPES = new Set(['control_fullname']);
const DEALER_NUMBER_QUESTION_TYPES = new Set(['control_textbox']);

export type JotformFieldMapping = {
  emailQuestionId: string;
  companyQuestionId: string;
  nameQuestionId: string;
  dealerNumberQuestionId?: string;
};

export type CanonicalJotformSubmission = {
  submissionId: string;
  formId: string;
  vendorCreatedAt: string;
  vendorUpdatedAt: string;
  vendorStatus: string;
  workflowStatus: string | null;
  contentHash: string;
  respondentEmail: string | null;
  companyName: string | null;
  dealerNumber: string | null;
};

export class JotformCanonicalSubmissionError extends Error {
  constructor(public readonly code: string) {
    super('Jotform returned an invalid submission payload');
    this.name = 'JotformCanonicalSubmissionError';
  }
}

/**
 * Validates the API-authenticated Jotform record and extracts only the fields
 * needed by this integration. The complete answers and applicant IP are never
 * retained; a one-way digest is stored for change detection instead.
 */
export function mapCanonicalJotformSubmission(
  input: unknown,
  fields: JotformFieldMapping,
): CanonicalJotformSubmission {
  const record = requireRecord(input, 'INVALID_SUBMISSION');
  const submissionId = requireDigitString(record.id, 'INVALID_SUBMISSION_ID');
  const formId = requireDigitString(record.form_id, 'INVALID_FORM_ID');
  const vendorCreatedAt = requireTimestamp(
    record.created_at,
    'INVALID_CREATED_AT',
  );
  const vendorUpdatedAt = requireTimestamp(
    record.updated_at,
    'INVALID_UPDATED_AT',
  );
  const vendorStatus = optionalBoundedString(record.status, 64) ?? 'UNKNOWN';
  const workflowStatus = optionalBoundedString(record.workflowStatus, 160);
  const answers = requireRecord(record.answers, 'INVALID_ANSWERS');

  const emailAnswer = requireTypedAnswerRecord(
    answers,
    fields.emailQuestionId,
    EMAIL_QUESTION_TYPES,
    'EMAIL_QUESTION_TYPE_MISMATCH',
  );
  const companyAnswer = requireTypedAnswerRecord(
    answers,
    fields.companyQuestionId,
    COMPANY_QUESTION_TYPES,
    'COMPANY_QUESTION_TYPE_MISMATCH',
  );
  // The applicant name is deliberately not retained, but validating its
  // configured QID/type prevents a silently repurposed field from being
  // treated as the current registration form.
  requireTypedAnswerRecord(
    answers,
    fields.nameQuestionId,
    NAME_QUESTION_TYPES,
    'NAME_QUESTION_TYPE_MISMATCH',
  );
  const respondentEmail = normalizeEmail(readStringAnswer(emailAnswer, 320));
  const companyName = readStringAnswer(companyAnswer, 300);
  const dealerNumber = fields.dealerNumberQuestionId
    ? readStringAnswer(
        requireTypedAnswerRecord(
          answers,
          fields.dealerNumberQuestionId,
          DEALER_NUMBER_QUESTION_TYPES,
          'DEALER_NUMBER_QUESTION_TYPE_MISMATCH',
        ),
        128,
      )
    : null;

  return {
    submissionId,
    formId,
    vendorCreatedAt,
    vendorUpdatedAt,
    vendorStatus,
    workflowStatus,
    contentHash: createHash('sha256')
      .update(stableSerialize(record))
      .digest('hex'),
    respondentEmail,
    companyName,
    dealerNumber,
  };
}

function requireTypedAnswerRecord(
  answers: Record<string, unknown>,
  questionId: string,
  allowedTypes: ReadonlySet<string>,
  mismatchCode: string,
): Record<string, unknown> {
  const answerRecord = answers[questionId];
  if (answerRecord === undefined || answerRecord === null) {
    throw new JotformCanonicalSubmissionError(mismatchCode);
  }
  const record = requireRecord(answerRecord, 'INVALID_ANSWER_RECORD');
  if (typeof record.type !== 'string' || !allowedTypes.has(record.type)) {
    throw new JotformCanonicalSubmissionError(mismatchCode);
  }
  return record;
}

function readStringAnswer(
  answerRecord: Record<string, unknown>,
  maxLength: number,
) {
  const answer = answerRecord.answer;
  if (answer === undefined || answer === null || answer === '') {
    return null;
  }
  if (typeof answer !== 'string') {
    throw new JotformCanonicalSubmissionError('INVALID_ANSWER_VALUE');
  }
  const value = answer.trim();
  if (!value) {
    return null;
  }
  if (value.length > maxLength) {
    throw new JotformCanonicalSubmissionError('ANSWER_VALUE_TOO_LONG');
  }
  return value;
}

function normalizeEmail(value: string | null) {
  if (value === null) {
    throw new JotformCanonicalSubmissionError('MISSING_EMAIL_ANSWER');
  }
  const normalized = value.toLowerCase();
  if (!EMAIL.test(normalized)) {
    throw new JotformCanonicalSubmissionError('INVALID_EMAIL_ANSWER');
  }
  return normalized;
}

function requireTimestamp(value: unknown, code: string) {
  if (typeof value !== 'string') {
    throw new JotformCanonicalSubmissionError(code);
  }

  const match = VENDOR_TIMESTAMP.exec(value);
  if (!match) {
    throw new JotformCanonicalSubmissionError(code);
  }

  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(0);
  parsed.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  parsed.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second)
  ) {
    throw new JotformCanonicalSubmissionError(code);
  }

  return value;
}

function requireDigitString(value: unknown, code: string) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    !/^\d+$/.test(value)
  ) {
    throw new JotformCanonicalSubmissionError(code);
  }
  return value;
}

function optionalBoundedString(value: unknown, maxLength: number) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new JotformCanonicalSubmissionError('INVALID_STRING_FIELD');
  }
  return value;
}

function requireRecord(value: unknown, code: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JotformCanonicalSubmissionError(code);
  }
  return value as Record<string, unknown>;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}
