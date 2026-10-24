import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SecurityMailService } from '../src/auth/security-mail.service';
import { AccountSecurityService } from '../src/auth/account-security.service';
import { hashInviteToken } from '../src/auth/invite-token';
import { MessagingService } from '../src/messaging/messaging.service';
import type { Server } from 'node:http';

type Auth = { accessToken: string; user: { id: string; email: string } };
describe('release acceptance with PostgreSQL', () => {
  let app: INestApplication<App>;
  let db: PrismaService;
  let manager: Auth, dealer: Auth, other: Auth;
  let conversationId: string,
    futureId: string,
    pastId: string,
    canceledId: string;
  let equipmentId: string;
  const previousVerifiers = process.env.ONBOARDING_VERIFIER_MANAGER_IDS;
  const tag = `release-${randomUUID()}`;
  const email = (label: string) => `${label}@${tag}.example.com`;
  const password = 'Release-test-only-Password-927!';
  const mail = {
    assertConfigured: jest.fn(),
    sendCode: jest
      .fn<Promise<void>, [string, string, string]>()
      .mockResolvedValue(undefined),
  };
  const sockets: Socket[] = [];
  const auth = (user: Auth) => ({
    Authorization: `Bearer ${user.accessToken}`,
  });
  const api = () => request(app.getHttpServer());

  async function register(label: string, role: UserRole) {
    const token = randomUUID();
    await db.registrationInvite.create({
      data: {
        token: hashInviteToken(token),
        recipientEmail: email(label),
        roleToCreate: role,
        assignedSalesManagerId: manager?.user.id ?? 'bootstrap',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const response = await api()
      .post('/auth/register-from-invite')
      .send({
        accountType: role,
        token,
        email: email(label),
        password,
        firstName: label,
        lastName: 'Release test',
        companyName: 'Test company',
        termsAccepted: true,
      })
      .expect(201);
    return response.body as Auth;
  }
  async function connect(token: string) {
    const server = app.getHttpServer() as Server;
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing listener');
    const socket = io(`http://127.0.0.1:${address.port}/messaging`, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      autoConnect: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  }
  const ack = (socket: Socket, event: string, data: unknown) =>
    new Promise<{ ok: boolean }>((resolve, reject) => {
      socket
        .timeout(3000)
        .emit(event, data, (error: Error | null, result: { ok: boolean }) =>
          error ? reject(error) : resolve(result),
        );
    });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SecurityMailService)
      .useValue(mail)
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
    db = app.get(PrismaService);
    manager = await register('manager', UserRole.SALES_MANAGER);
    dealer = await register('dealer', UserRole.PROSPECT);
    other = await register('other', UserRole.PROSPECT);
    // This broad release suite exercises verified dealer features. The separate
    // Hercules acceptance suite covers restricted registration and activation.
    process.env.ONBOARDING_VERIFIER_MANAGER_IDS = manager.user.id;
    for (const account of [dealer, other]) {
      await api()
        .post(`/onboarding/prospects/${account.user.id}/training-verification`)
        .set(auth(manager))
        .send({
          completedAt: new Date(Date.now() - 3600000).toISOString(),
          source: 'Isolated release test training roster',
          reference: `${tag}:${account.user.id}`,
        })
        .expect(201);
    }
    const conversation = await db.conversationParticipant.findFirstOrThrow({
      where: { userId: dealer.user.id },
    });
    conversationId = conversation.conversationId;
  }, 30000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    if (db) {
      await db.jotformSubmission.deleteMany({ where: { formId: tag } });
      const users = await db.user.findMany({
        where: { email: { endsWith: `@${tag}.example.com` } },
        orderBy: { role: 'asc' },
      });
      await db.conversation.deleteMany({
        where: {
          participants: {
            some: { userId: { in: users.map((user) => user.id) } },
          },
        },
      });
      await db.registrationInvite.deleteMany({
        where: { recipientEmail: { endsWith: `@${tag}.example.com` } },
      });
      await db.user.deleteMany({
        where: {
          id: {
            in: users
              .filter((user) => user.role === 'PROSPECT')
              .map((user) => user.id),
          },
        },
      });
      await db.user.deleteMany({
        where: {
          id: {
            in: users
              .filter((user) => user.role === 'SALES_MANAGER')
              .map((user) => user.id),
          },
        },
      });
      await db.classSession.deleteMany({
        where: { title: { startsWith: tag } },
      });
      await db.accountDeletionRequest.deleteMany({
        where: { email: { endsWith: `@${tag}.example.com` } },
      });
    }
    await app?.close();
    if (previousVerifiers === undefined)
      delete process.env.ONBOARDING_VERIFIER_MANAGER_IDS;
    else process.env.ONBOARDING_VERIFIER_MANAGER_IDS = previousVerifiers;
  });

  it('reports database readiness and provisions a real new dealer with tasks and a manager chat', async () => {
    await api().get('/health/ready').expect(200).expect({ status: 'ready' });
    expect(
      await db.todoItem.count({ where: { prospectUserId: dealer.user.id } }),
    ).toBeGreaterThan(0);
    expect(
      await db.conversationParticipant.count({ where: { conversationId } }),
    ).toBe(2);
    await api().get('/me/equipment').set(auth(manager)).expect(403);
    await api()
      .patch('/me')
      .set(auth(dealer))
      .send({ email: email('bypass') })
      .expect(400);
  });

  it('filters unavailable training and preserves earned certification during repeat/additional selections', async () => {
    for (const kind of ['future', 'past', 'canceled']) {
      const startsAt = new Date(
        Date.now() + (kind === 'past' ? -86400000 : 86400000),
      );
      const row = await db.classSession.create({
        data: {
          title: `${tag}-${kind}`,
          description: 'Acceptance test',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3600000),
          virtualUrl: `https://example.com/${tag}/${kind}`,
          status: kind === 'canceled' ? 'CANCELED' : 'SCHEDULED',
        },
      });
      if (kind === 'future') futureId = row.id;
      else if (kind === 'past') pastId = row.id;
      else canceledId = row.id;
    }
    const response = await api().get('/classes').set(auth(dealer)).expect(200);
    const ids = (response.body as { classes: { id: string }[] }).classes.map(
      (row) => row.id,
    );
    expect(ids).toContain(futureId);
    expect(ids).not.toContain(pastId);
    expect(ids).not.toContain(canceledId);
    await api().post(`/classes/${pastId}/enroll`).set(auth(dealer)).expect(409);
    await api()
      .post(`/classes/${canceledId}/enroll`)
      .set(auth(dealer))
      .expect(409);
    await db.prospectProfile.update({
      where: { userId: dealer.user.id },
      data: { certificationStatus: 'CERTIFIED' },
    });
    await Promise.all([
      api().post(`/classes/${futureId}/enroll`).set(auth(dealer)).expect(201),
      api().post(`/classes/${futureId}/enroll`).set(auth(dealer)).expect(201),
    ]);
    expect(
      await db.classEnrollment.count({
        where: { prospectUserId: dealer.user.id, classSessionId: futureId },
      }),
    ).toBe(1);
    expect(
      (
        await db.prospectProfile.findUniqueOrThrow({
          where: { userId: dealer.user.id },
        })
      ).certificationStatus,
    ).toBe('CERTIFIED');
  });

  it('protects derived onboarding progress while allowing warranty confirmation', async () => {
    const todos = await db.todoItem.findMany({
      where: { prospectUserId: dealer.user.id },
    });
    for (const todo of todos) {
      if (todo.type === 'JB_WARRANTIES') {
        await api()
          .patch(`/me/todos/${todo.id}`)
          .set(auth(dealer))
          .send({ completed: true })
          .expect(200);
        expect(
          (
            await db.prospectProfile.findUniqueOrThrow({
              where: { userId: dealer.user.id },
            })
          ).jbWarrantiesCompletedAt,
        ).not.toBeNull();
        continue;
      }
      if (todo.type === 'RESOURCE_REVIEW') continue;
      for (const completed of [true, false]) {
        await api()
          .patch(`/me/todos/${todo.id}`)
          .set(auth(dealer))
          .send({ completed })
          .expect(400);
      }
      const unchanged = await db.todoItem.findUniqueOrThrow({
        where: { id: todo.id },
      });
      expect(unchanged.status).toBe(todo.status);
      expect(unchanged.completedAt).toEqual(todo.completedAt);
    }
  });

  it('keeps canceled training in history without reporting an active training selection', async () => {
    const pending = await register('pending-training', UserRole.PROSPECT);
    type TrainingStatusResponse = {
      summary: { trainingSelected: boolean; trainingCompleted: boolean };
    };
    await db.classEnrollment.create({
      data: {
        classSessionId: canceledId,
        prospectUserId: pending.user.id,
        status: 'ENROLLED',
      },
    });
    const response = await api()
      .get('/me/onboarding-status')
      .set(auth(pending))
      .expect(200);
    const initial = response.body as TrainingStatusResponse;
    expect(initial.summary.trainingSelected).toBe(false);
    expect(initial.summary.trainingCompleted).toBe(false);
    const history = await api().get('/classes').set(auth(pending)).expect(200);
    expect((history.body as { classes: unknown[] }).classes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: canceledId,
          status: 'CANCELED',
          enrollmentStatus: 'ENROLLED',
        }),
      ]),
    );
    await db.classEnrollment.update({
      where: {
        classSessionId_prospectUserId: {
          classSessionId: canceledId,
          prospectUserId: pending.user.id,
        },
      },
      data: { status: 'COMPLETED' },
    });
    const earned = await api()
      .get('/me/onboarding-status')
      .set(auth(pending))
      .expect(200);
    const completed = earned.body as TrainingStatusResponse;
    expect(completed.summary.trainingSelected).toBe(true);
    // A legacy completed enrollment alone cannot unlock or complete initial training.
    expect(completed.summary.trainingCompleted).toBe(false);
    await api()
      .post(`/onboarding/prospects/${pending.user.id}/training-verification`)
      .set(auth(manager))
      .send({
        completedAt: new Date(Date.now() - 3600000).toISOString(),
        source: 'Isolated external training roster',
        reference: `${tag}:external-completion`,
      })
      .expect(201);
    const verified = await api()
      .get('/me/onboarding-status')
      .set(auth(pending))
      .expect(200);
    expect(
      (verified.body as TrainingStatusResponse).summary.trainingCompleted,
    ).toBe(true);
  });

  it('saves equipment idempotently, allows owner corrections and denies another dealer', async () => {
    const data = {
      equipmentName: 'LG unit',
      modelNumber: 'MODEL',
      serialNumber: tag,
    };
    const results = await Promise.all([
      api().post('/me/equipment').set(auth(dealer)).send(data).expect(201),
      api().post('/me/equipment').set(auth(dealer)).send(data).expect(201),
    ]);
    equipmentId = (results[0].body as { equipment: { id: string } }).equipment
      .id;
    expect(
      (results[1].body as { equipment: { id: string } }).equipment.id,
    ).toBe(equipmentId);
    await api()
      .patch(`/me/equipment/${equipmentId}`)
      .set(auth(other))
      .send(data)
      .expect(404);
    await api()
      .patch(`/me/equipment/${equipmentId}`)
      .set(auth(dealer))
      .send({ ...data, modelNumber: 'CORRECTED' })
      .expect(200);
    expect(
      (
        await db.equipmentRegistration.findUniqueOrThrow({
          where: { id: equipmentId },
        })
      ).modelNumber,
    ).toBe('CORRECTED');
    expect(
      (
        await db.todoItem.findFirstOrThrow({
          where: {
            prospectUserId: dealer.user.id,
            type: 'EQUIPMENT_REGISTRATION',
          },
        })
      ).status,
    ).toBe('COMPLETED');
  });

  it('rolls back equipment and onboarding changes together when the second write fails', async () => {
    const todo = await db.todoItem.findFirstOrThrow({
      where: { prospectUserId: dealer.user.id, type: 'EQUIPMENT_REGISTRATION' },
    });
    await db.todoItem.update({
      where: { id: todo.id },
      data: {
        title: 'release-test-force-failure',
        status: 'OPEN',
        completedAt: null,
      },
    });
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION release_test_fail_todo() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title = 'release-test-force-failure' AND NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'isolated test failure'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER release_test_fail_todo BEFORE UPDATE ON "TodoItem" FOR EACH ROW EXECUTE FUNCTION release_test_fail_todo()`,
    );
    try {
      await api()
        .post('/me/equipment')
        .set(auth(dealer))
        .send({
          equipmentName: 'Rollback unit',
          modelNumber: 'ROLLBACK',
          serialNumber: `${tag}-rollback`,
        })
        .expect(500);
      expect(
        await db.equipmentRegistration.count({
          where: { serialNumber: `${tag}-rollback` },
        }),
      ).toBe(0);
      expect(
        (await db.todoItem.findUniqueOrThrow({ where: { id: todo.id } }))
          .status,
      ).toBe('OPEN');
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS release_test_fail_todo ON "TodoItem"',
      );
      await db.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS release_test_fail_todo()',
      );
      await db.todoItem.update({
        where: { id: todo.id },
        data: {
          title: todo.title,
          status: todo.status,
          completedAt: todo.completedAt,
        },
      });
    }
  });

  it('pages more than 50 messages with tied timestamps, excludes moderation removals and validates cursor ownership', async () => {
    const createdAt = new Date(Date.now() - 86400000);
    await db.message.createMany({
      data: Array.from({ length: 65 }, (_, index) => ({
        conversationId,
        senderId: manager.user.id,
        clientMessageId: `${tag}-${index}`,
        body: `History ${index}`,
        createdAt,
      })),
    });
    const service = app.get(MessagingService);
    const first = await service.getMessages(dealer.user.id, conversationId);
    const second = await service.getMessages(
      dealer.user.id,
      conversationId,
      first.nextCursor ?? undefined,
    );
    expect(first.messages).toHaveLength(50);
    expect(second.messages).toHaveLength(15);
    expect(
      new Set([...first.messages, ...second.messages].map((row) => row.id))
        .size,
    ).toBe(65);
    await db.message.update({
      where: { id: first.messages[5].id },
      data: { deletedAt: new Date(), body: '' },
    });
    expect(
      (await service.getMessages(dealer.user.id, conversationId)).messages.map(
        (row) => row.id,
      ),
    ).not.toContain(first.messages[5].id);
    await expect(
      service.getMessages(other.user.id, conversationId),
    ).rejects.toThrow();
    await expect(
      service.getMessages(dealer.user.id, conversationId, 'wrong-cursor'),
    ).rejects.toThrow('Invalid message history cursor');
  });

  it('returns accurate inbox counts with bulk queries and deduplicates racing sends', async () => {
    const service = app.get(MessagingService);
    const inbox = await service.listConversations(dealer.user.id);
    expect(
      inbox.conversations.find((row) => row.id === conversationId)?.unreadCount,
    ).toBe(64);
    const payload = {
      conversationId,
      body: 'Retry once only',
      clientMessageId: `${tag}-duplicate-send`,
    };
    const results = await Promise.all([
      service.sendMessage(manager.user.id, payload),
      service.sendMessage(manager.user.id, payload),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(
      await db.message.count({
        where: {
          senderId: manager.user.id,
          clientMessageId: payload.clientMessageId,
        },
      }),
    ).toBe(1);
  });

  it('keeps read receipts monotonic and prevents future client clocks from hiding unread messages', async () => {
    const service = app.get(MessagingService);
    await service.markRead(dealer.user.id, {
      conversationId,
      lastReadAt: '2099-01-01T00:00:00.000Z',
    });
    const participant = await db.conversationParticipant.findUniqueOrThrow({
      where: {
        conversationId_userId: { conversationId, userId: dealer.user.id },
      },
    });
    expect(participant.lastReadAt!.getTime()).toBeLessThanOrEqual(Date.now());
    await service.markRead(dealer.user.id, {
      conversationId,
      lastReadAt: '2000-01-01T00:00:00.000Z',
    });
    expect(
      (
        await db.conversationParticipant.findUniqueOrThrow({
          where: { id: participant.id },
        })
      ).lastReadAt,
    ).toEqual(participant.lastReadAt);
  });

  it('updates unopened conversations and evicts idle sockets at expiry', async () => {
    const recipient = await connect(dealer.accessToken);
    const sender = await connect(manager.accessToken);
    const update = new Promise<unknown>((resolve) =>
      recipient.once('conversation:updated', resolve),
    );
    expect(
      await ack(sender, 'message:send', {
        conversationId,
        body: 'New message',
        clientMessageId: `${tag}-live`,
      }),
    ).toMatchObject({ ok: true });
    await expect(update).resolves.toMatchObject({ conversationId });
    const expired = await app
      .get(JwtService)
      .signAsync({ sub: dealer.user.id, sv: 0 }, { expiresIn: 1 });
    const short = await connect(expired);
    await ack(short, 'conversation:join', { conversationId });
    await new Promise<void>((resolve) =>
      short.once('disconnect', () => resolve()),
    );
    expect(short.connected).toBe(false);
  }, 10000);

  it('revokes logout credentials for HTTP and sockets without signing out another login', async () => {
    const second = (
      await api()
        .post('/auth/login')
        .send({ email: other.user.email, password })
        .expect(201)
    ).body as Auth;
    await api().post('/auth/logout').set(auth(other)).expect(201);
    await api().get('/auth/me').set(auth(other)).expect(401);
    await api().get('/auth/me').set(auth(second)).expect(200);
    const rejected = await connect(other.accessToken);
    const response = await ack(rejected, 'conversation:join', {
      conversationId,
    }).catch(() => ({ ok: false }));
    expect(response.ok).toBe(false);
    other = second;
  });

  it('completes verified email change and password recovery using the durable code outbox', async () => {
    await api()
      .post('/auth/email-change')
      .set(auth(other))
      .send({ email: email('changed'), currentPassword: password })
      .expect(201);
    await app.get(AccountSecurityService).deliverPendingMail();
    const code = mail.sendCode.mock.calls.at(-1)?.[1] as string;
    expect(code).toMatch(/^\d{8}$/);
    await api()
      .post('/auth/email-change/confirm')
      .set(auth(other))
      .send({ code })
      .expect(201);
    await api().get('/auth/me').set(auth(other)).expect(401);
    await api()
      .post('/auth/password-recovery')
      .send({ email: email('changed') })
      .expect(201);
    await app.get(AccountSecurityService).deliverPendingMail();
    const resetCode = mail.sendCode.mock.calls.at(-1)?.[1] as string;
    await api()
      .post('/auth/password-recovery/confirm')
      .send({
        email: email('changed'),
        code: resetCode,
        password: `${password}2`,
      })
      .expect(201);
    await api()
      .post('/auth/login')
      .send({ email: email('changed'), password: `${password}2` })
      .expect(201);
    expect(
      await db.accountEmailHistory.count({
        where: { userId: other.user.id, email: email('other') },
      }),
    ).toBe(1);
  });

  it('deletes stable owned records across email changes and protects a different owner using the same email', async () => {
    await db.accountEmailHistory.create({
      data: { userId: dealer.user.id, email: email('historical') },
    });
    const owned = await db.jotformSubmission.create({
      data: {
        formId: tag,
        submissionId: 'owned',
        lastEnqueuedBy: 'WEBHOOK',
        ownerUserId: dealer.user.id,
        respondentEmail: email('historical'),
        companyName: 'Old company',
      },
    });
    const different = await db.jotformSubmission.create({
      data: {
        formId: tag,
        submissionId: 'different',
        lastEnqueuedBy: 'WEBHOOK',
        ownerUserId: other.user.id,
        respondentEmail: dealer.user.email,
        companyName: 'Keep this company',
      },
    });
    const response = await api()
      .post('/me/account-deletion-request')
      .set(auth(dealer))
      .expect(201);
    expect(response.body as unknown).toMatchObject({ completed: true });
    expect(
      await db.user.findUnique({ where: { id: dealer.user.id } }),
    ).toBeNull();
    expect(
      (
        await db.jotformSubmission.findUniqueOrThrow({
          where: { id: owned.id },
        })
      ).respondentEmail,
    ).toBeNull();
    expect(
      (
        await db.jotformSubmission.findUniqueOrThrow({
          where: { id: different.id },
        })
      ).companyName,
    ).toBe('Keep this company');
  });

  it('closes access but does not claim deletion when imported ownership is ambiguous', async () => {
    const current = (
      await api()
        .post('/auth/login')
        .send({ email: email('changed'), password: `${password}2` })
        .expect(201)
    ).body as Auth;
    const unowned = await db.jotformSubmission.create({
      data: {
        formId: tag,
        submissionId: 'unowned',
        lastEnqueuedBy: 'WEBHOOK',
        respondentEmail: email('changed'),
        companyName: 'Verify ownership first',
      },
    });
    const response = await api()
      .post('/me/account-deletion-request')
      .set(auth(current))
      .expect(201);
    expect(response.body as unknown).toMatchObject({ completed: false });
    await api().get('/auth/me').set(auth(current)).expect(401);
    expect(
      (
        await db.jotformSubmission.findUniqueOrThrow({
          where: { id: unowned.id },
        })
      ).companyName,
    ).toBe('Verify ownership first');
    expect(
      await db.accountDeletionRequest.count({
        where: { userId: current.user.id, status: 'PENDING_VERIFICATION' },
      }),
    ).toBe(1);
  });

  it('fails database readiness closed when the database is unavailable', async () => {
    const query = jest
      .spyOn(db, '$queryRaw')
      .mockRejectedValueOnce(new Error('private database details'));
    const response = await api().get('/health/ready').expect(503);
    expect(JSON.stringify(response.body)).not.toContain(
      'private database details',
    );
    query.mockRestore();
  });
});
