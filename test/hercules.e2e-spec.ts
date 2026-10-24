/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { AccountSecurityService } from '../src/auth/account-security.service';
import { SecurityMailService } from '../src/auth/security-mail.service';
import { JotformApiClient } from '../src/jotform/jotform-api.client';
import { loadJotformConfig } from '../src/jotform/jotform.config';
import { JotformSyncService } from '../src/jotform/jotform-sync.service';
import { CURRENT_TERMS_VERSION } from '../src/legal/legal.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { PushService } from '../src/push/push.service';
import { AFTER_HOURS_NOTICE } from '../src/availability/availability-policy';

type Auth = { id: string; token: string };
type Ack = { ok: boolean; message?: { id: string } };

// Real local PostgreSQL, HTTP guards/DTOs and Socket.IO. Only vendor Jotform,
// transactional email and Expo delivery are mocked; no customer is contacted.
describe('Hercules registration, restricted access, availability and financing', () => {
  let app: INestApplication<App>;
  let db: PrismaService;
  let sync: JotformSyncService;
  let manager: Auth, otherManager: Auth, existing: Auth, dealer: Auth;
  let pendingId: string, conversationId: string, classId: string;
  let enrollmentId: string, activationCode: string;
  const tag = `hercules-${randomUUID()}`;
  const formId = `${Date.now()}009`;
  let submissionSequence = 0;
  const email = (label: string) => `${label}@${tag}.example.com`;
  const password = 'Hercules-test-only-password-2026!';
  const users: string[] = [];
  const sockets: Socket[] = [];
  const canonical = new Map<string, unknown>();
  const mail = {
    assertConfigured: jest.fn(),
    sendCode: jest
      .fn<Promise<void>, [string, string, string]>()
      .mockResolvedValue(undefined),
  };
  const vendor = {
    getSubmission: jest.fn((id: string) =>
      Promise.resolve({
        content: canonical.get(id),
        limitLeft: 10000,
      }),
    ),
  };
  const envKeys = [
    'JOTFORM_INTEGRATION_ENABLED',
    'JOTFORM_ONBOARDING_ENABLED',
    'JOTFORM_ONBOARDING_MANAGER_ID',
    'ONBOARDING_VERIFIER_MANAGER_IDS',
    'SYNCHRONY_FINANCING_URL',
    'SYNCHRONY_FINANCING_DESCRIPTION',
    'PUSH_NOTIFICATIONS_ENABLED',
    'DEV_TRAINING_TOGGLE_ENABLED',
    'DEV_FEATURES_ENABLED',
  ];
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const auth = (user: Auth) => ({ Authorization: `Bearer ${user.token}` });
  const api = () => request(app.getHttpServer());

  async function seededUser(label: string, role: UserRole): Promise<Auth> {
    const user = await db.user.create({
      data: {
        email: email(label),
        passwordHash: await bcrypt.hash(password, 4),
        firstName: label,
        lastName: 'Synthetic',
        role,
        // Represents an account that already existed before onboarding rollout.
        onboardingRequired: false,
        termsAcceptedAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
        ...(role === 'SALES_MANAGER'
          ? { salesManagerProfile: { create: {} } }
          : {}),
      },
    });
    users.push(user.id);
    return {
      id: user.id,
      token: await app
        .get(JwtService)
        .signAsync({ sub: user.id, sv: user.sessionVersion }),
    };
  }

  async function importRegistration(label: string, respondent = email(label)) {
    const submissionId = `${Date.now()}${++submissionSequence}`;
    canonical.set(submissionId, {
      id: submissionId,
      form_id: formId,
      status: 'ACTIVE',
      created_at: '2026-10-19 12:00:00',
      updated_at: '2026-10-19 12:00:00',
      answers: {
        '13': { type: 'control_email', answer: respondent },
        '14': { type: 'control_textbox', answer: 'Synthetic dealer company' },
        '4': {
          type: 'control_fullname',
          answer: { first: 'Untrusted form name', last: 'Fixture' },
        },
      },
    });
    await sync.acceptWebhook({ formId, submissionId, fingerprint: tag });
    expect(await sync.processDue()).toMatchObject({ claimed: 1, processed: 1 });
    const user = await db.user.findUnique({ where: { email: respondent } });
    if (user && !users.includes(user.id)) users.push(user.id);
    return { submissionId, user };
  }

  async function connect(token: string) {
    const address = (app.getHttpServer() as Server).address();
    if (!address || typeof address === 'string')
      throw new Error('Missing local listener');
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

  const send = (socket: Socket, body: string, clientMessageId = randomUUID()) =>
    new Promise<Ack>((resolve, reject) => {
      socket
        .timeout(3000)
        .emit(
          'message:send',
          { conversationId, body, clientMessageId },
          (error: Error | null, result: Ack) =>
            error ? reject(error) : resolve(result),
        );
    });

  beforeAll(async () => {
    process.env.JOTFORM_INTEGRATION_ENABLED = 'false';
    process.env.JOTFORM_ONBOARDING_ENABLED = 'true';
    process.env.ONBOARDING_VERIFIER_MANAGER_IDS = '';
    process.env.SYNCHRONY_FINANCING_URL = '';
    process.env.SYNCHRONY_FINANCING_DESCRIPTION = '';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SecurityMailService)
      .useValue(mail)
      // This suite verifies access policy, not rate-limit timing.
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
    await app.listen(0, '127.0.0.1');
    db = app.get(PrismaService);
    manager = await seededUser('manager', 'SALES_MANAGER');
    otherManager = await seededUser('other-manager', 'SALES_MANAGER');
    existing = await seededUser('existing', 'PROSPECT');
    process.env.JOTFORM_ONBOARDING_MANAGER_ID = manager.id;
    sync = new JotformSyncService(
      db,
      {
        ...loadJotformConfig({ JOTFORM_INTEGRATION_ENABLED: 'false' }),
        enabled: true,
        formId,
      },
      vendor as unknown as JotformApiClient,
    );
    sync.disableBackgroundProcessing();
  }, 30000);

  afterAll(async () => {
    sockets.forEach((socket) => socket.disconnect());
    if (db) {
      await db.conversation.deleteMany({
        where: { participants: { some: { userId: { in: users } } } },
      });
      await db.initialTrainingVerification.deleteMany({
        where: { prospectUserId: { in: users } },
      });
      await db.user.deleteMany({
        where: { id: { in: users }, role: 'PROSPECT' },
      });
      await db.user.deleteMany({
        where: { id: { in: users }, role: 'SALES_MANAGER' },
      });
      if (classId) await db.classSession.delete({ where: { id: classId } });
      await db.jotformSubmission.deleteMany({ where: { formId } });
      await db.jotformSyncState.deleteMany({ where: { formId } });
    }
    await app?.close();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });

  it('imports a verified vendor fixture once, persists an invited account, and preserves existing account ownership', async () => {
    const result = await importRegistration('new-dealer');
    expect(result.user).toMatchObject({
      status: 'INVITED',
      onboardingRequired: true,
      firstName: '',
      lastName: '',
    });
    pendingId = result.user!.id;
    expect(result.user!.passwordHash).toMatch(/^!activation-required:/);
    const saved = await db.jotformSubmission.findUniqueOrThrow({
      where: {
        formId_submissionId: { formId, submissionId: result.submissionId },
      },
    });
    expect(saved.syncStatus).toBe('PROCESSED');
    expect(saved.ownerUserId).toBeNull();
    expect(result.user!.activationSubmissionId).toBe(saved.id);
    const firstChallenge = await db.securityChallenge.findUniqueOrThrow({
      where: {
        userId_purpose: { userId: pendingId, purpose: 'ACCOUNT_ACTIVATION' },
      },
    });
    const duplicate = await sync.acceptWebhook({
      formId,
      submissionId: result.submissionId,
      fingerprint: tag,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(await sync.processDue()).toMatchObject({ processed: 1 });
    expect(await db.user.count({ where: { email: email('new-dealer') } })).toBe(
      1,
    );
    expect(
      await db.securityChallenge.findUnique({
        where: { id: firstChallenge.id },
      }),
    ).toMatchObject({ codeHash: firstChallenge.codeHash });
    expect(
      await db.conversationParticipant.count({ where: { userId: pendingId } }),
    ).toBe(1);
    const prior = await db.user.findUniqueOrThrow({
      where: { id: existing.id },
    });
    const reimport = await importRegistration(
      'existing-attempt',
      email('existing'),
    );
    expect(reimport.user).toMatchObject({
      id: existing.id,
      status: 'ACTIVE',
      passwordHash: prior.passwordHash,
      activationSubmissionId: null,
      onboardingRequired: false,
    });
    expect(
      await db.jotformSubmission.findUnique({
        where: {
          formId_submissionId: { formId, submissionId: reimport.submissionId },
        },
      }),
    ).toMatchObject({ ownerUserId: null });
    await api()
      .post('/auth/login')
      .send({ email: email('new-dealer'), password })
      .expect(401);
  });

  it('activates only with the emailed current code and explicit terms acceptance, then rejects reuse', async () => {
    const requested = await api()
      .post('/auth/activation/request')
      .send({ email: email('new-dealer') })
      .expect(201);
    const unknown = await api()
      .post('/auth/activation/request')
      .send({ email: email('unknown') })
      .expect(201);
    expect(requested.body).toEqual(unknown.body);
    await app.get(AccountSecurityService).deliverPendingMail();
    const sent = mail.sendCode.mock.calls.find(
      (call) => call[0] === email('new-dealer'),
    );
    expect(sent?.[2]).toBe('ACCOUNT_ACTIVATION');
    activationCode = sent![1];
    expect(activationCode).toMatch(/^\d{8}$/);
    expect(
      mail.sendCode.mock.calls.filter(
        (call) => call[0] === email('new-dealer'),
      ),
    ).toHaveLength(1);
    const payload = {
      email: email('new-dealer'),
      code: activationCode,
      password,
      firstName: 'Verified',
      lastName: 'Dealer',
      termsAccepted: true,
    };
    await api()
      .post('/auth/activation/confirm')
      .send({ ...payload, termsAccepted: false })
      .expect(400);
    await api()
      .post('/auth/activation/confirm')
      .send({
        ...payload,
        code: activationCode === '00000000' ? '11111111' : '00000000',
      })
      .expect(400);
    await api().post('/auth/activation/confirm').send(payload).expect(201);
    await api().post('/auth/activation/confirm').send(payload).expect(400);
    const activated = await db.user.findUniqueOrThrow({
      where: { id: pendingId },
    });
    expect(activated).toMatchObject({
      status: 'ACTIVE',
      firstName: 'Verified',
      lastName: 'Dealer',
      onboardingRequired: true,
    });
    expect(activated.initialTrainingVerifiedAt).toBeNull();
    expect(activated.termsAcceptedAt).toBeInstanceOf(Date);
    expect(
      await db.jotformSubmission.findUnique({
        where: { id: activated.activationSubmissionId! },
      }),
    ).toMatchObject({ ownerUserId: pendingId });
    const login = await api()
      .post('/auth/login')
      .send({ email: email('new-dealer'), password })
      .expect(201);
    dealer = { id: pendingId, token: login.body.accessToken as string };
    expect(login.body.user.onboarding).toMatchObject({
      restricted: true,
      state: 'TRAINING_REQUIRED',
    });
    conversationId = (
      await db.conversationParticipant.findFirstOrThrow({
        where: { userId: pendingId },
      })
    ).conversationId;
  });

  it('enforces restrictions on direct read/write routes while keeping training, profile and scoped messaging accessible', async () => {
    for (const route of [
      '/benefits',
      '/benefits/financing',
      '/benefits/arbitrary-id',
      '/resources',
      '/resources/arbitrary-id',
      '/me/equipment',
      '/me/equipment/arbitrary-id',
      '/me/todos',
      '/me/marketing-consultation',
    ]) {
      const denied = await api().get(route).set(auth(dealer)).expect(403);
      expect(denied.body.code).toBe('INITIAL_TRAINING_REQUIRED');
    }
    await api()
      .post('/me/equipment')
      .set(auth(dealer))
      .send({ equipmentName: 'Fixture', modelNumber: 'M', serialNumber: 'S' })
      .expect(403);
    await api()
      .patch('/me/equipment/arbitrary-id')
      .set(auth(dealer))
      .send({})
      .expect(403);
    await api()
      .patch('/me/todos/arbitrary-id')
      .set(auth(dealer))
      .send({ completed: true })
      .expect(403);
    await api()
      .post('/me/marketing-consultation/handoff')
      .set(auth(dealer))
      .send({})
      .expect(403);
    await api()
      .patch('/me')
      .set(auth(dealer))
      .send({ initialTrainingVerifiedAt: new Date().toISOString() })
      .expect(400);
    for (const route of [
      '/auth/me',
      '/me',
      '/me/onboarding-status',
      '/classes',
      '/me/classes',
      '/conversations',
      `/conversations/${conversationId}/messages`,
    ]) {
      await api().get(route).set(auth(dealer)).expect(200);
    }
    await api()
      .get(`/conversations/${conversationId}`)
      .set(auth(existing))
      .expect(403);
    await api().get('/benefits/financing').expect(401);
    await api().get('/benefits').set(auth(existing)).expect(200);
  });

  it('training enrollment and legacy completion labels never unlock access without an authoritative verification', async () => {
    const session = await db.classSession.create({
      data: {
        title: `Synthetic training ${tag}`,
        description: 'Local acceptance fixture',
        startsAt: new Date(Date.now() + 86400000),
        endsAt: new Date(Date.now() + 90000000),
        virtualUrl: 'https://training.example.com/fixture',
        status: 'SCHEDULED',
      },
    });
    classId = session.id;
    await api()
      .post(`/classes/${classId}/enroll`)
      .set(auth(dealer))
      .expect(201);
    enrollmentId = (
      await db.classEnrollment.findFirstOrThrow({
        where: { prospectUserId: dealer.id, classSessionId: classId },
      })
    ).id;
    await api().get('/benefits').set(auth(dealer)).expect(403);
    await db.classEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'COMPLETED' },
    });
    const current = await api().get('/auth/me').set(auth(dealer)).expect(200);
    expect(current.body.user.onboarding.restricted).toBe(true);
    await api().get('/benefits/financing').set(auth(dealer)).expect(403);
  });

  it('manager hours persist, scoped dealers see after-hours notices, and messages/retries remain enabled while push silencing is optional', async () => {
    const settings = {
      timezone: 'America/Denver',
      hours: [],
      mode: 'SCHEDULE',
      overrideUntil: null,
      silenceWhenUnavailable: false,
    };
    const closed = await api()
      .put('/availability/me')
      .set(auth(manager))
      .send(settings)
      .expect(200);
    expect(closed.body.availability).toMatchObject({
      available: false,
      sendingAllowed: true,
      notificationsSilenced: false,
    });
    await api()
      .put('/availability/me')
      .set(auth(dealer))
      .send(settings)
      .expect(403);
    await api()
      .get(`/availability/conversations/${conversationId}`)
      .set(auth(existing))
      .expect(403);
    const dealerView = await api()
      .get(`/availability/conversations/${conversationId}`)
      .set(auth(dealer))
      .expect(200);
    expect(dealerView.body.availability.notice).toBe(
      'This is outside of normal business hours. There may be a delayed response.',
    );
    const socket = await connect(dealer.token);
    const clientId = randomUUID();
    const first = await send(socket, 'Synthetic after-hours message', clientId);
    expect(first.ok).toBe(true);
    expect(
      (await send(socket, 'Synthetic after-hours message', clientId)).message
        ?.id,
    ).toBe(first.message?.id);
    expect(
      await db.message.count({
        where: { senderId: dealer.id, clientMessageId: clientId },
      }),
    ).toBe(1);

    process.env.PUSH_NOTIFICATIONS_ENABLED = 'true';
    const device = await db.pushDevice.create({
      data: {
        userId: manager.id,
        token: `ExponentPushToken[synthetic-${tag}]`,
        platform: 'ios',
        sessionVersion: 0,
        sessionExpiresAt: new Date(Date.now() + 3600000),
      },
    });
    const queued = await send(socket, 'Synthetic queued message');
    expect(queued.ok).toBe(true);
    expect(
      await db.pushDelivery.findUnique({
        where: {
          deviceId_messageId: {
            deviceId: device.id,
            messageId: queued.message!.id,
          },
        },
      }),
    ).toMatchObject({ status: 'PENDING' });
    await api()
      .put('/availability/me')
      .set(auth(manager))
      .send({ ...settings, mode: 'AWAY', silenceWhenUnavailable: true })
      .expect(200);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('External delivery forbidden in acceptance test'),
      );
    await app.get(PushService).process();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await db.pushDelivery.findUnique({
        where: {
          deviceId_messageId: {
            deviceId: device.id,
            messageId: queued.message!.id,
          },
        },
      }),
    ).toMatchObject({ status: 'SUPPRESSED' });
    const silent = await send(socket, 'Synthetic silent message');
    expect(silent.ok).toBe(true);
    expect(
      await db.pushDelivery.findUnique({
        where: {
          deviceId_messageId: {
            deviceId: device.id,
            messageId: silent.message!.id,
          },
        },
      }),
    ).toMatchObject({ status: 'SUPPRESSED' });
    const open = await api()
      .put('/availability/me')
      .set(auth(manager))
      .send({ ...settings, mode: 'AVAILABLE', silenceWhenUnavailable: true })
      .expect(200);
    expect(open.body.availability).toMatchObject({
      available: true,
      notice: null,
      notificationsSilenced: false,
    });
    await app.get(PushService).process();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
    process.env.PUSH_NOTIFICATIONS_ENABLED = 'false';
  });

  it('lets managers change the away message immediately, persists it for older clients, and restores the default when cleared', async () => {
    const settings = {
      timezone: 'America/Denver',
      hours: [],
      mode: 'AWAY',
      overrideUntil: null,
      silenceWhenUnavailable: false,
    };
    const message = 'I am away this week. Please contact the office.';
    const updated = await api()
      .put('/availability/me')
      .set(auth(manager))
      .send({ ...settings, outOfOfficeMessage: `  ${message}  ` })
      .expect(200);
    expect(updated.body.settings.outOfOfficeMessage).toBe(message);
    expect(updated.body.availability.notice).toBe(message);
    expect(
      await db.salesManagerProfile.findUnique({
        where: { userId: manager.id },
      }),
    ).toMatchObject({ outOfOfficeMessage: message });
    const own = await api()
      .get('/availability/me')
      .set(auth(manager))
      .expect(200);
    expect(own.body.settings.outOfOfficeMessage).toBe(message);
    const other = await api()
      .get('/availability/me')
      .set(auth(otherManager))
      .expect(200);
    expect(other.body.settings.outOfOfficeMessage).toBeNull();
    const dealerView = await api()
      .get(`/availability/conversations/${conversationId}`)
      .set(auth(dealer))
      .expect(200);
    expect(dealerView.body.availability.notice).toBe(message);

    const revisedMessage = 'Back tomorrow morning.';
    await api()
      .put('/availability/me')
      .set(auth(manager))
      .send({ ...settings, outOfOfficeMessage: revisedMessage })
      .expect(200);
    const revisedView = await api()
      .get(`/availability/conversations/${conversationId}`)
      .set(auth(dealer))
      .expect(200);
    expect(revisedView.body.availability.notice).toBe(revisedMessage);
    const legacy = await api()
      .put('/availability/me')
      .set(auth(manager))
      .send({ ...settings, mode: 'AVAILABLE' })
      .expect(200);
    expect(legacy.body.settings.outOfOfficeMessage).toBe(revisedMessage);
    expect(legacy.body.availability.notice).toBeNull();

    for (const outOfOfficeMessage of [false, 'a'.repeat(501)]) {
      await api()
        .put('/availability/me')
        .set(auth(manager))
        .send({ ...settings, outOfOfficeMessage })
        .expect(400);
    }
    const reset = await api()
      .put('/availability/me')
      .set(auth(manager))
      .send({ ...settings, outOfOfficeMessage: '  \n ' })
      .expect(200);
    expect(reset.body.settings.outOfOfficeMessage).toBeNull();
    expect(reset.body.availability.notice).toBe(AFTER_HOURS_NOTICE);
    const resetView = await api()
      .get(`/availability/conversations/${conversationId}`)
      .set(auth(dealer))
      .expect(200);
    expect(resetView.body.availability.notice).toBe(AFTER_HOURS_NOTICE);
  });

  it('only an allowlisted assigned verifier unlocks the same authenticated session and records an idempotent audit entry', async () => {
    const payload = {
      completedAt: new Date(Date.now() - 60000).toISOString(),
      source: 'Synthetic instructor attendance',
      reference: `TEST-ONLY-${tag}`,
    };
    const route = `/onboarding/prospects/${dealer.id}/training-verification`;
    await api().post(route).set(auth(dealer)).send(payload).expect(403);
    await api().post(route).set(auth(manager)).send(payload).expect(403);
    process.env.ONBOARDING_VERIFIER_MANAGER_IDS = `${manager.id},${otherManager.id}`;
    await api().post(route).set(auth(otherManager)).send(payload).expect(403);
    await api()
      .post(route)
      .set(auth(manager))
      .send({
        ...payload,
        completedAt: new Date(Date.now() + 86400000).toISOString(),
      })
      .expect(400);
    await api()
      .post(route)
      .set(auth(manager))
      .send({ ...payload, enrollmentId })
      .expect(400);
    const verified = await api()
      .post(route)
      .set(auth(manager))
      .send(payload)
      .expect(201);
    expect(verified.body.access).toMatchObject({
      restricted: false,
      state: 'TRAINING_VERIFIED',
    });
    const managerList = await api()
      .get('/manager/prospects')
      .set(auth(manager))
      .expect(200);
    expect(managerList.body.prospects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: dealer.id,
          user: expect.objectContaining({
            initialTrainingVerifiedAt: verified.body.access
              .trainingVerifiedAt as string,
          }) as unknown,
        }),
      ]),
    );
    const managerDetail = await api()
      .get(`/manager/prospects/${dealer.id}`)
      .set(auth(manager))
      .expect(200);
    expect(managerDetail.body.prospect.user.initialTrainingVerifiedAt).toBe(
      verified.body.access.trainingVerifiedAt,
    );
    expect(managerDetail.body.prospect.certificationStatus).toBe('IN_PROGRESS');
    await api()
      .get(`/manager/prospects/${dealer.id}`)
      .set(auth(otherManager))
      .expect(403);
    const repeated = await api()
      .post(route)
      .set(auth(manager))
      .send(payload)
      .expect(201);
    expect(repeated.body.verification.id).toBe(verified.body.verification.id);
    await api()
      .post(route)
      .set(auth(manager))
      .send({ ...payload, reference: 'Changed evidence' })
      .expect(409);
    expect(
      await db.initialTrainingVerification.count({
        where: { prospectUserId: dealer.id },
      }),
    ).toBe(1);
    for (const route of [
      '/benefits',
      '/resources',
      '/me/equipment',
      '/me/todos',
      '/me/marketing-consultation',
    ]) {
      await api().get(route).set(auth(dealer)).expect(200);
    }
    const current = await api().get('/auth/me').set(auth(dealer)).expect(200);
    expect(current.body.user.onboarding.restricted).toBe(false);
    const missingFinancing = await api()
      .get('/benefits/financing')
      .set(auth(dealer))
      .expect(200);
    expect(missingFinancing.body.financing).toMatchObject({
      available: false,
      url: null,
      description: null,
    });
    process.env.SYNCHRONY_FINANCING_URL =
      'https://finance.example.com/synthetic-program';
    process.env.SYNCHRONY_FINANCING_DESCRIPTION =
      'Synthetic approved-content fixture; not production terms.';
    const configured = await api()
      .get('/benefits/financing')
      .set(auth(dealer))
      .expect(200);
    expect(configured.body.financing).toMatchObject({
      available: true,
      url: process.env.SYNCHRONY_FINANCING_URL,
      description: process.env.SYNCHRONY_FINANCING_DESCRIPTION,
    });
    const unchanged = await db.prospectProfile.findUniqueOrThrow({
      where: { userId: dealer.id },
    });
    expect(unchanged.certificationStatus).not.toBe('CERTIFIED');
  });

  it('development toggle changes self access and summary in both directions while preserving genuine evidence', async () => {
    const testDealer = await seededUser('development-toggle', 'PROSPECT');
    await db.user.update({
      where: { id: testDealer.id },
      data: {
        onboardingRequired: true,
        prospectProfile: {
          create: {
            companyName: 'Development fixture',
            assignedSalesManagerId: manager.id,
            marketingConsultationDueAt: new Date(),
            jbWarrantiesDueAt: new Date(),
          },
        },
      },
    });
    const route = '/onboarding/development/training';
    process.env.DEV_FEATURES_ENABLED = 'true';
    process.env.DEV_TRAINING_TOGGLE_ENABLED = 'false';
    await api()
      .patch(route)
      .set(auth(testDealer))
      .send({ completed: true })
      .expect(404);
    process.env.DEV_TRAINING_TOGGLE_ENABLED = 'true';
    delete process.env.DEV_FEATURES_ENABLED;
    await api()
      .patch(route)
      .set(auth(testDealer))
      .send({ completed: true })
      .expect(404);
    process.env.DEV_FEATURES_ENABLED = 'true';
    await api().patch(route).send({ completed: true }).expect(401);
    await api()
      .patch(route)
      .set(auth(manager))
      .send({ completed: true })
      .expect(403);
    await api()
      .patch(route)
      .set(auth(testDealer))
      .send({ completed: true, userId: dealer.id })
      .expect(400);
    await api()
      .patch(route)
      .set(auth(testDealer))
      .send({ completed: 'true' })
      .expect(400);
    await api().get('/resources').set(auth(testDealer)).expect(403);
    await api()
      .patch(route)
      .set(auth(testDealer))
      .send({ completed: true })
      .expect(200);
    await api()
      .patch(route)
      .set(auth(testDealer))
      .send({ completed: true })
      .expect(200);
    const mock = await db.initialTrainingVerification.findUniqueOrThrow({
      where: { prospectUserId: testDealer.id },
    });
    expect(mock).toMatchObject({
      developmentOnly: true,
      verifiedByUserId: null,
      source: 'DEVELOPMENT_TRAINING_TOGGLE',
    });
    expect(
      (await api().get('/auth/me').set(auth(testDealer)).expect(200)).body.user
        .onboarding.restricted,
    ).toBe(false);
    expect(
      (
        await api()
          .get('/me/onboarding-status')
          .set(auth(testDealer))
          .expect(200)
      ).body.summary.trainingCompleted,
    ).toBe(true);
    await api().get('/resources').set(auth(testDealer)).expect(200);
    await api()
      .patch(route)
      .set(auth(testDealer))
      .send({ completed: false })
      .expect(200);
    await api()
      .patch(route)
      .set(auth(testDealer))
      .send({ completed: false })
      .expect(200);
    expect(
      (await api().get('/auth/me').set(auth(testDealer)).expect(200)).body.user
        .onboarding.restricted,
    ).toBe(true);
    expect(
      (
        await api()
          .get('/me/onboarding-status')
          .set(auth(testDealer))
          .expect(200)
      ).body.summary.trainingCompleted,
    ).toBe(false);
    await api().get('/resources').set(auth(testDealer)).expect(403);
    expect(
      await db.initialTrainingVerification.count({
        where: { prospectUserId: testDealer.id },
      }),
    ).toBe(0);
    const real = await db.initialTrainingVerification.findUniqueOrThrow({
      where: { prospectUserId: dealer.id },
    });
    await api()
      .patch(route)
      .set(auth(dealer))
      .send({ completed: false })
      .expect(409);
    expect(
      await db.initialTrainingVerification.findUnique({
        where: { prospectUserId: dealer.id },
      }),
    ).toEqual(real);
    const previousRuntime = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      await api().patch(route).send({ completed: true }).expect(404);
      await api()
        .patch(route)
        .set(auth(testDealer))
        .send({ completed: true })
        .expect(404);
    } finally {
      process.env.NODE_ENV = previousRuntime;
    }
    process.env.DEV_TRAINING_TOGGLE_ENABLED = 'false';
  });

  it('expired activation codes fail without activating or linking the submission', async () => {
    const pending = await importRegistration('expired');
    await app.get(AccountSecurityService).deliverPendingMail();
    const code = mail.sendCode.mock.calls.find(
      (call) => call[0] === email('expired'),
    )![1];
    await db.securityChallenge.update({
      where: {
        userId_purpose: {
          userId: pending.user!.id,
          purpose: 'ACCOUNT_ACTIVATION',
        },
      },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await api()
      .post('/auth/activation/confirm')
      .send({
        email: email('expired'),
        code,
        password,
        firstName: 'Expired',
        lastName: 'Fixture',
        termsAccepted: true,
      })
      .expect(400);
    expect(
      await db.user.findUnique({ where: { id: pending.user!.id } }),
    ).toMatchObject({ status: 'INVITED' });
    expect(
      await db.jotformSubmission.findUnique({
        where: { id: pending.user!.activationSubmissionId! },
      }),
    ).toMatchObject({ ownerUserId: null });
  });
});
