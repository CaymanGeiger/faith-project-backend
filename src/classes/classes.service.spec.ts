import {
  ClassEnrollmentStatus,
  ClassSessionStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import { ClassesService } from './classes.service';

describe('ClassesService', () => {
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

  it('exposes the current enrollment status with the existing enrolled flag', async () => {
    const classSession = {
      id: 'class-1',
      title: 'LG Training',
      description: 'Dealer training',
      startsAt: new Date('2026-08-01T15:00:00.000Z'),
      endsAt: new Date('2026-08-01T18:00:00.000Z'),
      virtualUrl: 'https://lghvac.com/training',
      status: ClassSessionStatus.SCHEDULED,
      createdAt: new Date('2026-07-01T12:00:00.000Z'),
      updatedAt: new Date('2026-07-01T12:00:00.000Z'),
      enrollments: [{ status: ClassEnrollmentStatus.COMPLETED }],
    };
    const prisma = {
      classSession: {
        findMany: jest.fn().mockResolvedValue([classSession]),
      },
    } as unknown as PrismaService;

    const result = await new ClassesService(prisma).list(user);

    expect(result.classes[0]).toMatchObject({
      id: classSession.id,
      isEnrolled: true,
      enrollmentStatus: ClassEnrollmentStatus.COMPLETED,
    });
  });
});
