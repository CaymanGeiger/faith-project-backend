import {
  BadRequestException,
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
    const invite = await this.prisma.registrationInvite.findUnique({
      where: { token: dto.token },
      select: {
        roleToCreate: true,
        usedAt: true,
        expiresAt: true,
      },
    });

    if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
      throw new BadRequestException('Registration invite is invalid or expired');
    }

    return { accountType: invite.roleToCreate };
  }

  async registerFromInvite(dto: RegisterFromInviteDto) {
    const invite = await this.prisma.registrationInvite.findUnique({
      where: { token: dto.token },
    });

    if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
      throw new BadRequestException('Registration invite is invalid or expired');
    }

    if (invite.roleToCreate !== dto.accountType) {
      throw new BadRequestException(
        dto.accountType === InviteStatusRole.PROSPECT
          ? 'This invite is for a Sales Manager account'
          : 'This invite is for a Dealer account',
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    if (invite.roleToCreate === InviteStatusRole.SALES_MANAGER) {
      const user = await this.prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            email: dto.email.toLowerCase(),
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone,
            role: UserRole.SALES_MANAGER,
            status: UserStatus.ACTIVE,
            salesManagerProfile: { create: {} },
          },
        });

        await tx.registrationInvite.update({
          where: { id: invite.id },
          data: { usedAt: new Date() },
        });

        return createdUser;
      });

      return this.buildAuthResponse(user);
    }

    if (!dto.companyName?.trim()) {
      throw new BadRequestException('Company name is required for dealer accounts');
    }
    const companyName = dto.companyName.trim();

    const manager = await this.prisma.user.findUnique({
      where: { id: invite.assignedSalesManagerId },
    });

    if (!manager || manager.role !== UserRole.SALES_MANAGER) {
      throw new BadRequestException('Invite is missing a valid sales manager');
    }

    const signupDate = new Date();
    const marketingDueAt = this.addDays(signupDate, 90);
    const jbDueAt = this.addDays(signupDate, 30);

    const user = await this.prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          role: UserRole.PROSPECT,
          status: UserStatus.ACTIVE,
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
            title: 'Sign up for certification classes',
            description: 'Use the Hercules event calendar to choose a class.',
            type: TodoItemType.CLASS_SIGNUP,
            dueAt: this.addDays(signupDate, 14),
            status: TodoItemStatus.OPEN,
          },
          {
            prospectUserId: createdUser.id,
            title: 'Register your equipment',
            description: 'Add your first LG equipment registration.',
            type: TodoItemType.EQUIPMENT_REGISTRATION,
            dueAt: this.addDays(signupDate, 14),
            status: TodoItemStatus.OPEN,
          },
          {
            prospectUserId: createdUser.id,
            title: 'Sign up with JB Warranties',
            description: 'Required within 30 days after signing up.',
            type: TodoItemType.JB_WARRANTIES,
            dueAt: jbDueAt,
            status: TodoItemStatus.OPEN,
          },
          {
            prospectUserId: createdUser.id,
            title: 'Schedule a marketing consultation',
            description: 'Complete the marketing consultation form.',
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

      await tx.registrationInvite.update({
        where: { id: invite.id },
        data: { usedAt: new Date() },
      });

      return createdUser;
    });

    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.passwordHash);
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
    return this.buildAuthResponse(user);
  }

  getMe(user: AuthenticatedUser) {
    return { user };
  }

  logout() {
    return { success: true };
  }

  private async buildAuthResponse(user: AuthenticatedUser) {
    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      role: user.role,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        role: user.role,
        status: user.status,
      },
    };
  }

  private addDays(date: Date, days: number) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }
}
