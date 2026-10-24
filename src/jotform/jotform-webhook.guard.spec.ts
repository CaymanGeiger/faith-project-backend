import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { JotformConfig } from './jotform.config';
import { JotformWebhookGuard } from './jotform-webhook.guard';

const CURRENT_SECRET = `current-${'c'.repeat(32)}`;
const PREVIOUS_SECRET = `previous-${'p'.repeat(32)}`;

describe('JotformWebhookGuard', () => {
  const enabledConfig = {
    enabled: true,
    webhookSecret: CURRENT_SECRET,
    previousWebhookSecret: PREVIOUS_SECRET,
  } as Readonly<JotformConfig>;

  it('accepts strict Basic authentication for the current secret', () => {
    const guard = new JotformWebhookGuard(enabledConfig);
    const authorization = `Basic ${Buffer.from(
      `jotform:${CURRENT_SECRET}`,
      'utf8',
    ).toString('base64')}`;

    expect(guard.canActivate(context({ authorization }))).toBe(true);
  });

  it('accepts the previous secret during rotation', () => {
    const guard = new JotformWebhookGuard(enabledConfig);
    const authorization = `Basic ${Buffer.from(
      `jotform:${PREVIOUS_SECRET}`,
      'utf8',
    ).toString('base64')}`;

    expect(guard.canActivate(context({ authorization }))).toBe(true);
  });

  it('accepts a single workflow secret header', () => {
    const guard = new JotformWebhookGuard(enabledConfig);

    expect(
      guard.canActivate(
        context({ 'x-jotform-webhook-secret': CURRENT_SECRET }),
      ),
    ).toBe(true);
  });

  it.each([
    ['missing credentials', {}],
    ['wrong Basic username', basicHeaders(`operator:${CURRENT_SECRET}`)],
    ['wrong Basic password', basicHeaders('jotform:wrong-secret')],
    ['non-Basic authorization', { authorization: `Bearer ${CURRENT_SECRET}` }],
    ['malformed Base64', { authorization: 'Basic abcde' }],
    [
      'multiple workflow headers',
      { 'x-jotform-webhook-secret': [CURRENT_SECRET, PREVIOUS_SECRET] },
    ],
  ])('hides the endpoint for %s', (_label, headers) => {
    const guard = new JotformWebhookGuard(enabledConfig);

    expect(() => guard.canActivate(context(headers))).toThrow(
      NotFoundException,
    );
  });

  it('rejects otherwise valid credentials when the integration is disabled', () => {
    const guard = new JotformWebhookGuard({
      ...enabledConfig,
      enabled: false,
    });

    expect(() =>
      guard.canActivate(
        context({ 'x-jotform-webhook-secret': CURRENT_SECRET }),
      ),
    ).toThrow(NotFoundException);
  });

  it.each([
    ['missing length', ''],
    ['invalid length', 'chunked'],
    ['oversized body', '2500001'],
  ])('rejects an authenticated webhook with %s', (_label, contentLength) => {
    const guard = new JotformWebhookGuard(enabledConfig);

    expect(() =>
      guard.canActivate(
        context({
          'x-jotform-webhook-secret': CURRENT_SECRET,
          'content-length': contentLength,
        }),
      ),
    ).toThrow();
  });
});

function basicHeaders(credentials: string) {
  return {
    authorization: `Basic ${Buffer.from(credentials, 'utf8').toString(
      'base64',
    )}`,
  };
}

function context(headers: Record<string, string | string[]>) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'content-length': '512', ...headers } }),
    }),
  } as unknown as ExecutionContext;
}
