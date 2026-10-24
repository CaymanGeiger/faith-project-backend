import { hashSecurityCode } from './activation-challenge';
import { CURRENT_TERMS_VERSION } from '../legal/legal.constants';
import { acquireJotformPrivacyLock } from '../jotform/jotform-privacy';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityMailService } from './security-mail.service';
import {
  ActivationConfirmDto,
  EmailChangeRequestDto,
  RecoveryConfirmDto,
} from './security.dto';
import { isPrismaUniqueConstraintError } from '../prisma/prisma-error';
import { encryptDeliveryCode, decryptDeliveryCode } from './security-code';

const genericResponse = {
  message:
    'If an active account matches, a verification code will be emailed. Check your inbox and spam folder.',
};
const invalidCode =
  'This code is invalid or expired. Request a new code and try again.';

@Injectable()
export class AccountSecurityService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AccountSecurityService.name);
  private timer?: ReturnType<typeof setInterval>;
  private delivering = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: SecurityMailService,
  ) {}

  onApplicationBootstrap() {
    if (!process.env.SMTP_HOST) return;
    this.timer = setInterval(() => {
      void this.deliverPendingMail().catch(() =>
        this.logger.error('SECURITY_EMAIL_WORKER_FAILED'),
      );
    }, 5_000);
    this.timer.unref();
  }
  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  async deliverPendingMail() {
    if (this.delivering) return;
    this.delivering = true;
    try {
      const pending = await this.prisma.securityChallenge.findMany({
        where: {
          deliveryCode: { not: null },
          mailNextAttemptAt: { lte: new Date() },
          expiresAt: { gt: new Date() },
          OR: [
            { mailLeaseUntil: null },
            { mailLeaseUntil: { lt: new Date() } },
          ],
        },
        include: { user: true },
        take: 20,
      });
      for (const challenge of pending) {
        const mailLeaseUntil = new Date(Date.now() + 60_000);
        const where = {
          id: challenge.id,
          codeHash: challenge.codeHash,
          deliveryCode: challenge.deliveryCode,
        };
        const claim = await this.prisma.securityChallenge.updateMany({
          where: {
            ...where,
            mailNextAttemptAt: { lte: new Date() },
            OR: [
              { mailLeaseUntil: null },
              { mailLeaseUntil: { lt: new Date() } },
            ],
          },
          data: { mailLeaseUntil },
        });
        if (!claim.count) continue;
        try {
          if (
            (challenge.purpose === 'ACCOUNT_ACTIVATION'
              ? challenge.user.status === 'INVITED'
              : challenge.user.status === 'ACTIVE') &&
            challenge.user.sessionVersion === challenge.sessionVersion
          ) {
            const code = decryptDeliveryCode(
              challenge.deliveryCode!,
              `${challenge.userId}:${challenge.purpose}:${challenge.targetEmail}`,
            );
            await this.mail.sendCode(
              challenge.targetEmail,
              code,
              challenge.purpose,
            );
          }
          await this.prisma.securityChallenge.updateMany({
            where: { ...where, mailLeaseUntil },
            data: { deliveryCode: null, mailLeaseUntil: null },
          });
        } catch {
          const mailAttempts = challenge.mailAttempts + 1;
          await this.prisma.securityChallenge.updateMany({
            where: { ...where, mailLeaseUntil },
            data: {
              mailAttempts,
              mailLeaseUntil: null,
              mailNextAttemptAt: new Date(
                Date.now() + 30_000 * 2 ** mailAttempts,
              ),
              ...(mailAttempts >= 5 ? { deliveryCode: null } : {}),
            },
          });
          if (mailAttempts >= 5)
            this.logger.error('SECURITY_EMAIL_DELIVERY_FAILED');
          else this.logger.warn('SECURITY_EMAIL_DELIVERY_RETRY');
        }
      }
      await this.prisma.securityChallenge.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
    } finally {
      this.delivering = false;
    }
  }

  private hash(userId: string, purpose: string, code: string) {
    return hashSecurityCode(userId, purpose, code);
  }

  async requestActivation(email: string) {
    this.mail.assertConfigured();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user?.status === 'INVITED' && user.activationSubmissionId) {
      await this.issue(user.id, 'ACCOUNT_ACTIVATION', email);
    }
    return {
      message:
        'If a pending registration matches, an activation code will be emailed. Check your inbox and spam folder.',
    };
  }

  async confirmActivation(dto: ActivationConfirmDto) {
    if (!dto.termsAccepted)
      throw new BadRequestException(
        'Accept the Terms of Use and Privacy Notice to activate your account.',
      );
    if (Buffer.byteLength(dto.password, 'utf8') > 72)
      throw new BadRequestException(
        'Choose a password no longer than 72 UTF-8 bytes.',
      );
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user || user.status !== 'INVITED' || !user.activationSubmissionId)
      throw new BadRequestException(invalidCode);
    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.confirm(
      user.id,
      'ACCOUNT_ACTIVATION',
      dto.code,
      passwordHash,
      dto,
    );
    return {
      message:
        'Account activated. Sign in to choose training. Dealer features unlock after Hercules verifies initial training completion.',
    };
  }

  async requestRecovery(email: string) {
    this.mail.assertConfigured();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user?.status === 'ACTIVE') {
      await this.issue(user.id, 'PASSWORD_RESET', email);
    }
    return genericResponse;
  }

  async requestEmailChange(userId: string, dto: EmailChangeRequestDto) {
    this.mail.assertConfigured();
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('The current password is incorrect.');
    }
    if (dto.email === user.email)
      throw new BadRequestException('Enter a different email address.');
    if (await this.prisma.user.findUnique({ where: { email: dto.email } })) {
      throw new ConflictException('That email address is unavailable.');
    }
    await this.issue(userId, 'EMAIL_CHANGE', dto.email, user.passwordHash);
    return {
      message:
        'If eligible, a code will be sent to your new email. Your sign-in email stays unchanged until you confirm it. Please wait one minute before requesting another code.',
    };
  }

  private async issue(
    userId: string,
    purpose: string,
    email: string,
    expectedPasswordHash?: string,
  ) {
    const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (
        !user ||
        (purpose === 'ACCOUNT_ACTIVATION'
          ? user.status !== 'INVITED' || !user.activationSubmissionId
          : user.status !== 'ACTIVE') ||
        (expectedPasswordHash && expectedPasswordHash !== user.passwordHash) ||
        (['PASSWORD_RESET', 'ACCOUNT_ACTIVATION'].includes(purpose) &&
          email !== user.email)
      )
        return null;
      const previous = await tx.securityChallenge.findUnique({
        where: { userId_purpose: { userId, purpose } },
      });
      if (previous && previous.createdAt.getTime() > Date.now() - 60_000) {
        if (purpose === 'EMAIL_CHANGE' && previous.targetEmail !== email) {
          throw new BadRequestException(
            'Please wait one minute before requesting a code for a different email address.',
          );
        }
        return null;
      }
      const data = {
        userId,
        purpose,
        targetEmail: email,
        codeHash: this.hash(userId, purpose, code),
        deliveryCode: encryptDeliveryCode(
          code,
          `${userId}:${purpose}:${email}`,
        ),
        mailAttempts: 0,
        mailNextAttemptAt: new Date(),
        mailLeaseUntil: null,
        sessionVersion: user.sessionVersion,
        attempts: 0,
        expiresAt: new Date(Date.now() + 15 * 60_000),
        createdAt: new Date(),
      };
      return tx.securityChallenge.upsert({
        where: { userId_purpose: { userId, purpose } },
        create: data,
        update: data,
      });
    });
  }

  async confirmRecovery(dto: RecoveryConfirmDto) {
    if (Buffer.byteLength(dto.password, 'utf8') > 72)
      throw new BadRequestException(
        'Choose a password no longer than 72 UTF-8 bytes.',
      );
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) throw new BadRequestException(invalidCode);
    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.confirm(user.id, 'PASSWORD_RESET', dto.code, passwordHash);
    return { message: 'Password updated. Sign in with your new password.' };
  }

  async confirmEmailChange(userId: string, code: string) {
    await this.confirm(userId, 'EMAIL_CHANGE', code);
    return { message: 'Email verified. Sign in with your new email address.' };
  }

  private async confirm(
    userId: string,
    purpose: string,
    code: string,
    passwordHash?: string,
    activation?: ActivationConfirmDto,
  ) {
    let accepted: boolean;
    try {
      accepted = await this.prisma.$transaction(async (tx) => {
        if (activation) await acquireJotformPrivacyLock(tx, activation.email);
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        const user = await tx.user.findUnique({ where: { id: userId } });
        const challenge = await tx.securityChallenge.findUnique({
          where: { userId_purpose: { userId, purpose } },
        });
        if (
          !user ||
          (purpose === 'ACCOUNT_ACTIVATION'
            ? user.status !== 'INVITED' || !user.activationSubmissionId
            : user.status !== 'ACTIVE') ||
          !challenge ||
          challenge.expiresAt <= new Date() ||
          challenge.attempts >= 5 ||
          challenge.sessionVersion !== user.sessionVersion
        )
          return false;
        const expected = Buffer.from(challenge.codeHash, 'hex');
        const supplied = Buffer.from(this.hash(userId, purpose, code), 'hex');
        if (
          expected.length !== supplied.length ||
          !timingSafeEqual(expected, supplied)
        ) {
          await tx.securityChallenge.update({
            where: { id: challenge.id },
            data: { attempts: { increment: 1 } },
          });
          return false; // Commit the failed-attempt counter before returning an error.
        }
        if (purpose !== 'EMAIL_CHANGE' && challenge.targetEmail !== user.email)
          return false;
        if (activation) {
          const submission = await tx.jotformSubmission.findUnique({
            where: { id: user.activationSubmissionId! },
          });
          if (
            !submission ||
            submission.privacyErasedAt ||
            submission.vendorStatus !== 'ACTIVE' ||
            submission.respondentEmail !== user.email ||
            (submission.ownerUserId && submission.ownerUserId !== user.id)
          )
            return false;
          if (
            await tx.accountDeletionRequest.findFirst({
              where: { email: user.email },
            })
          )
            return false;
          await tx.jotformSubmission.update({
            where: { id: submission.id },
            data: {
              ownerUserId: user.id,
              ownershipVerifiedAt: new Date(),
              ownershipVerifiedBy: 'ACCOUNT_ACTIVATION_MAILBOX',
            },
          });
        }
        if (purpose === 'EMAIL_CHANGE') {
          await tx.accountEmailHistory.upsert({
            where: { userId_email: { userId, email: user.email } },
            create: { userId, email: user.email },
            update: {},
          });
        }
        await tx.user.update({
          where: { id: userId },
          data: {
            ...(activation
              ? {
                  status: 'ACTIVE',
                  firstName: activation.firstName,
                  lastName: activation.lastName,
                  termsAcceptedAt: new Date(),
                  termsVersion: CURRENT_TERMS_VERSION,
                  privacyPolicyAcceptedAt: new Date(),
                }
              : {}),
            ...(passwordHash
              ? { passwordHash }
              : { email: challenge.targetEmail }),
            sessionVersion: { increment: 1 },
          },
        });
        await tx.securityChallenge.deleteMany({ where: { userId } });
        await tx.pushDevice.deleteMany({ where: { userId } });
        return true;
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error, 'email'))
        throw new ConflictException(
          'That email address is unavailable. Request a code for another address.',
        );
      throw error;
    }
    if (!accepted) throw new BadRequestException(invalidCode);
  }
}
