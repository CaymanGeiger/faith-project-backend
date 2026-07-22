import { Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser) {
    const sessions = await this.prisma.classSession.findMany({
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
    await this.prisma.classSession.findUniqueOrThrow({
      where: { id: classSessionId },
    });

    const enrollment = await this.prisma.classEnrollment.upsert({
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

    await this.prisma.todoItem.updateMany({
      where: {
        prospectUserId: user.id,
        type: 'CLASS_SIGNUP',
        completedAt: null,
      },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    await this.prisma.prospectProfile.update({
      where: { userId: user.id },
      data: { certificationStatus: 'IN_PROGRESS' },
    });

    return { enrollment };
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
    const sessionWithEnrollments = session as T & { enrollments?: unknown[] };

    return {
      ...session,
      isEnrolled:
        role === UserRole.PROSPECT
          ? (sessionWithEnrollments.enrollments?.length ?? 0) > 0
          : undefined,
    };
  }
}
