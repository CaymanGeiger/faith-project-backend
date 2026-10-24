/* eslint-disable @typescript-eslint/unbound-method -- These expectations inspect Jest mock call records, not unbound method invocation. */
import { Reflector } from '@nestjs/core';
import { BEFORE_TRAINING_KEY } from '../onboarding/onboarding-access';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole, UserStatus } from '@prisma/client';
import { ExecutionContext } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  const activeUser = {
    id: 'dealer-1',
    email: 'dealer@example.com',
    firstName: 'Taylor',
    lastName: 'Morgan',
    phone: null,
    role: UserRole.PROSPECT,
    status: UserStatus.ACTIVE,
    termsAcceptedAt: new Date('2026-08-17T00:00:00.000Z'),
    termsVersion: '2026-08-17',
  };

  function makeContext(request: {
    headers: { authorization?: string };
    user?: unknown;
  }) {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  it('rejects requests without a bearer token before querying the database', async () => {
    const jwt = { verifyAsync: jest.fn() } as unknown as JwtService;
    const prisma = {
      revokedSession: { findUnique: jest.fn().mockResolvedValue(null) },
      user: { findUnique: jest.fn() },
    } as unknown as PrismaService;

    await expect(
      new JwtAuthGuard(jwt, prisma).canActivate(makeContext({ headers: {} })),
    ).rejects.toThrow(new UnauthorizedException('Missing bearer token'));
    expect(prisma.user.findUnique as jest.Mock).not.toHaveBeenCalled();
  });

  it('rejects invalid tokens without exposing verification details', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockRejectedValue(new Error('expired')),
    } as unknown as JwtService;
    const prisma = {
      revokedSession: { findUnique: jest.fn().mockResolvedValue(null) },
      user: { findUnique: jest.fn() },
    } as unknown as PrismaService;

    await expect(
      new JwtAuthGuard(jwt, prisma).canActivate(
        makeContext({ headers: { authorization: 'Bearer expired-token' } }),
      ),
    ).rejects.toThrow(new UnauthorizedException('Invalid bearer token'));
    expect(prisma.user.findUnique as jest.Mock).not.toHaveBeenCalled();
  });

  it('rejects disabled users even when their token is otherwise valid', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: activeUser.id }),
    } as unknown as JwtService;
    const prisma = {
      revokedSession: { findUnique: jest.fn().mockResolvedValue(null) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          ...activeUser,
          status: UserStatus.DISABLED,
        }),
      },
    } as unknown as PrismaService;

    await expect(
      new JwtAuthGuard(jwt, prisma).canActivate(
        makeContext({ headers: { authorization: 'Bearer valid-token' } }),
      ),
    ).rejects.toThrow(new UnauthorizedException('User is not active'));
  });

  it('rejects an existing demo session after development features are disabled', async () => {
    const savedFlag = process.env.DEV_FEATURES_ENABLED;
    process.env.DEV_FEATURES_ENABLED = 'false';
    try {
      const jwt = {
        verifyAsync: jest.fn().mockResolvedValue({ sub: activeUser.id }),
      } as unknown as JwtService;
      const prisma = {
        revokedSession: { findUnique: jest.fn().mockResolvedValue(null) },
        user: {
          findUnique: jest.fn().mockResolvedValue({
            ...activeUser,
            email: 'manager@hercules.local',
          }),
        },
      } as unknown as PrismaService;
      await expect(
        new JwtAuthGuard(jwt, prisma).canActivate(
          makeContext({ headers: { authorization: 'Bearer demo-token' } }),
        ),
      ).rejects.toThrow(new UnauthorizedException('User is not active'));
    } finally {
      if (savedFlag === undefined) delete process.env.DEV_FEATURES_ENABLED;
      else process.env.DEV_FEATURES_ENABLED = savedFlag;
    }
  });

  it('attaches the active user selected from the database to the request', async () => {
    const request: {
      headers: { authorization: string };
      user?: unknown;
    } = { headers: { authorization: 'Bearer valid-token' } };
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: activeUser.id }),
    } as unknown as JwtService;
    const prisma = {
      revokedSession: { findUnique: jest.fn().mockResolvedValue(null) },
      user: { findUnique: jest.fn().mockResolvedValue(activeUser) },
    } as unknown as PrismaService;

    await expect(
      new JwtAuthGuard(jwt, prisma).canActivate(makeContext(request)),
    ).resolves.toBe(true);
    expect(prisma.user.findUnique as jest.Mock).toHaveBeenCalledWith({
      where: { id: activeUser.id },
      select: expect.objectContaining({
        id: true,
        status: true,
        termsVersion: true,
      }) as unknown,
    });
    expect(request.user).toEqual(expect.objectContaining(activeUser));
  });

  it('rejects a token issued before an account security change', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: activeUser.id, sv: 0 }),
    } as unknown as JwtService;
    const prisma = {
      revokedSession: { findUnique: jest.fn().mockResolvedValue(null) },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...activeUser, sessionVersion: 1 }),
      },
    } as unknown as PrismaService;
    await expect(
      new JwtAuthGuard(jwt, prisma).canActivate(
        makeContext({ headers: { authorization: 'Bearer old-token' } }),
      ),
    ).rejects.toThrow('Please sign in again');
  });
});

describe('Initial-training API enforcement', () => {
  it.each([false, true])(
    'requires explicit pre-training access metadata: allowed=%s',
    async (allowed) => {
      class RestrictedRoute {}
      if (allowed)
        Reflect.defineMetadata(BEFORE_TRAINING_KEY, true, RestrictedRoute);
      const req = { headers: { authorization: 'Bearer session' } };
      const context = {
        switchToHttp: () => ({ getRequest: () => req }),
        getClass: () => RestrictedRoute,
        getHandler: () => () => undefined,
      } as unknown as ExecutionContext;
      const user = {
        id: 'dealer',
        role: 'PROSPECT',
        status: 'ACTIVE',
        sessionVersion: 0,
        onboardingRequired: true,
        initialTrainingVerifiedAt: null as Date | null,
      };
      const prisma = {
        user: {
          findUnique: jest
            .fn()
            .mockImplementation(() => Promise.resolve({ ...user })),
        },
        revokedSession: { findUnique: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService;
      const guard = new JwtAuthGuard(
        {
          verifyAsync: jest.fn().mockResolvedValue({ sub: 'dealer', sv: 0 }),
        } as unknown as JwtService,
        prisma,
        new Reflector(),
      );
      if (allowed) await expect(guard.canActivate(context)).resolves.toBe(true);
      else
        await expect(guard.canActivate(context)).rejects.toMatchObject({
          response: { code: 'INITIAL_TRAINING_REQUIRED' },
        });
      user.initialTrainingVerifiedAt = new Date();
      await expect(guard.canActivate(context)).resolves.toBe(true);
    },
  );
});
