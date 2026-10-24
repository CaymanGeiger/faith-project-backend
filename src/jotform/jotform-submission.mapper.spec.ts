import {
  JotformCanonicalSubmissionError,
  mapCanonicalJotformSubmission,
} from './jotform-submission.mapper';

const mapping = {
  emailQuestionId: '13',
  companyQuestionId: '14',
  nameQuestionId: '4',
  dealerNumberQuestionId: '20',
};

describe('mapCanonicalJotformSubmission', () => {
  it('keeps large identifiers as strings and extracts configured fields', () => {
    const result = mapCanonicalJotformSubmission(
      submission({
        id: '6097407143436278355',
        answers: {
          '20': { type: 'control_textbox', answer: 'LG-10001' },
          '14': { type: 'control_textbox', answer: ' Example HVAC ' },
          '13': { type: 'control_email', answer: ' Dealer@Example.COM ' },
          '4': {
            type: 'control_fullname',
            answer: { first: 'Ada', last: 'Dealer' },
          },
        },
      }),
      mapping,
    );

    expect(result).toMatchObject({
      submissionId: '6097407143436278355',
      formId: '252405795315055',
      respondentEmail: 'dealer@example.com',
      companyName: 'Example HVAC',
      dealerNumber: 'LG-10001',
    });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not depend on answer ordering when calculating its digest', () => {
    const first = mapCanonicalJotformSubmission(
      submission({
        answers: orderedAnswers(['13', '14', '4', '20']),
      }),
      mapping,
    );
    const second = mapCanonicalJotformSubmission(
      submission({
        answers: orderedAnswers(['20', '4', '14', '13']),
      }),
      mapping,
    );

    expect(first.contentHash).toBe(second.contentHash);
  });

  it('accepts a real leap-day timestamp', () => {
    const result = mapCanonicalJotformSubmission(
      submission({
        created_at: '2028-02-29 23:59:58',
        updated_at: '2028-02-29 23:59:59',
      }),
      mapping,
    );

    expect(result.vendorCreatedAt).toBe('2028-02-29 23:59:58');
    expect(result.vendorUpdatedAt).toBe('2028-02-29 23:59:59');
  });

  it.each([
    ['created_at', '2026-02-29 12:00:00', 'INVALID_CREATED_AT'],
    ['updated_at', '2026-02-30 12:00:00', 'INVALID_UPDATED_AT'],
    ['updated_at', '2026-13-01 12:00:00', 'INVALID_UPDATED_AT'],
    ['updated_at', '2026-01-01 24:00:00', 'INVALID_UPDATED_AT'],
  ])(
    'rejects an impossible %s calendar timestamp',
    (field, timestamp, code) => {
      expectCanonicalError(
        () =>
          mapCanonicalJotformSubmission(
            submission({ [field]: timestamp }),
            mapping,
          ),
        code,
      );
    },
  );

  it('rejects a missing configured question instead of silently accepting QID drift', () => {
    expectCanonicalError(
      () =>
        mapCanonicalJotformSubmission(
          submission({
            answers: {
              '14': { type: 'control_textbox', answer: 'Example HVAC' },
              '4': { type: 'control_fullname', answer: {} },
              '20': { type: 'control_textbox', answer: '' },
            },
          }),
          mapping,
        ),
      'EMAIL_QUESTION_TYPE_MISMATCH',
    );
  });

  it.each([null, '', '   '])(
    'rejects a missing required email answer represented as %p',
    (answer) => {
      expectCanonicalError(
        () =>
          mapCanonicalJotformSubmission(
            submission({
              answers: {
                ...orderedAnswers(['13', '14', '4', '20']),
                '13': { type: 'control_email', answer },
              },
            }),
            mapping,
          ),
        'MISSING_EMAIL_ANSWER',
      );
    },
  );

  it.each([
    ['13', 'control_textbox', 'EMAIL_QUESTION_TYPE_MISMATCH'],
    ['14', 'control_email', 'COMPANY_QUESTION_TYPE_MISMATCH'],
    ['4', 'control_textbox', 'NAME_QUESTION_TYPE_MISMATCH'],
    ['20', 'control_number', 'DEALER_NUMBER_QUESTION_TYPE_MISMATCH'],
  ])(
    'rejects configured QID %s when its form control type drifts',
    (questionId, type, code) => {
      const answers = orderedAnswers(['13', '14', '4', '20']);
      answers[questionId] = { ...answers[questionId], type };

      expectCanonicalError(
        () => mapCanonicalJotformSubmission(submission({ answers }), mapping),
        code,
      );
    },
  );

  it.each<[Record<string, unknown>, string]>([
    [{ id: 6097407143436278000 }, 'INVALID_SUBMISSION_ID'],
    [{ form_id: 'wrong' }, 'INVALID_FORM_ID'],
    [{ updated_at: '2026-09-06T12:00:00Z' }, 'INVALID_UPDATED_AT'],
    [{ answers: [] }, 'INVALID_ANSWERS'],
    [
      {
        answers: {
          ...orderedAnswers(['13', '14', '4', '20']),
          '13': { type: 'control_email', answer: 'not-an-email' },
        },
      },
      'INVALID_EMAIL_ANSWER',
    ],
  ])('rejects invalid canonical data without echoing it', (override, code) => {
    expectCanonicalError(
      () => mapCanonicalJotformSubmission(submission(override), mapping),
      code,
    );
    try {
      mapCanonicalJotformSubmission(submission(override), mapping);
    } catch (error) {
      expect(error).toBeInstanceOf(JotformCanonicalSubmissionError);
      expect((error as Error).message).not.toContain('not-an-email');
    }
  });
});

function expectCanonicalError(operation: () => unknown, code: string) {
  let caught: unknown;
  try {
    operation();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(JotformCanonicalSubmissionError);
  expect((caught as JotformCanonicalSubmissionError).code).toBe(code);
}

function submission(override: Record<string, unknown> = {}) {
  return {
    id: '6097407143436278355',
    form_id: '252405795315055',
    created_at: '2026-09-06 12:00:00',
    updated_at: '2026-09-06 12:01:00',
    status: 'ACTIVE',
    answers: orderedAnswers(['13', '14', '4', '20']),
    ...override,
  };
}

function orderedAnswers(questionIds: string[]) {
  const answers: Record<string, Record<string, unknown>> = {
    '13': { type: 'control_email', answer: 'a@b.com' },
    '14': { type: 'control_textbox', answer: 'A' },
    '4': {
      type: 'control_fullname',
      answer: { first: 'Ada', last: 'Dealer' },
    },
    '20': { type: 'control_textbox', answer: '' },
  };
  return Object.fromEntries(questionIds.map((id) => [id, answers[id]]));
}
