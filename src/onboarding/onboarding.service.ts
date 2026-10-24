import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { onboardingAccess } from './onboarding-access';
import { VerifyInitialTrainingDto } from './onboarding.dto';

@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  private verifierEnabled(managerId: string) {
    return (process.env.ONBOARDING_VERIFIER_MANAGER_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .includes(managerId);
  }

  async getForManager(managerId: string, prospectUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: prospectUserId },
      include: { prospectProfile: true, initialTrainingVerification: true },
    });
    if (!user || user.role !== 'PROSPECT')
      throw new NotFoundException('Dealer not found');
    if (user.prospectProfile?.assignedSalesManagerId !== managerId)
      throw new ForbiddenException('Prospect is not assigned to this manager');
    return {
      access: onboardingAccess(user),
      verification: user.initialTrainingVerification,
      canVerifyTraining:
        this.verifierEnabled(managerId) && user.status === 'ACTIVE',
    };
  }

  async verifyInitialTraining(
    managerId: string,
    prospectUserId: string,
    dto: VerifyInitialTrainingDto,
  ) {
    if (!this.verifierEnabled(managerId))
      throw new ForbiddenException(
        'Training verification is not enabled for this manager. Hercules must approve the verification owner first.',
      );
    const completedAt = new Date(dto.completedAt);
    if (!Number.isFinite(completedAt.getTime()) || completedAt > new Date())
      throw new BadRequestException(
        'Training completion must have a valid date in the past.',
      );
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${prospectUserId} FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: prospectUserId },
        include: { prospectProfile: true, initialTrainingVerification: true },
      });
      if (!user || user.role !== 'PROSPECT')
        throw new NotFoundException('Dealer not found');
      if (user.prospectProfile?.assignedSalesManagerId !== managerId)
        throw new ForbiddenException(
          'Prospect is not assigned to this manager',
        );
      if (user.status !== 'ACTIVE')
        throw new ConflictException(
          'Activate the dealer account before recording training verification.',
        );
      const previous = user.initialTrainingVerification;
      if (previous) {
        if (previous.developmentOnly)
          throw new ConflictException(
            'Turn off development training before recording genuine training verification.',
          );
        if (
          previous.completedAt.getTime() !== completedAt.getTime() ||
          previous.source !== dto.source ||
          previous.reference !== dto.reference ||
          previous.enrollmentId !== (dto.enrollmentId ?? null)
        )
          throw new ConflictException(
            'Initial training was already verified. Contact Hercules to correct the audit record.',
          );
        return { access: onboardingAccess(user), verification: previous };
      }
      if (dto.enrollmentId) {
        const enrollment = await tx.classEnrollment.findUnique({
          where: { id: dto.enrollmentId },
          include: { classSession: true },
        });
        if (
          !enrollment ||
          enrollment.prospectUserId !== user.id ||
          enrollment.status === 'CANCELED' ||
          enrollment.classSession.status === 'CANCELED' ||
          enrollment.classSession.endsAt > completedAt
        )
          throw new BadRequestException(
            'Use an attended training enrollment belonging to this dealer that ended by the completion date.',
          );
        await tx.classEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'COMPLETED' },
        });
      }
      const verifiedAt = new Date();
      const verification = await tx.initialTrainingVerification.create({
        data: {
          prospectUserId,
          verifiedByUserId: managerId,
          completedAt,
          verifiedAt,
          source: dto.source,
          reference: dto.reference,
          enrollmentId: dto.enrollmentId,
        },
      });
      const updated = await tx.user.update({
        where: { id: prospectUserId },
        data: { initialTrainingVerifiedAt: verifiedAt },
      });
      // Initial training access does not assert dealer-number issuance, agreement or certification.
      return { access: onboardingAccess(updated), verification };
    });
  }
}
