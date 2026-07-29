import {
  ClassEnrollmentStatus,
  MarketingSubmissionStatus,
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

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
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
    expect(prisma.classEnrollment.count).toHaveBeenNthCalledWith(2, {
      where: {
        prospectUserId: user.id,
        status: {
          in: [ClassEnrollmentStatus.ENROLLED, ClassEnrollmentStatus.COMPLETED],
        },
      },
    });
    expect(prisma.classEnrollment.count).toHaveBeenNthCalledWith(3, {
      where: {
        prospectUserId: user.id,
        status: ClassEnrollmentStatus.COMPLETED,
      },
    });
  });
});
