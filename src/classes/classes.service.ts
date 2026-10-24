import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ClassEnrollmentStatus,
  ClassSessionStatus,
  UserRole,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser) {
    const sessions = await this.prisma.classSession.findMany({
      where: {
        OR: [
          { status: 'SCHEDULED', startsAt: { gt: new Date() } },
          ...(user.role === UserRole.PROSPECT
            ? [
                {
                  enrollments: {
                    some: {
                      prospectUserId: user.id,
                      status: {
                        in: [
                          ClassEnrollmentStatus.ENROLLED,
                          ClassEnrollmentStatus.COMPLETED,
                        ],
                      },
                    },
                  },
                },
              ]
            : []),
        ],
      },
      orderBy: { startsAt: 'asc' },
      include:
        user.role === UserRole.PROSPECT
          ? { enrollments: { where: { prospectUserId: user.id } } }
          : undefined,
    });

    return {
      classes: sessions.map((session) =>
        this.withEnrollmentFlag(session, user.role),
      ),
    };
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const session = await this.prisma.classSession.findUnique({
      where: { id },
      include:
        user.role === UserRole.PROSPECT
          ? { enrollments: { where: { prospectUserId: user.id } } }
          : undefined,
    });

    if (!session) {
      throw new NotFoundException('Class session not found');
    }

    return {
      class: this.withEnrollmentFlag(session, user.role),
    };
  }

  async enroll(classSessionId: string, user: AuthenticatedUser) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ClassSession" WHERE "id" = ${classSessionId} FOR UPDATE`;
      const classSession = await tx.classSession.findUnique({
        where: { id: classSessionId },
      });
      if (!classSession) {
        throw new NotFoundException('Class session not found');
      }
      if (
        classSession.status !== ClassSessionStatus.SCHEDULED ||
        classSession.startsAt <= new Date()
      ) {
        throw new ConflictException(
          'This training session is no longer available. Choose another session or contact Hercules for help.',
        );
      }

      const existingEnrollment = await tx.classEnrollment.findUnique({
        where: {
          classSessionId_prospectUserId: {
            classSessionId,
            prospectUserId: user.id,
          },
        },
        include: { classSession: true },
      });
      if (existingEnrollment?.status === ClassEnrollmentStatus.COMPLETED) {
        return { enrollment: existingEnrollment };
      }

      const enrollment = await tx.classEnrollment.upsert({
        where: {
          classSessionId_prospectUserId: {
            classSessionId,
            prospectUserId: user.id,
          },
        },
        update: { status: 'ENROLLED' },
        create: {
          classSessionId,
          prospectUserId: user.id,
          status: 'ENROLLED',
        },
        include: { classSession: true },
      });

      await tx.todoItem.updateMany({
        where: {
          prospectUserId: user.id,
          type: 'CLASS_SIGNUP',
          completedAt: null,
        },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });

      await tx.prospectProfile.updateMany({
        where: { userId: user.id, certificationStatus: { not: 'CERTIFIED' } },
        data: { certificationStatus: 'IN_PROGRESS' },
      });

      return { enrollment };
    });
  }

  async myEnrollments(user: AuthenticatedUser) {
    const enrollments = await this.prisma.classEnrollment.findMany({
      where: { prospectUserId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { classSession: true },
    });

    return { enrollments };
  }

  private withEnrollmentFlag<T extends object>(session: T, role: UserRole) {
    const sessionWithEnrollments = session as T & {
      enrollments?: Array<{ status: string }>;
    };
    const enrollment = sessionWithEnrollments.enrollments?.[0];

    return {
      ...session,
      isEnrolled:
        role === UserRole.PROSPECT
          ? (sessionWithEnrollments.enrollments?.length ?? 0) > 0
          : undefined,
      enrollmentStatus:
        role === UserRole.PROSPECT ? (enrollment?.status ?? null) : undefined,
    };
  }
}
