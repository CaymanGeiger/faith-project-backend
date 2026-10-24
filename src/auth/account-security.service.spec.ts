import { decryptDeliveryCode, encryptDeliveryCode } from './security-code';
import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AccountSecurityService } from './account-security.service';

describe('Account security', () => {
  const originalSecret = process.env.JWT_SECRET;
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-not-a-production-credential';
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  function fixture(purpose = 'PASSWORD_RESET') {
    const user = {
      id: 'dealer',
      email: 'old@example.com',
      status: 'ACTIVE',
      passwordHash: bcrypt.hashSync('current-password', 4),
      sessionVersion: 0,
    };
    const code = '12345678';
    const challenge = {
      id: 'challenge',
      userId: user.id,
      purpose,
      targetEmail:
        purpose === 'PASSWORD_RESET' ? user.email : 'new@example.com',
      codeHash: createHmac('sha256', process.env.JWT_SECRET!)
        .update(`${user.id}:${purpose}:${code}`)
        .digest('hex'),
      attempts: 0,
      sessionVersion: 0,
      expiresAt: new Date(Date.now() + 900_000),
      createdAt: new Date(0),
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        findUniqueOrThrow: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue(user),
      },
      securityChallenge: {
        findUnique: jest.fn().mockResolvedValue(challenge),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn().mockResolvedValue(challenge),
        update: jest.fn().mockResolvedValue(challenge),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      accountEmailHistory: { upsert: jest.fn().mockResolvedValue({}) },
      pushDevice: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn((operation: (transaction: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const mail = {
      assertConfigured: jest.fn(),
      sendCode: jest.fn().mockResolvedValue(undefined),
    };
    return {
      user,
      challenge,
      code,
      tx,
      mail,
      service: new AccountSecurityService(
        prisma as unknown as PrismaService,
        mail,
      ),
    };
  }

  it('uses the same recovery response for missing, inactive and active accounts', async () => {
    const f = fixture();
    const active = await f.service.requestRecovery(f.user.email);
    f.tx.user.findUnique.mockResolvedValueOnce(null);
    expect(await f.service.requestRecovery('missing@example.com')).toEqual(
      active,
    );
    f.user.status = 'DISABLED';
    expect(await f.service.requestRecovery(f.user.email)).toEqual(active);
    expect(f.tx.securityChallenge.upsert).toHaveBeenCalledTimes(1);
    expect(f.mail.sendCode).not.toHaveBeenCalled();
  });
  it('stores a keyed code hash and emails an 8-digit code, never the hash', async () => {
    const f = fixture();
    await f.service.requestRecovery(f.user.email);
    const data = (
      f.tx.securityChallenge.upsert.mock.calls as unknown as [
        { create: { codeHash: string; deliveryCode: string } },
      ][]
    )[0][0].create;
    const emailed = decryptDeliveryCode(
      data.deliveryCode,
      'dealer:PASSWORD_RESET:old@example.com',
    );
    expect(f.mail.sendCode).not.toHaveBeenCalled();
    expect(emailed).toMatch(/^\d{8}$/);
    expect(data.codeHash).not.toBe(emailed);
    expect(data.deliveryCode).not.toContain(emailed);
    expect(data.codeHash).toBe(
      createHmac('sha256', process.env.JWT_SECRET!)
        .update(`dealer:PASSWORD_RESET:${emailed}`)
        .digest('hex'),
    );
  });
  it('limits repeated account requests before calling the mail provider', async () => {
    const f = fixture();
    f.challenge.createdAt = new Date();
    await f.service.requestRecovery(f.user.email);
    expect(f.mail.sendCode).not.toHaveBeenCalled();
  });
  it('commits failed attempts without changing the account', async () => {
    const f = fixture();
    await expect(
      f.service.confirmRecovery({
        email: f.user.email,
        code: '00000000',
        password: 'new-password-value',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(f.tx.securityChallenge.update).toHaveBeenCalledWith({
      where: { id: 'challenge' },
      data: { attempts: { increment: 1 } },
    });
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it.each(['expired', 'locked', 'revoked', 'inactive'])(
    'rejects a %s challenge',
    async (condition) => {
      const f = fixture();
      if (condition === 'expired') f.challenge.expiresAt = new Date(0);
      if (condition === 'locked') f.challenge.attempts = 5;
      if (condition === 'revoked') f.user.sessionVersion = 1;
      if (condition === 'inactive') f.user.status = 'DISABLED';
      await expect(
        f.service.confirmRecovery({
          email: f.user.email,
          code: f.code,
          password: 'new-password-value',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(f.tx.user.update).not.toHaveBeenCalled();
    },
  );
  it('resets the password, invalidates sessions/push and consumes all outstanding codes atomically', async () => {
    const f = fixture();
    await f.service.confirmRecovery({
      email: f.user.email,
      code: f.code,
      password: 'new-password-value',
    });
    const update = (
      f.tx.user.update.mock.calls as unknown as [
        {
          data: { passwordHash: string; sessionVersion: { increment: number } };
        },
      ][]
    )[0][0].data;
    expect(
      await bcrypt.compare('new-password-value', update.passwordHash),
    ).toBe(true);
    expect(update.sessionVersion).toEqual({ increment: 1 });
    expect(f.tx.securityChallenge.deleteMany).toHaveBeenCalledWith({
      where: { userId: f.user.id },
    });
    expect(f.tx.pushDevice.deleteMany).toHaveBeenCalledWith({
      where: { userId: f.user.id },
    });
    f.tx.securityChallenge.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.confirmRecovery({
        email: f.user.email,
        code: f.code,
        password: 'another-password',
      }),
    ).rejects.toThrow(BadRequestException);
  });
  it('requires the current password before sending an email-change code', async () => {
    const f = fixture('EMAIL_CHANGE');
    await expect(
      f.service.requestEmailChange(f.user.id, {
        email: 'new@example.com',
        currentPassword: 'incorrect',
      }),
    ).rejects.toThrow('current password');
    expect(f.mail.sendCode).not.toHaveBeenCalled();
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it('rejects a different target email during cooldown instead of claiming a code was sent there', async () => {
    const f = fixture('EMAIL_CHANGE');
    f.challenge.createdAt = new Date();
    f.tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.requestEmailChange(f.user.id, {
        email: 'different@example.com',
        currentPassword: 'current-password',
      }),
    ).rejects.toThrow(
      'Please wait one minute before requesting a code for a different email address.',
    );
    expect(f.tx.securityChallenge.upsert).not.toHaveBeenCalled();
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it('keeps the existing code for the same target email during cooldown', async () => {
    const f = fixture('EMAIL_CHANGE');
    f.challenge.createdAt = new Date();
    f.tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.requestEmailChange(f.user.id, {
        email: f.challenge.targetEmail,
        currentPassword: 'current-password',
      }),
    ).resolves.toHaveProperty('message');
    expect(f.tx.securityChallenge.upsert).not.toHaveBeenCalled();
  });
  it('issues a code bound to the new target after cooldown', async () => {
    const f = fixture('EMAIL_CHANGE');
    f.tx.user.findUnique.mockResolvedValueOnce(null);
    await f.service.requestEmailChange(f.user.id, {
      email: 'different@example.com',
      currentPassword: 'current-password',
    });
    const data = (
      f.tx.securityChallenge.upsert.mock.calls as unknown as [
        { create: { targetEmail: string; deliveryCode: string } },
      ][]
    )[0][0].create;
    expect(data.targetEmail).toBe('different@example.com');
    expect(
      decryptDeliveryCode(
        data.deliveryCode,
        'dealer:EMAIL_CHANGE:different@example.com',
      ),
    ).toMatch(/^\d{8}$/);
  });
  it('preserves the former address for privacy processing only after verification', async () => {
    const f = fixture('EMAIL_CHANGE');
    await f.service.confirmEmailChange(f.user.id, f.code);
    expect(f.tx.accountEmailHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { userId: f.user.id, email: f.user.email },
      }),
    );
    expect(f.tx.user.update).toHaveBeenCalledWith({
      where: { id: f.user.id },
      data: { email: 'new@example.com', sessionVersion: { increment: 1 } },
    });
  });
  it('delivers durable encrypted mail in the worker and removes the encrypted code', async () => {
    const f = fixture();
    const deliveryCode = encryptDeliveryCode(
      f.code,
      `dealer:PASSWORD_RESET:${f.user.email}`,
    );
    f.tx.securityChallenge.findMany.mockResolvedValue([
      { ...f.challenge, deliveryCode, mailAttempts: 0, user: f.user },
    ]);
    await f.service.deliverPendingMail();
    expect(f.mail.sendCode).toHaveBeenCalledWith(
      f.user.email,
      f.code,
      'PASSWORD_RESET',
    );
    expect(f.tx.securityChallenge.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { deliveryCode: null, mailLeaseUntil: null },
      }),
    );
  });
  it('retries an SMTP outage without losing the pending challenge', async () => {
    const f = fixture();
    const deliveryCode = encryptDeliveryCode(
      f.code,
      `dealer:PASSWORD_RESET:${f.user.email}`,
    );
    f.tx.securityChallenge.findMany.mockResolvedValue([
      { ...f.challenge, deliveryCode, mailAttempts: 0, user: f.user },
    ]);
    f.mail.sendCode.mockRejectedValue(new Error('SMTP unavailable'));
    await f.service.deliverPendingMail();
    const call = f.tx.securityChallenge.updateMany.mock.calls.at(-1) as [
      { data: { mailAttempts: number; deliveryCode?: string } },
    ];
    expect(call[0].data.mailAttempts).toBe(1);
    expect(call[0].data.deliveryCode).toBeUndefined();
  });
  it('rejects encrypted code substitution between recipient identities', () => {
    const encrypted = encryptDeliveryCode(
      '12345678',
      'dealer:EMAIL_CHANGE:new@example.com',
    );
    expect(() =>
      decryptDeliveryCode(encrypted, 'other:EMAIL_CHANGE:other@example.com'),
    ).toThrow();
  });
});
