/* eslint-disable @typescript-eslint/unbound-method -- These expectations inspect Jest mock call records, not unbound method invocation. */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InviteStatusRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { hashInviteToken } from './invite-token';
import * as bcrypt from 'bcryptjs';

describe('AuthService', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAppEnv = process.env.APP_ENV;
  const previousDevFeatures = process.env.DEV_FEATURES_ENABLED;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.APP_ENV;
    process.env.DEV_FEATURES_ENABLED = 'true';
  });

  afterAll(() => {
    if (previousAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previousAppEnv;
    if (previousDevFeatures === undefined)
      delete process.env.DEV_FEATURES_ENABLED;
    else process.env.DEV_FEATURES_ENABLED = previousDevFeatures;
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it.each(['production', 'staging', 'missing-flag', 'disabled-flag'])(
    'blocks seeded account logins in %s without updating or issuing a session',
    async (mode) => {
      if (mode === 'missing-flag') delete process.env.DEV_FEATURES_ENABLED;
      else if (mode === 'disabled-flag')
        process.env.DEV_FEATURES_ENABLED = 'false';
      else process.env.NODE_ENV = mode;
      const update = jest.fn();
      const signAsync = jest.fn();
      const service = new AuthService(
        {
          user: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'demo-manager',
              status: 'ACTIVE',
              email: 'manager@hercules.local',
              passwordHash: await bcrypt.hash('password123', 4),
            }),
            update,
          },
        } as unknown as PrismaService,
        { signAsync } as unknown as JwtService,
      );
      await expect(
        service.login({
          email: 'manager@hercules.local',
          password: 'password123',
        }),
      ).rejects.toThrow('Invalid email or password');
      expect(update).not.toHaveBeenCalled();
      expect(signAsync).not.toHaveBeenCalled();
    },
  );

  it('keeps opted-in development demo login and ordinary login available', async () => {
    for (const [email, enabled] of [
      ['prospect@hercules.local', 'true'],
      ['dealer@example.com', 'false'],
    ]) {
      process.env.DEV_FEATURES_ENABLED = enabled;
      const service = new AuthService(
        {
          user: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'dealer',
              email,
              status: 'ACTIVE',
              role: 'PROSPECT',
              passwordHash: await bcrypt.hash('test-password', 4),
            }),
            update: jest.fn().mockResolvedValue({}),
          },
        } as unknown as PrismaService,
        {
          signAsync: jest.fn().mockResolvedValue('session'),
        } as unknown as JwtService,
      );
      await expect(
        service.login({ email, password: 'test-password' }),
      ).resolves.toMatchObject({ accessToken: 'session' });
    }
  });

  it('does not accept a legacy raw invite without the master flag', async () => {
    delete process.env.DEV_FEATURES_ENABLED;
    const lookup = jest.fn().mockResolvedValue(null);
    const service = new AuthService(
      {
        registrationInvite: { findUnique: lookup },
      } as unknown as PrismaService,
      {} as JwtService,
    );
    await expect(
      service.getInviteDetails({ token: 'legacy-raw-token' }),
    ).rejects.toThrow('Registration invite is invalid or expired');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each(['prospect-demo-token', 'manager-demo-token'])(
    'rejects the known seed invitation %s before lookup when development is disabled',
    async (token) => {
      process.env.DEV_FEATURES_ENABLED = 'false';
      const lookup = jest.fn();
      const service = new AuthService(
        {
          registrationInvite: { findUnique: lookup },
        } as unknown as PrismaService,
        {} as JwtService,
      );
      await expect(service.getInviteDetails({ token })).rejects.toThrow(
        'Registration invite is invalid or expired',
      );
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it('returns a conflict when an invite registration email already exists', async () => {
    const invite = {
      id: 'invite-1',
      token: 'stored-token',
      recipientEmail: null,
      roleToCreate: InviteStatusRole.SALES_MANAGER,
      assignedSalesManagerId: 'manager-1',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      usedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const prisma = {
      registrationInvite: {
        findUnique: jest.fn().mockResolvedValue(invite),
      },
      $transaction: jest.fn((operation: (tx: unknown) => Promise<unknown>) =>
        operation({
          registrationInvite: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          user: {
            create: jest.fn().mockRejectedValue(uniqueConstraintError()),
          },
        }),
      ),
    } as unknown as PrismaService;
    const service = new AuthService(prisma, {} as JwtService);

    await expect(
      service.registerFromInvite({
        token: 'raw-invite-token',
        accountType: InviteStatusRole.SALES_MANAGER,
        email: 'already-used@example.com',
        password: 'long-enough-password',
        firstName: 'Taylor',
        lastName: 'Morgan',
        termsAccepted: true,
      }),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.registerFromInvite({
        token: 'raw-invite-token',
        accountType: InviteStatusRole.SALES_MANAGER,
        email: 'already-used@example.com',
        password: 'long-enough-password',
        firstName: 'Taylor',
        lastName: 'Morgan',
        termsAccepted: true,
      }),
    ).rejects.toThrow('An account with this email address already exists.');
  });

  it('does not allow a production registration lookup to fall back to a legacy raw invite token', async () => {
    process.env.NODE_ENV = 'production';
    const rawToken = 'legacy-demo-token';
    const prisma = {
      registrationInvite: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaService;
    const service = new AuthService(prisma, {} as JwtService);

    await expect(service.getInviteDetails({ token: rawToken })).rejects.toThrow(
      new BadRequestException('Registration invite is invalid or expired'),
    );
    expect(
      prisma.registrationInvite.findUnique as jest.Mock,
    ).toHaveBeenCalledTimes(1);
    expect(
      prisma.registrationInvite.findUnique as jest.Mock,
    ).toHaveBeenCalledWith({
      where: { token: hashInviteToken(rawToken) },
    });
  });

  it.each(['production', 'missing-flag'])(
    'rejects a recipientless invite in %s',
    async (mode) => {
      if (mode === 'production') process.env.NODE_ENV = 'production';
      else delete process.env.DEV_FEATURES_ENABLED;
      const invite = {
        id: 'invite-1',
        token: hashInviteToken('invite-token'),
        recipientEmail: null,
        roleToCreate: InviteStatusRole.SALES_MANAGER,
        assignedSalesManagerId: 'manager-1',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        usedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      const prisma = {
        registrationInvite: {
          findUnique: jest.fn().mockResolvedValue(invite),
        },
      } as unknown as PrismaService;
      const service = new AuthService(prisma, {} as JwtService);

      await expect(
        service.registerFromInvite({
          token: 'invite-token',
          accountType: InviteStatusRole.SALES_MANAGER,
          email: 'manager@example.com',
          password: 'long-enough-password',
          firstName: 'Taylor',
          lastName: 'Morgan',
          termsAccepted: true,
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'This invitation is not assigned to a recipient. Contact Hercules for a new invitation.',
        ),
      );
    },
  );

  describe('registration password byte limits', () => {
    const input = {
      token: 'invite-token',
      accountType: InviteStatusRole.SALES_MANAGER,
      email: 'manager@example.com',
      firstName: 'Taylor',
      lastName: 'Morgan',
      termsAccepted: true,
    };

    function fixture() {
      const user = {
        id: 'manager-1',
        ...input,
        role: 'SALES_MANAGER',
        status: 'ACTIVE',
        sessionVersion: 0,
      };
      const create = jest.fn().mockResolvedValue(user);
      const transaction = jest.fn(
        (operation: (tx: unknown) => Promise<unknown>) =>
          operation({
            registrationInvite: {
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            user: { create },
          }),
      );
      const prisma = {
        registrationInvite: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'invite-1',
            recipientEmail: input.email,
            roleToCreate: input.accountType,
            expiresAt: new Date('2030-01-01'),
            usedAt: null,
          }),
        },
        $transaction: transaction,
      };
      const jwt = { signAsync: jest.fn().mockResolvedValue('test-token') };
      return {
        transaction,
        create,
        service: new AuthService(
          prisma as unknown as PrismaService,
          jwt as unknown as JwtService,
        ),
      };
    }

    it.each(['a'.repeat(73), 'é'.repeat(37), '🔐'.repeat(19)])(
      'rejects passwords beyond 72 UTF-8 bytes without consuming the invite (%s)',
      async (password) => {
        const f = fixture();
        await expect(
          f.service.registerFromInvite({ ...input, password }),
        ).rejects.toThrow('Choose a password no longer than 72 UTF-8 bytes.');
        expect(f.transaction).not.toHaveBeenCalled();
      },
    );

    it.each(['a'.repeat(72), 'é'.repeat(36), '🔐'.repeat(18)])(
      'accepts passwords exactly at 72 UTF-8 bytes (%s)',
      async (password) => {
        const f = fixture();
        await expect(
          f.service.registerFromInvite({ ...input, password }),
        ).resolves.toMatchObject({ accessToken: 'test-token' });
        expect(f.create).toHaveBeenCalledTimes(1);
      },
    );
  });
});

function uniqueConstraintError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['email'] },
  });
}
