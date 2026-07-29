import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  ClassEnrollmentStatus,
  MarketingSubmissionStatus,
  TodoItemStatus,
  UserRole,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateMeDto } from './dto/update-me.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(user: AuthenticatedUser) {
    const fullUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        status: true,
        lastLoginAt: true,
        prospectProfile: true,
        salesManagerProfile: true,
      },
    });

    return { user: fullUser };
  }

  async updateMe(user: AuthenticatedUser, dto: UpdateMeDto) {
    const updatedUser = await this.prisma.$transaction(async (tx) => {
      const nextUser = await tx.user.update({
        where: { id: user.id },
        data: {
          email: dto.email?.toLowerCase(),
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          status: true,
        },
      });

      if (dto.companyName) {
        if (user.role !== UserRole.PROSPECT) {
          throw new ForbiddenException('Only prospects have a company profile');
        }

        await tx.prospectProfile.update({
          where: { userId: user.id },
          data: { companyName: dto.companyName },
        });
      }

      return nextUser;
    });

    return { user: updatedUser };
  }

  async getOnboardingStatus(user: AuthenticatedUser) {
    const [
      profile,
      openTodos,
      completedTodos,
      classes,
      activeClasses,
      completedClasses,
      equipmentRecords,
      consultation,
    ] = await this.prisma.$transaction([
      this.prisma.prospectProfile.findUniqueOrThrow({
        where: { userId: user.id },
      }),
      this.prisma.todoItem.count({
        where: { prospectUserId: user.id, status: TodoItemStatus.OPEN },
      }),
      this.prisma.todoItem.count({
        where: { prospectUserId: user.id, status: TodoItemStatus.COMPLETED },
      }),
      this.prisma.classEnrollment.count({
        where: { prospectUserId: user.id },
      }),
      this.prisma.classEnrollment.count({
        where: {
          prospectUserId: user.id,
          status: {
            in: [
              ClassEnrollmentStatus.ENROLLED,
              ClassEnrollmentStatus.COMPLETED,
            ],
          },
        },
      }),
      this.prisma.classEnrollment.count({
        where: {
          prospectUserId: user.id,
          status: ClassEnrollmentStatus.COMPLETED,
        },
      }),
      this.prisma.equipmentRegistration.count({
        where: { prospectUserId: user.id },
      }),
      this.prisma.marketingConsultation.findUnique({
        where: { prospectUserId: user.id },
      }),
    ]);

    return {
      profile,
      summary: {
        openTodos,
        completedTodos,
        classEnrollments: classes,
        equipmentRegistrations: equipmentRecords,
        marketingConsultationStatus:
          consultation?.externalSubmissionStatus ?? 'NOT_SUBMITTED',
        trainingSelected: activeClasses > 0,
        trainingCompleted: completedClasses > 0,
        firstEquipmentRegistered: equipmentRecords > 0,
        jbWarrantiesCompleted: Boolean(profile.jbWarrantiesCompletedAt),
        marketingConsultationSubmitted:
          Boolean(consultation?.submittedAt) &&
          (consultation?.externalSubmissionStatus ===
            MarketingSubmissionStatus.SUBMITTED ||
            consultation?.externalSubmissionStatus ===
              MarketingSubmissionStatus.COMPLETED),
        marketingConsultationCompleted: Boolean(consultation?.completedAt),
      },
    };
  }
}
