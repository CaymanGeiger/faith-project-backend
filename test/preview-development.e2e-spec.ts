/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { preparePreviewFixtures } from '../src/config/preview-fixtures';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Hosted preview development features', () => {
  let app: INestApplication<App>;
  let db: PrismaService;
  const ids: string[] = [];
  const keys = [
    'NODE_ENV',
    'APP_ENV',
    'DEV_FEATURES_ENABLED',
    'DEV_TRAINING_TOGGLE_ENABLED',
    'ALLOW_PREVIEW_FIXTURES',
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'preview';
    process.env.DEV_FEATURES_ENABLED = 'true';
    process.env.DEV_TRAINING_TOGGLE_ENABLED = 'true';
    process.env.ALLOW_PREVIEW_FIXTURES = 'true';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    db = app.get(PrismaService);
  });
  afterAll(async () => {
    if (db) {
      const conversations = await db.conversationParticipant.findMany({
        where: { userId: { in: ids } },
        select: { conversationId: true },
      });
      await db.conversation.deleteMany({
        where: { id: { in: conversations.map((item) => item.conversationId) } },
      });
      await db.user.deleteMany({
        where: { id: { in: ids }, role: 'PROSPECT' },
      });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    }
    await app?.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('prepares only synthetic fixtures, permits preview logins/training, and blocks real accounts and production', async () => {
    const existing = await db.user.count({
      where: {
        email: { in: ['manager@hercules.local', 'prospect@hercules.local'] },
      },
    });
    expect(existing).toBe(0);
    const real = await db.user.create({
      data: {
        email: `preview-control-${randomUUID()}@example.com`,
        firstName: 'Real',
        lastName: 'Account',
        passwordHash: 'unusable-test-hash',
        role: 'PROSPECT',
        onboardingRequired: true,
      },
    });
    ids.push(real.id);
    const before = await db.user.findUniqueOrThrow({ where: { id: real.id } });
    const prepared = await preparePreviewFixtures(db);
    expect(prepared).toMatchObject({ prepared: true, trainingRequired: true });
    const fixtures = await db.user.findMany({
      where: { email: { in: prepared.accounts } },
    });
    ids.push(...fixtures.map((user) => user.id));
    expect(fixtures).toHaveLength(2);
    expect(await preparePreviewFixtures(db)).toEqual(prepared);
    expect(await db.user.count({ where: { id: { in: ids } } })).toBe(3);
    expect(
      await db.todoItem.count({ where: { prospectUserId: { in: ids } } }),
    ).toBe(4);
    expect(
      await db.conversation.count({
        where: { participants: { some: { userId: { in: ids } } } },
      }),
    ).toBe(1);
    expect(await db.user.findUniqueOrThrow({ where: { id: real.id } })).toEqual(
      before,
    );
    const api = () => request(app.getHttpServer());
    const dealerLogin = await api()
      .post('/auth/login')
      .send({ email: 'prospect@hercules.local', password: 'password123' })
      .expect(201);
    const managerLogin = await api()
      .post('/auth/login')
      .send({ email: 'manager@hercules.local', password: 'password123' })
      .expect(201);
    const dealerAuth = {
      Authorization: `Bearer ${dealerLogin.body.accessToken}`,
    };
    const managerAuth = {
      Authorization: `Bearer ${managerLogin.body.accessToken}`,
    };
    await api()
      .post('/me/account-deletion-request')
      .set(managerAuth)
      .expect(503);
    await api()
      .post('/account-deletion-requests')
      .send({ email: real.email })
      .expect(503);
    expect(
      await db.accountDeletionRequest.count({ where: { userId: { in: ids } } }),
    ).toBe(0);
    expect(dealerLogin.body.user.onboarding.restricted).toBe(true);
    const route = '/onboarding/development/training';
    await api()
      .patch(route)
      .set(managerAuth)
      .send({ completed: true })
      .expect(403);
    const realToken = await app
      .get(JwtService)
      .signAsync({ sub: real.id, sv: 0 });
    await api()
      .patch(route)
      .set({ Authorization: `Bearer ${realToken}` })
      .send({ completed: true })
      .expect(404);
    await api()
      .patch(route)
      .set(dealerAuth)
      .send({ completed: true })
      .expect(200);
    await api().get('/resources').set(dealerAuth).expect(200);
    await api()
      .patch(route)
      .set(dealerAuth)
      .send({ completed: false })
      .expect(200);
    await api().get('/resources').set(dealerAuth).expect(403);
    for (const deployment of ['production', undefined]) {
      if (deployment === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = deployment;
      await api()
        .patch(route)
        .set(dealerAuth)
        .send({ completed: true })
        .expect(404);
      await api().get('/auth/me').set(dealerAuth).expect(401);
      await api()
        .post('/auth/login')
        .send({ email: 'prospect@hercules.local', password: 'password123' })
        .expect(401);
    }
    process.env.APP_ENV = 'preview';
    const dealer = fixtures.find((user) => user.role === 'PROSPECT')!;
    const manager = fixtures.find((user) => user.role === 'SALES_MANAGER')!;
    await db.initialTrainingVerification.create({
      data: {
        prospectUserId: dealer.id,
        verifiedByUserId: manager.id,
        completedAt: new Date(),
        source: 'VERIFIED_EVIDENCE',
        reference: 'genuine-test-evidence',
      },
    });
    const managerBefore = await db.user.findUniqueOrThrow({
      where: { id: manager.id },
    });
    await expect(preparePreviewFixtures(db)).rejects.toThrow(
      'non-fixture account or training evidence',
    );
    expect(
      await db.user.findUniqueOrThrow({ where: { id: manager.id } }),
    ).toEqual(managerBefore);
    await api()
      .patch(route)
      .set(dealerAuth)
      .send({ completed: false })
      .expect(409);
    const deletion = await api()
      .post('/me/account-deletion-request')
      .set({ Authorization: `Bearer ${realToken}` })
      .expect(201);
    expect(deletion.body.completed).toBe(true);
  });
});
