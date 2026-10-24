/* eslint-disable @typescript-eslint/unbound-method -- These expectations inspect Jest mock call records, not unbound method invocation. */
import { BadRequestException } from '@nestjs/common';
import {
  ClassEnrollmentStatus,
  MarketingSubmissionStatus,
  Prisma,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  const user: AuthenticatedUser = {
    id: 'prospect-1',
    email: 'dealer@example.com',
    firstName: 'Taylor',
    lastName: 'Morgan',
    phone: null,
    role: UserRole.PROSPECT,
    status: UserStatus.ACTIVE,
    termsAcceptedAt: new Date('2026-08-17T00:00:00.000Z'),
    termsVersion: '2026-08-17',
  };

  it('returns distinct onboarding lifecycle facts without changing legacy counts', async () => {
    const profile = {
      userId: user.id,
      jbWarrantiesCompletedAt: new Date('2026-07-20T12:00:00.000Z'),
    };
    const prisma = {
      $transaction: jest.fn((queries: Promise<unknown>[]) =>
        Promise.all(queries),
      ),
      prospectProfile: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(profile),
      },
      todoItem: {
        count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(3),
      },
      classEnrollment: {
        count: jest
          .fn()
          .mockResolvedValueOnce(4)
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(1),
      },
      equipmentRegistration: {
        count: jest.fn().mockResolvedValue(1),
      },
      marketingConsultation: {
        findUnique: jest.fn().mockResolvedValue({
          externalSubmissionStatus: MarketingSubmissionStatus.SUBMITTED,
          submittedAt: new Date('2026-07-21T12:00:00.000Z'),
          completedAt: null,
        }),
      },
    } as unknown as PrismaService;

    const result = await new UsersService(prisma).getOnboardingStatus(user);

    expect(prisma.$transaction as jest.Mock).toHaveBeenCalledTimes(1);
    expect(result.summary).toEqual({
      openTodos: 2,
      completedTodos: 3,
      classEnrollments: 4,
      equipmentRegistrations: 1,
      marketingConsultationStatus: MarketingSubmissionStatus.SUBMITTED,
      trainingSelected: true,
      trainingCompleted: true,
      firstEquipmentRegistered: true,
      jbWarrantiesCompleted: true,
      marketingConsultationSubmitted: true,
      marketingConsultationCompleted: false,
    });
    expect(prisma.classEnrollment.count as jest.Mock).toHaveBeenNthCalledWith(
      2,
      {
        where: {
          prospectUserId: user.id,
          OR: [
            { status: ClassEnrollmentStatus.COMPLETED },
            {
              status: ClassEnrollmentStatus.ENROLLED,
              classSession: { status: { not: 'CANCELED' } },
            },
          ],
        },
      },
    );
    expect(prisma.classEnrollment.count as jest.Mock).toHaveBeenNthCalledWith(
      3,
      {
        where: {
          prospectUserId: user.id,
          status: ClassEnrollmentStatus.COMPLETED,
        },
      },
    );
  });

  it.each([
    {
      required: true,
      verified: true,
      completed: 0,
      selected: 0,
      expected: true,
    },
    {
      required: true,
      verified: false,
      completed: 1,
      selected: 1,
      expected: false,
    },
    {
      required: false,
      verified: false,
      completed: 1,
      selected: 1,
      expected: true,
    },
  ])(
    'uses verified initial training for new dealers and preserves legacy facts: %o',
    async (scenario) => {
      const prisma = {
        $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
        prospectProfile: {
          findUniqueOrThrow: jest.fn().mockResolvedValue({ userId: user.id }),
        },
        todoItem: { count: jest.fn().mockResolvedValue(0) },
        classEnrollment: {
          count: jest
            .fn()
            .mockResolvedValueOnce(scenario.completed)
            .mockResolvedValueOnce(scenario.selected)
            .mockResolvedValueOnce(scenario.completed),
        },
        equipmentRegistration: { count: jest.fn().mockResolvedValue(0) },
        marketingConsultation: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      } as unknown as PrismaService;
      const result = await new UsersService(prisma).getOnboardingStatus({
        ...user,
        onboardingRequired: scenario.required,
        initialTrainingVerifiedAt: scenario.verified ? new Date() : null,
      });
      expect(result.summary.trainingCompleted).toBe(scenario.expected);
      expect(result.summary.trainingSelected).toBe(
        scenario.verified || scenario.selected > 0,
      );
      expect(result.access.restricted).toBe(
        scenario.required && !scenario.verified,
      );
      expect(result.summary.classEnrollments).toBe(scenario.completed);
    },
  );

  it('rejects email changes that bypass verification', async () => {
    const prisma = {
      $transaction: jest.fn((operation: (tx: unknown) => Promise<unknown>) =>
        operation({
          user: {
            update: jest.fn().mockRejectedValue(uniqueConstraintError()),
          },
        }),
      ),
    } as unknown as PrismaService;

    const service = new UsersService(prisma);

    await expect(
      service.updateMe(user, { email: 'already-used@example.com' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.updateMe(user, { email: 'already-used@example.com' }),
    ).rejects.toThrow('Use the verified email change flow');
    expect(prisma.$transaction as jest.Mock).not.toHaveBeenCalled();
  });

  it('erases and suppresses both current and historical email identities', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(user),
        delete: jest.fn().mockResolvedValue(user),
      },
      accountEmailHistory: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ email: 'previous@example.com' }]),
      },
      accountDeletionRequest: {
        create: jest.fn().mockResolvedValue({ id: 'request' }),
        update: jest.fn().mockResolvedValue({}),
      },
      conversation: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      jotformSubmission: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn((operation: (transaction: typeof tx) => unknown) =>
        operation(tx),
      ),
    } as unknown as PrismaService;
    await expect(
      new UsersService(prisma).requestAccountDeletion(user),
    ).resolves.toMatchObject({ completed: true });
    expect(tx.jotformSubmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ownerUserId: user.id,
        },
      }),
    );
    expect(tx.accountDeletionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'previous@example.com',
          status: 'COMPLETED',
        }) as unknown,
      }),
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
