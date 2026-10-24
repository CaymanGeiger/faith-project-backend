import { onboardingAccess } from '../onboarding/onboarding-access';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  CertificationStatus,
  InviteStatusRole,
  TodoItemStatus,
  TodoItemType,
  UserRole,
  UserStatus,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { CURRENT_TERMS_VERSION } from '../legal/legal.constants';
import {
  areDevelopmentFeaturesEnabled,
  isAccountAllowedInRuntime,
} from '../config/development';
import { hashInviteToken } from './invite-token';
import { isPrismaUniqueConstraintError } from '../prisma/prisma-error';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from './authenticated-user';
import { InviteDetailsDto } from './dto/invite-details.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterFromInviteDto } from './dto/register-from-invite.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async getInviteDetails(dto: InviteDetailsDto) {
    const invite = await this.findInviteForToken(dto.token);

    if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
      throw new BadRequestException(
        'Registration invite is invalid or expired',
      );
    }

    return { accountType: invite.roleToCreate };
  }

  async registerFromInvite(dto: RegisterFromInviteDto) {
    const invite = await this.findInviteForToken(dto.token);

    if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
      throw new BadRequestException(
        'Registration invite is invalid or expired',
      );
    }

    if (invite.roleToCreate !== dto.accountType) {
      throw new BadRequestException(
        dto.accountType === InviteStatusRole.PROSPECT
          ? 'This invite is for a Sales Manager account'
          : 'This invite is for a Dealer account',
      );
    }

    const email = dto.email.trim().toLowerCase();
    if (!areDevelopmentFeaturesEnabled() && !invite.recipientEmail?.trim()) {
      throw new BadRequestException(
        'This invitation is not assigned to a recipient. Contact Hercules for a new invitation.',
      );
    }
    if (!isAccountAllowedInRuntime(email)) {
      throw new BadRequestException(
        'Registration invite is invalid or expired',
      );
    }
    if (
      invite.recipientEmail &&
      invite.recipientEmail.trim().toLowerCase() !== email
    ) {
      throw new BadRequestException(
        'This invitation is assigned to a different email address.',
      );
    }

    if (!dto.termsAccepted) {
      throw new BadRequestException(
        'You must accept the Terms of Use and Privacy Notice to create an account',
      );
    }

    if (Buffer.byteLength(dto.password, 'utf8') > 72) {
      throw new BadRequestException(
        'Choose a password no longer than 72 UTF-8 bytes.',
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const policyAcceptedAt = new Date();

    if (invite.roleToCreate === InviteStatusRole.SALES_MANAGER) {
      const user = await this.runRegistration(() =>
        this.prisma.$transaction(async (tx) => {
          const claimedInvite = await tx.registrationInvite.updateMany({
            where: {
              id: invite.id,
              roleToCreate: InviteStatusRole.SALES_MANAGER,
              ...(invite.recipientEmail
                ? { recipientEmail: invite.recipientEmail }
                : {}),
              usedAt: null,
              expiresAt: { gt: new Date() },
            },
            data: { usedAt: new Date() },
          });
          if (claimedInvite.count !== 1) {
            throw new BadRequestException(
              'Registration invite is invalid or expired',
            );
          }

          return tx.user.create({
            data: {
              email,
              passwordHash,
              firstName: dto.firstName,
              lastName: dto.lastName,
              phone: dto.phone,
              role: UserRole.SALES_MANAGER,
              status: UserStatus.ACTIVE,
              termsAcceptedAt: policyAcceptedAt,
              termsVersion: CURRENT_TERMS_VERSION,
              privacyPolicyAcceptedAt: policyAcceptedAt,
              salesManagerProfile: { create: {} },
            },
          });
        }),
      );

      return this.buildAuthResponse(user);
    }

    if (!dto.companyName?.trim()) {
      throw new BadRequestException(
        'Company name is required for dealer accounts',
      );
    }
    const companyName = dto.companyName.trim();

    const signupDate = new Date();
    const marketingDueAt = this.addDays(signupDate, 90);
    const jbDueAt = this.addDays(signupDate, 30);

    const user = await this.runRegistration(() =>
      this.prisma.$transaction(async (tx) => {
        const claimedInvite = await tx.registrationInvite.updateMany({
          where: {
            id: invite.id,
            roleToCreate: InviteStatusRole.PROSPECT,
            ...(invite.recipientEmail
              ? { recipientEmail: invite.recipientEmail }
              : {}),
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { usedAt: new Date() },
        });
        if (claimedInvite.count !== 1) {
          throw new BadRequestException(
            'Registration invite is invalid or expired',
          );
        }

        const manager = await tx.user.findFirst({
          where: {
            id: invite.assignedSalesManagerId,
            role: UserRole.SALES_MANAGER,
            status: UserStatus.ACTIVE,
          },
          select: { id: true },
        });
        if (!manager) {
          throw new BadRequestException(
            'Invite is missing a valid sales manager',
          );
        }

        const createdUser = await tx.user.create({
          data: {
            email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone,
            role: UserRole.PROSPECT,
            onboardingRequired: true,
            status: UserStatus.ACTIVE,
            termsAcceptedAt: policyAcceptedAt,
            termsVersion: CURRENT_TERMS_VERSION,
            privacyPolicyAcceptedAt: policyAcceptedAt,
            prospectProfile: {
              create: {
                companyName,
                signupDate,
                assignedSalesManagerId: manager.id,
                certificationStatus: CertificationStatus.ONBOARDING,
                marketingConsultationDueAt: marketingDueAt,
                jbWarrantiesDueAt: jbDueAt,
              },
            },
            marketingConsults: { create: {} },
          },
        });

        await tx.todoItem.createMany({
          data: [
            {
              prospectUserId: createdUser.id,
              title: 'Choose Your LG Training',
              description:
                'Save your preferred LG training session so Hercules can confirm the final schedule and enrollment.',
              type: TodoItemType.CLASS_SIGNUP,
              dueAt: this.addDays(signupDate, 14),
              status: TodoItemStatus.OPEN,
            },
            {
              prospectUserId: createdUser.id,
              title: 'Add Your First LG System',
              description:
                'Save your first equipment record in Hercules Honors Rewards for dealer onboarding.',
              type: TodoItemType.EQUIPMENT_REGISTRATION,
              dueAt: this.addDays(signupDate, 14),
              status: TodoItemStatus.OPEN,
            },
            {
              prospectUserId: createdUser.id,
              title: 'Record Your JB Warranties Setup',
              description:
                'After completing JB Warranties setup, record that completion for your Hercules onboarding.',
              type: TodoItemType.JB_WARRANTIES,
              dueAt: jbDueAt,
              status: TodoItemStatus.OPEN,
            },
            {
              prospectUserId: createdUser.id,
              title: 'Share Marketing Availability',
              description:
                'Share three times that work for you so Hercules can connect you with marketing resources.',
              type: TodoItemType.MARKETING_CONSULTATION,
              dueAt: marketingDueAt,
              status: TodoItemStatus.OPEN,
            },
          ],
        });

        await tx.leadRecord.create({
          data: {
            prospectUserId: createdUser.id,
            assignedSalesManagerId: manager.id,
            status: 'NEW',
          },
        });

        await tx.conversation.create({
          data: {
            participants: {
              createMany: {
                data: [{ userId: createdUser.id }, { userId: manager.id }],
              },
            },
          },
        });

        return createdUser;
      }),
    );

    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
    });

    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      !isAccountAllowedInRuntime(user.email)
    ) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.buildAuthResponse(user);
  }

  async refresh(user: AuthenticatedUser) {
    const response = await this.buildAuthResponse(user);
    await this.logout(user);
    return response;
  }

  getMe(user: AuthenticatedUser) {
    const { sessionTokenHash: _privateHash, ...publicUser } = user;
    void _privateHash;
    return { user: { ...publicUser, onboarding: onboardingAccess(user) } };
  }

  async logout(user: AuthenticatedUser) {
    if (user.sessionTokenHash && user.sessionExpiresAt) {
      await this.prisma.$transaction([
        this.prisma.revokedSession.upsert({
          where: { tokenHash: user.sessionTokenHash },
          create: {
            tokenHash: user.sessionTokenHash,
            expiresAt: new Date(user.sessionExpiresAt * 1000),
          },
          update: {},
        }),
        this.prisma.pushDevice.deleteMany({
          where: { userId: user.id, sessionTokenHash: user.sessionTokenHash },
        }),
      ]);
    }
    await this.prisma.revokedSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return { success: true };
  }

  private async buildAuthResponse(user: AuthenticatedUser) {
    const accessToken = await this.jwtService.signAsync({
      jti: randomUUID(),
      sub: user.id,
      role: user.role,
      sv: user.sessionVersion ?? 0,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        onboarding: onboardingAccess(user),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        role: user.role,
        status: user.status,
        termsAcceptedAt: user.termsAcceptedAt,
        termsVersion: user.termsVersion,
      },
    };
  }

  private async findInviteForToken(rawToken: string) {
    const developmentEnabled = areDevelopmentFeaturesEnabled();
    if (
      !developmentEnabled &&
      ['prospect-demo-token', 'manager-demo-token'].includes(rawToken)
    )
      return null;
    const byHash = await this.prisma.registrationInvite.findUnique({
      where: { token: hashInviteToken(rawToken) },
    });
    if (
      byHash &&
      !isAccountAllowedInRuntime(byHash.recipientEmail ?? undefined)
    )
      return null;
    if (byHash || !developmentEnabled) {
      return byHash;
    }

    // Legacy raw tokens are available only under the explicit development gate.
    return this.prisma.registrationInvite.findUnique({
      where: { token: rawToken },
    });
  }

  private async runRegistration<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isPrismaUniqueConstraintError(error, 'email')) {
        throw new ConflictException(
          'An account with this email address already exists.',
        );
      }
      throw error;
    }
  }

  private addDays(date: Date, days: number) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }
}
