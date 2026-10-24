import {
  JotformWebhookParseError,
  MAX_JOTFORM_ENVELOPE_ID_LENGTH,
  MAX_JOTFORM_RAW_REQUEST_BYTES,
  parseJotformWebhookEnvelope,
  verifyJotformWebhookSecret,
} from './jotform-webhook.parser';

function captureParseError(operation: () => unknown): JotformWebhookParseError {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof JotformWebhookParseError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected webhook parsing to fail');
}

describe('parseJotformWebhookEnvelope', () => {
  const baseBody = {
    formID: '252405795315055',
    submissionID: '6190123456789012345',
  };

  it('returns only PII-free immutable envelope data', () => {
    const envelope = parseJotformWebhookEnvelope({
      ...baseBody,
      email: 'private@example.com',
      name: 'Private Person',
      rawRequest: JSON.stringify({
        formID: baseBody.formID,
        submission_id: baseBody.submissionID,
        q13_email: 'private@example.com',
      }),
    });

    expect(envelope.formId).toBe(baseBody.formID);
    expect(envelope.submissionId).toBe(baseBody.submissionID);
    expect(envelope.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope).not.toHaveProperty('rawRequest');
    expect(envelope).not.toHaveProperty('email');
    expect(JSON.stringify(envelope)).not.toContain('private@example.com');
  });

  it('accepts an already-parsed rawRequest object', () => {
    expect(
      parseJotformWebhookEnvelope({
        ...baseBody,
        rawRequest: {
          formId: baseBody.formID,
          submissionID: baseBody.submissionID,
        },
      }),
    ).toMatchObject({
      formId: baseBody.formID,
      submissionId: baseBody.submissionID,
    });
  });

  it('accepts an envelope without rawRequest', () => {
    expect(parseJotformWebhookEnvelope(baseBody)).toMatchObject({
      formId: baseBody.formID,
      submissionId: baseBody.submissionID,
    });
  });

  it('preserves leading zeroes without numeric coercion', () => {
    const envelope = parseJotformWebhookEnvelope({
      formID: '000123',
      submissionID: '000456',
    });

    expect(envelope.formId).toBe('000123');
    expect(envelope.submissionId).toBe('000456');
  });

  it('computes a deterministic identifier-only fingerprint', () => {
    const first = parseJotformWebhookEnvelope({
      ...baseBody,
      privateAnswer: 'first secret answer',
    });
    const sameIdsDifferentAnswers = parseJotformWebhookEnvelope({
      ...baseBody,
      privateAnswer: 'second secret answer',
    });
    const differentSubmission = parseJotformWebhookEnvelope({
      ...baseBody,
      submissionID: '6190123456789012346',
    });

    expect(first.fingerprint).toBe(sameIdsDifferentAnswers.fingerprint);
    expect(first.fingerprint).not.toBe(differentSubmission.fingerprint);
  });

  it.each([null, undefined, [], 'body', 1, true])(
    'rejects non-object body %#',
    (body) => {
      expect(() => parseJotformWebhookEnvelope(body)).toThrow(
        new JotformWebhookParseError(
          'INVALID_BODY',
          'Webhook body must be an object',
        ),
      );
    },
  );

  it.each([
    undefined,
    '',
    ' ',
    '12a',
    '-12',
    252405795315055,
    ['252405795315055'],
    { value: '252405795315055' },
    '1'.repeat(MAX_JOTFORM_ENVELOPE_ID_LENGTH + 1),
  ])('rejects unsafe formID value %#', (formID) => {
    expect(
      captureParseError(() =>
        parseJotformWebhookEnvelope({ ...baseBody, formID }),
      ).code,
    ).toBe('INVALID_FORM_ID');
  });

  it.each([
    undefined,
    '',
    '1.2',
    6190123456789012345n,
    123,
    ['123'],
    { value: '123' },
    '9'.repeat(MAX_JOTFORM_ENVELOPE_ID_LENGTH + 1),
  ])('rejects unsafe submissionID value %#', (submissionID) => {
    expect(
      captureParseError(() =>
        parseJotformWebhookEnvelope({ ...baseBody, submissionID }),
      ).code,
    ).toBe('INVALID_SUBMISSION_ID');
  });

  it.each(['', 'not json', 'null', '[]', 'true', 123, null, []])(
    'rejects rawRequest that is not a JSON object %#',
    (rawRequest) => {
      expect(
        captureParseError(() =>
          parseJotformWebhookEnvelope({ ...baseBody, rawRequest }),
        ).code,
      ).toBe('INVALID_RAW_REQUEST');
    },
  );

  it('rejects an oversized rawRequest before parsing it', () => {
    const oversized = `{"answer":"${'x'.repeat(MAX_JOTFORM_RAW_REQUEST_BYTES)}"}`;

    expect(() =>
      parseJotformWebhookEnvelope({ ...baseBody, rawRequest: oversized }),
    ).toThrow(
      new JotformWebhookParseError(
        'INVALID_RAW_REQUEST',
        'rawRequest exceeds the permitted size',
      ),
    );
  });

  it.each([
    { rawRequest: { formID: '999' }, code: 'INVALID_FORM_ID' },
    {
      rawRequest: { submission_id: '999' },
      code: 'INVALID_SUBMISSION_ID',
    },
    { rawRequest: { formID: [baseBody.formID] }, code: 'INVALID_FORM_ID' },
  ])(
    'rejects a mismatched or malformed nested envelope ID',
    ({ rawRequest, code }) => {
      expect(
        captureParseError(() =>
          parseJotformWebhookEnvelope({ ...baseBody, rawRequest }),
        ).code,
      ).toBe(code);
    },
  );
});

describe('verifyJotformWebhookSecret', () => {
  const current = `current-${'c'.repeat(32)}`;
  const previous = `previous-${'p'.repeat(32)}`;

  it('accepts the current secret', () => {
    expect(verifyJotformWebhookSecret(current, current, previous)).toBe(true);
  });

  it('accepts the previous secret during rotation', () => {
    expect(verifyJotformWebhookSecret(previous, current, previous)).toBe(true);
  });

  it.each([
    'wrong-secret',
    `${current} `,
    current.toUpperCase(),
    '',
    undefined,
    null,
    [current],
    { secret: current },
    'x'.repeat(4_097),
  ])('rejects an invalid candidate %#', (candidate) => {
    expect(verifyJotformWebhookSecret(candidate, current, previous)).toBe(
      false,
    );
  });

  it('never accepts a candidate when no current secret is configured', () => {
    expect(verifyJotformWebhookSecret('', null)).toBe(false);
    expect(
      verifyJotformWebhookSecret(
        '__unconfigured_jotform_webhook_secret__',
        undefined,
      ),
    ).toBe(false);
  });
});
