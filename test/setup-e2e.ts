// Runs before importing AppModule in every E2E file. Never load customer data
// or start real email, push or Jotform workers from the acceptance suite.
const database = new URL(process.env.DATABASE_URL ?? 'http://missing');
if (
  process.env.RELEASE_TEST_DATABASE !== 'true' ||
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  !database.pathname.endsWith('_release_test')
) {
  throw new Error(
    'E2E requires RELEASE_TEST_DATABASE=true and a dedicated loopback *_release_test database.',
  );
}
process.env.NODE_ENV = 'test';
delete process.env.APP_ENV;
process.env.JOTFORM_INTEGRATION_ENABLED = 'false';
process.env.JOTFORM_ONBOARDING_ENABLED = 'false';
process.env.PUSH_NOTIFICATIONS_ENABLED = 'false';
process.env.SMTP_HOST = '';
process.env.OPERATIONS_WEBHOOK_URL = '';
process.env.JWT_SECRET = 'isolated-release-test-secret-never-deploy';
