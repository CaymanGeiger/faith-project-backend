import { loadHttpRuntimeConfiguration } from './http-runtime';
import { isProductionLikeRuntime } from './runtime';

describe('HTTP deployment startup configuration', () => {
  const preview = {
    NODE_ENV: 'production',
    APP_ENV: 'preview',
    CORS_ORIGIN: 'https://preview.example.com',
  };
  it('permits missing business operations configuration only in explicit hosted preview', () => {
    expect(loadHttpRuntimeConfiguration(preview)).toEqual({
      corsOrigins: ['https://preview.example.com'],
    });
    expect(isProductionLikeRuntime(preview)).toBe(true);
  });
  it.each(['production', 'development', 'staging', '', undefined])(
    'requires moderation terms for deployment %s on a production runtime',
    (deployment) => {
      expect(() =>
        loadHttpRuntimeConfiguration({ ...preview, APP_ENV: deployment }),
      ).toThrow('MESSAGE_BLOCKED_TERMS');
    },
  );
  it.each(['production', undefined])(
    'requires a webhook in deployment %s once terms are configured',
    (deployment) => {
      expect(() =>
        loadHttpRuntimeConfiguration({
          ...preview,
          APP_ENV: deployment,
          MESSAGE_BLOCKED_TERMS: 'approved policy term',
        }),
      ).toThrow('OPERATIONS_WEBHOOK_URL');
    },
  );
  it.each([
    '',
    'http://preview.example.com',
    'https://preview.example.com,http://localhost',
  ])('retains strict preview CORS for %s', (origin) => {
    expect(() =>
      loadHttpRuntimeConfiguration({ ...preview, CORS_ORIGIN: origin }),
    ).toThrow('CORS_ORIGIN');
  });
  it.each(['not-a-url', 'http://operations.example.com/hook'])(
    'rejects an invalid configured preview webhook %s',
    (webhook) => {
      expect(() =>
        loadHttpRuntimeConfiguration({
          ...preview,
          OPERATIONS_WEBHOOK_URL: webhook,
        }),
      ).toThrow('OPERATIONS_WEBHOOK_URL');
    },
  );
  it('continues accepting fully configured production', () => {
    expect(
      loadHttpRuntimeConfiguration({
        ...preview,
        APP_ENV: 'production',
        MESSAGE_BLOCKED_TERMS: 'approved policy term',
        OPERATIONS_WEBHOOK_URL: 'https://operations.example.com/hook',
      }),
    ).toEqual({ corsOrigins: ['https://preview.example.com'] });
  });
});
