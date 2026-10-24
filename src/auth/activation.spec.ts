import { PrismaService } from '../prisma/prisma.service';
import { AccountSecurityService } from './account-security.service';
import { hashSecurityCode } from './activation-challenge';
import * as bcrypt from 'bcryptjs';

describe('Account activation', () => {
  const originalSecret = process.env.JWT_SECRET;
  beforeEach(() => {
    process.env.JWT_SECRET = 'isolated-activation-test-secret';
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });
  function fixture() {
    const user = {
      id: 'dealer',
      status: 'INVITED',
      email: 'dealer@example.com',
      activationSubmissionId: 'submission',
      sessionVersion: 0,
    };
    const code = '12345678';
    const challenge = {
      id: 'challenge',
      targetEmail: user.email,
      codeHash: hashSecurityCode(user.id, 'ACCOUNT_ACTIVATION', code),
      expiresAt: new Date(Date.now() + 900000),
      attempts: 0,
      sessionVersion: 0,
      createdAt: new Date(0),
    };
    const submission = {
      id: 'submission',
      respondentEmail: user.email,
      ownerUserId: null as string | null,
      privacyErasedAt: null as Date | null,
      vendorStatus: 'ACTIVE',
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        update: jest.fn(),
      },
      securityChallenge: {
        findUnique: jest.fn().mockResolvedValue(challenge),
        update: jest.fn(),
        deleteMany: jest.fn(),
        upsert: jest.fn(),
      },
      jotformSubmission: {
        findUnique: jest.fn().mockResolvedValue(submission),
        update: jest.fn(),
      },
      accountDeletionRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      pushDevice: { deleteMany: jest.fn() },
    };
    const mail = { assertConfigured: jest.fn(), sendCode: jest.fn() };
    const service = new AccountSecurityService(
      {
        ...tx,
        $transaction: (fn: (value: typeof tx) => unknown) => fn(tx),
      } as unknown as PrismaService,
      mail,
    );
    return {
      user,
      challenge,
      submission,
      tx,
      service,
      dto: {
        email: user.email,
        code,
        password: 'new-long-password',
        firstName: 'Ada',
        lastName: 'Dealer',
        termsAccepted: true as const,
      },
    };
  }
  it('activates only after mailbox proof, binds exact source ownership and records legal consent', async () => {
    const f = fixture();
    await f.service.confirmActivation(f.dto);
    const data = (
      f.tx.user.update.mock.calls as [
        {
          data: {
            passwordHash: string;
            status: string;
            sessionVersion: { increment: number };
          };
        },
      ][]
    )[0][0].data;
    expect(data).toMatchObject({
      status: 'ACTIVE',
      firstName: 'Ada',
      lastName: 'Dealer',
      termsVersion: expect.any(String) as unknown,
      sessionVersion: { increment: 1 },
    });
    expect(await bcrypt.compare(f.dto.password, data.passwordHash)).toBe(true);
    expect(f.tx.jotformSubmission.update).toHaveBeenCalledWith({
      where: { id: 'submission' },
      data: {
        ownerUserId: 'dealer',
        ownershipVerifiedAt: expect.any(Date) as unknown,
        ownershipVerifiedBy: 'ACCOUNT_ACTIVATION_MAILBOX',
      },
    });
    expect(f.tx.securityChallenge.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'dealer' },
    });
  });
  it.each([
    'expired',
    'locked',
    'wrong-code',
    'erased',
    'other-owner',
    'changed-email',
    'disabled',
    'active',
    'deletion',
    'withdrawn',
  ])('does not activate a %s registration', async (condition) => {
    const f = fixture();
    if (condition === 'expired') f.challenge.expiresAt = new Date(0);
    if (condition === 'locked') f.challenge.attempts = 5;
    if (condition === 'wrong-code') f.dto.code = '00000000';
    if (condition === 'erased') f.submission.privacyErasedAt = new Date();
    if (condition === 'other-owner') f.submission.ownerUserId = 'someone-else';
    if (condition === 'changed-email')
      f.submission.respondentEmail = 'edited@example.com';
    if (condition === 'disabled') f.user.status = 'DISABLED';
    if (condition === 'active') f.user.status = 'ACTIVE';
    if (condition === 'deletion')
      f.tx.accountDeletionRequest.findFirst.mockResolvedValue({
        id: 'deletion',
      });
    if (condition === 'withdrawn') f.submission.vendorStatus = 'DELETED';
    await expect(f.service.confirmActivation(f.dto)).rejects.toThrow(
      'invalid or expired',
    );
    expect(f.tx.user.update).not.toHaveBeenCalled();
    expect(f.tx.jotformSubmission.update).not.toHaveBeenCalled();
    if (condition === 'wrong-code')
      expect(f.tx.securityChallenge.update).toHaveBeenCalledWith({
        where: { id: 'challenge' },
        data: { attempts: { increment: 1 } },
      });
  });
  it('requires consent and byte-safe passwords before any write', async () => {
    const f = fixture();
    await expect(
      f.service.confirmActivation({
        ...f.dto,
        termsAccepted: false as unknown as true,
      }),
    ).rejects.toThrow('Accept');
    await expect(
      f.service.confirmActivation({ ...f.dto, password: '🔐'.repeat(19) }),
    ).rejects.toThrow('72 UTF-8 bytes');
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it('returns generic activation request responses without issuing for active or missing accounts', async () => {
    const f = fixture();
    const result = await f.service.requestActivation(f.user.email);
    f.user.status = 'ACTIVE';
    expect(await f.service.requestActivation(f.user.email)).toEqual(result);
    f.tx.user.findUnique.mockResolvedValue(null);
    expect(await f.service.requestActivation('missing@example.com')).toEqual(
      result,
    );
    expect(f.tx.securityChallenge.upsert).toHaveBeenCalledTimes(1);
  });
});
