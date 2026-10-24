// Disposable local browser verification; never connects to a customer database or email provider.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AccountSecurityService } from '../src/auth/account-security.service';
import { SecurityMailService } from '../src/auth/security-mail.service';
import { JotformApiClient } from '../src/jotform/jotform-api.client';
import { loadJotformConfig } from '../src/jotform/jotform.config';
import { JotformSyncService } from '../src/jotform/jotform-sync.service';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('UI harness requires NODE_ENV=test.');
  const database = new URL(process.env.DATABASE_URL ?? 'http://missing');
  if (
    database.hostname !== '127.0.0.1' ||
    database.port !== '55439' ||
    database.pathname !== '/hercules_ui_release_test'
  )
    throw new Error(
      'UI harness requires the dedicated local browser-test database.',
    );
  for (const key of [
    'JOTFORM_INTEGRATION_ENABLED',
    'PUSH_NOTIFICATIONS_ENABLED',
  ])
    process.env[key] = 'false';
  for (const key of [
    'SMTP_HOST',
    'OPERATIONS_WEBHOOK_URL',
    'SYNCHRONY_FINANCING_URL',
    'SYNCHRONY_FINANCING_DESCRIPTION',
  ])
    process.env[key] = '';
  process.env.JOTFORM_ONBOARDING_ENABLED = 'true';
  const output = resolve(
    __dirname,
    '../../audit-output/hercules-implementation',
  );
  mkdirSync(output, { recursive: true });
  const delivered: { email: string; code: string; purpose: string }[] = [];
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SecurityMailService)
    .useValue({
      assertConfigured() {},
      sendCode(email: string, code: string, purpose: string) {
        delivered.push({ email, code, purpose });
        writeFileSync(
          resolve(output, 'synthetic-mail.json'),
          JSON.stringify(delivered, null, 2),
        );
        return Promise.resolve();
      },
    })
    .compile();
  const app = module.createNestApplication();
  app.enableCors({
    origin: ['http://localhost:8087', 'http://127.0.0.1:8087'],
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const db = app.get(PrismaService);
  const manager = await db.user.findUniqueOrThrow({
    where: { email: 'manager@hercules.local' },
  });
  const prospect = await db.$transaction(async (tx) => {
    const fixture = await tx.user.findUniqueOrThrow({
      where: { email: 'prospect@hercules.local' },
    });
    await tx.initialTrainingVerification.deleteMany({
      where: { prospectUserId: fixture.id },
    });
    return tx.user.update({
      where: { id: fixture.id },
      data: { onboardingRequired: true, initialTrainingVerifiedAt: null },
    });
  });
  process.env.ONBOARDING_VERIFIER_MANAGER_IDS = manager.id;
  process.env.JOTFORM_ONBOARDING_MANAGER_ID = manager.id;
  const formId = '202610200001';
  const submissionId = '202610200002';
  const vendor = {
    getSubmission: () =>
      Promise.resolve({
        content: {
          id: submissionId,
          form_id: formId,
          status: 'ACTIVE',
          created_at: '2026-10-19 12:00:00',
          updated_at: '2026-10-19 12:00:00',
          answers: {
            '4': {
              type: 'control_fullname',
              answer: { first: 'Synthetic', last: 'Dealer' },
            },
            '13': {
              type: 'control_email',
              answer: 'activation@hercules.example',
            },
            '14': {
              type: 'control_textbox',
              answer: 'Synthetic Activation Company',
            },
          },
        },
        limitLeft: 10000,
      }),
  };
  const sync = new JotformSyncService(
    db,
    {
      ...loadJotformConfig({ JOTFORM_INTEGRATION_ENABLED: 'false' }),
      enabled: true,
      formId,
    },
    vendor as unknown as JotformApiClient,
  );
  sync.disableBackgroundProcessing();
  await sync.acceptWebhook({
    formId,
    submissionId,
    fingerprint: 'local-ui-fixture',
  });
  const imported = await sync.processDue();
  const pending = await db.user.findUnique({
    where: { email: 'activation@hercules.example' },
  });
  writeFileSync(
    resolve(output, 'ui-fixture.json'),
    JSON.stringify(
      {
        managerId: manager.id,
        prospectId: prospect.id,
        pendingId: pending?.id,
        imported,
        database: database.pathname,
        externalDelivery: false,
      },
      null,
      2,
    ),
  );
  await app.listen(3007, '127.0.0.1');
  const timer = setInterval(
    () => void app.get(AccountSecurityService).deliverPendingMail(),
    500,
  );
  const close = async () => {
    clearInterval(timer);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
  console.log(
    'Synthetic Hercules browser API listening on http://127.0.0.1:3007',
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
