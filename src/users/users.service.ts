import { onboardingAccess } from '../onboarding/onboarding-access';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  AccountDeletionRequestSource,
  AccountDeletionRequestStatus,
  ClassEnrollmentStatus,
  TodoItemStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CURRENT_TERMS_VERSION } from '../legal/legal.constants';
import { eraseOwnedSubmissions } from '../jotform/submission-ownership';
import { isPrismaUniqueConstraintError } from '../prisma/prisma-error';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { assertPreviewOperationsConfigured } from '../config/preview-operations';

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
        onboardingRequired: true,
        initialTrainingVerifiedAt: true,
        termsAcceptedAt: true,
        termsVersion: true,
        privacyPolicyAcceptedAt: true,
        prospectProfile: true,
        salesManagerProfile: true,
      },
    });

    return { user: { ...fullUser, onboarding: onboardingAccess(fullUser) } };
  }

  async updateMe(user: AuthenticatedUser, dto: UpdateMeDto) {
    if (dto.email && dto.email.trim().toLowerCase() !== user.email) {
      throw new BadRequestException(
        'Use the verified email change flow to update your email.',
      );
    }
    let updatedUser;
    try {
      updatedUser = await this.prisma.$transaction(async (tx) => {
        const nextUser = await tx.user.update({
          where: { id: user.id },
          data: {
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
            onboardingRequired: true,
            initialTrainingVerifiedAt: true,
            termsAcceptedAt: true,
            termsVersion: true,
            privacyPolicyAcceptedAt: true,
          },
        });

        if (dto.companyName) {
          if (user.role !== UserRole.PROSPECT) {
            throw new ForbiddenException(
              'Only prospects have a company profile',
            );
          }

          await tx.prospectProfile.update({
            where: { userId: user.id },
            data: { companyName: dto.companyName },
          });
        }

        return nextUser;
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error, 'email')) {
        throw new ConflictException('That email address is already in use.');
      }
      throw error;
    }

    return {
      user: { ...updatedUser, onboarding: onboardingAccess(updatedUser) },
    };
  }

  async acceptLegalTerms(user: AuthenticatedUser) {
    const acceptedAt = new Date();
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        termsAcceptedAt: acceptedAt,
        termsVersion: CURRENT_TERMS_VERSION,
        privacyPolicyAcceptedAt: acceptedAt,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        status: true,
        onboardingRequired: true,
        initialTrainingVerifiedAt: true,
        termsAcceptedAt: true,
        termsVersion: true,
      },
    });

    return {
      user: { ...updatedUser, onboarding: onboardingAccess(updatedUser) },
    };
  }

  async requestAccountDeletion(user: AuthenticatedUser) {
    const account = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        role: true,
      },
    });

    if (account.role === UserRole.PROSPECT) {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${account.id} FOR UPDATE`;
        const currentAccount = await tx.user.findUniqueOrThrow({
          where: { id: account.id },
          select: { id: true, email: true, role: true },
        });
        const request = await tx.accountDeletionRequest.create({
          data: {
            userId: currentAccount.id,
            email: currentAccount.email,
            role: currentAccount.role,
            source: AccountDeletionRequestSource.IN_APP,
            status: AccountDeletionRequestStatus.PENDING_VERIFICATION,
          },
        });

        await tx.conversation.deleteMany({
          where: {
            participants: {
              some: { userId: account.id },
            },
          },
        });
        const history = await tx.accountEmailHistory.findMany({
          where: { userId: account.id },
          select: { email: true },
        });
        const emails = [
          ...new Set([
            currentAccount.email,
            ...history.map((row) => row.email),
          ]),
        ].sort();
        const erased = await eraseOwnedSubmissions(tx, account.id, emails);
        if (!erased) {
          // Throw inside the transaction so provisional deletes/requests roll
          // back when preview cannot complete the required operations review.
          assertPreviewOperationsConfigured();
          await tx.user.update({
            where: { id: account.id },
            data: {
              status: UserStatus.DISABLED,
              sessionVersion: { increment: 1 },
            },
          });
          await tx.pushDevice.deleteMany({ where: { userId: account.id } });
          return {
            requestId: request.id,
            completed: false,
            message:
              'Your access has been closed. Hercules must verify ownership of imported records before completing your data deletion.',
          };
        }
        for (const email of emails) {
          if (email !== currentAccount.email)
            await tx.accountDeletionRequest.create({
              data: {
                email,
                role: currentAccount.role,
                source: AccountDeletionRequestSource.IN_APP,
                status: AccountDeletionRequestStatus.COMPLETED,
                completedAt: new Date(),
              },
            });
        }
        await tx.user.delete({ where: { id: currentAccount.id } });

        await tx.accountDeletionRequest.update({
          where: { id: request.id },
          data: {
            status: AccountDeletionRequestStatus.COMPLETED,
            completedAt: new Date(),
          },
        });

        return {
          requestId: request.id,
          completed: true,
          message:
            'Your account and associated app data have been deleted. Certain records may be retained only where required by law.',
        };
      });
      if (!result.completed)
        void this.notifyOperations({
          event: 'account_deletion_requested',
          requestId: result.requestId,
          text: 'Hercules Honors Rewards: an account deletion needs imported-record ownership verification.',
        });
      return { completed: result.completed, message: result.message };
    }

    assertPreviewOperationsConfigured();
    const deletionRequest = await this.prisma.$transaction(async (tx) => {
      const request = await tx.accountDeletionRequest.create({
        data: {
          userId: account.id,
          email: account.email,
          role: account.role,
          source: AccountDeletionRequestSource.IN_APP,
          status: AccountDeletionRequestStatus.PENDING_REASSIGNMENT,
        },
      });
      await tx.user.update({
        where: { id: account.id },
        data: { status: UserStatus.DISABLED },
      });
      return request;
    });

    void this.notifyOperations({
      event: 'account_deletion_requested',
      requestId: deletionRequest.id,
      text: 'Hercules Honors Rewards: a manager account deletion request needs reassignment and completion.',
    });

    return {
      completed: false,
      message:
        'Your access has been closed and your deletion request is in progress. Hercules will complete it after reassigning any active dealer accounts.',
    };
  }

  async requestExternalAccountDeletion(email: string) {
    assertPreviewOperationsConfigured();
    const normalizedEmail = email.trim().toLowerCase();
    const account = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, role: true },
    });

    const requestEmail = account?.email ?? normalizedEmail;
    const existingRequest = await this.prisma.accountDeletionRequest.findFirst({
      where: {
        ...(account
          ? { userId: account.id }
          : { userId: null, email: requestEmail }),
        status: { not: AccountDeletionRequestStatus.COMPLETED },
      },
      orderBy: { requestedAt: 'desc' },
    });

    if (!existingRequest) {
      const request = await this.prisma.accountDeletionRequest.create({
        data: {
          userId: account?.id,
          email: requestEmail,
          role: account?.role,
          source: AccountDeletionRequestSource.WEB,
          status: AccountDeletionRequestStatus.PENDING_VERIFICATION,
        },
      });

      void this.notifyOperations({
        event: 'account_deletion_requested',
        requestId: request.id,
        text: 'Hercules Honors Rewards: an account data deletion request needs identity verification.',
      });
    }

    return {
      message:
        'If an account matches this email address, Hercules will contact you to verify and complete the deletion request.',
    };
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
          OR: [
            { status: ClassEnrollmentStatus.COMPLETED },
            {
              status: ClassEnrollmentStatus.ENROLLED,
              classSession: { status: { not: 'CANCELED' } },
            },
          ],
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

    const verifiedInitialTraining = Boolean(user.initialTrainingVerifiedAt);
    return {
      profile,
      access: onboardingAccess(
        user,
        activeClasses > 0 || verifiedInitialTraining,
      ),
      summary: {
        openTodos,
        completedTodos,
        classEnrollments: classes,
        equipmentRegistrations: equipmentRecords,
        marketingConsultationStatus:
          consultation?.externalSubmissionStatus ?? 'NOT_SUBMITTED',
        trainingSelected: activeClasses > 0 || verifiedInitialTraining,
        trainingCompleted: user.onboardingRequired
          ? verifiedInitialTraining
          : verifiedInitialTraining || completedClasses > 0,
        firstEquipmentRegistered: equipmentRecords > 0,
        jbWarrantiesCompleted: Boolean(profile.jbWarrantiesCompletedAt),
        marketingConsultationSubmitted: Boolean(consultation?.submittedAt),
        marketingConsultationCompleted: Boolean(consultation?.completedAt),
      },
    };
  }

  private async notifyOperations(payload: {
    event: 'account_deletion_requested';
    requestId: string;
    text: string;
  }) {
    const webhookUrl = process.env.OPERATIONS_WEBHOOK_URL;
    if (!webhookUrl) {
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`Operations webhook responded with ${response.status}`);
      }
    } catch {
      // The request stays in the database queue even when an external alert fails.
      console.error(
        'Unable to notify operations about an account deletion request',
      );
    }
  }
}
