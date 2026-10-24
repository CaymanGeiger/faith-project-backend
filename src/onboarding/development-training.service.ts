import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { onboardingAccess } from './onboarding-access';
import {
  areDevelopmentFeaturesEnabled,
  isDevelopmentAccount,
  isLocalDevelopmentDatabase,
} from '../config/development';

export { isLocalDevelopmentDatabase } from '../config/development';

const DEVELOPMENT_SOURCE = 'DEVELOPMENT_TRAINING_TOGGLE';

@Injectable()
export class DevelopmentTrainingService {
  // Capture alongside Prisma construction; a request cannot redirect this gate
  // by changing a caller-supplied URL or identity.
  private readonly localDatabase = isLocalDevelopmentDatabase(
    process.env.DATABASE_URL,
  );
  constructor(private readonly prisma: PrismaService) {}

  assertEnabled() {
    if (
      process.env.DEV_TRAINING_TOGGLE_ENABLED !== 'true' ||
      !areDevelopmentFeaturesEnabled() ||
      (!this.localDatabase && process.env.APP_ENV !== 'preview')
    )
      throw new NotFoundException();
  }

  async setTraining(userId: string, completed: boolean) {
    this.assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: userId },
        include: { initialTrainingVerification: true },
      });
      if (!user || user.role !== 'PROSPECT' || user.status !== 'ACTIVE')
        throw new NotFoundException();
      // Hosted previews share production runtime protections. Their training
      // shortcut is limited to reserved synthetic identities, never real dealers.
      if (
        process.env.APP_ENV === 'preview' &&
        !isDevelopmentAccount(user.email)
      )
        throw new NotFoundException();
      if (!user.onboardingRequired)
        throw new ConflictException(
          'Use a new restricted test dealer. Existing-account access is preserved.',
        );
      const previous = user.initialTrainingVerification;
      const reference = `development-toggle:${user.id}`;
      const ownsMock =
        previous?.developmentOnly === true &&
        previous.source === DEVELOPMENT_SOURCE &&
        previous.reference === reference &&
        previous.verifiedByUserId === null &&
        previous.enrollmentId === null;
      if (
        (previous && !ownsMock) ||
        (!previous && user.initialTrainingVerifiedAt)
      ) {
        throw new ConflictException(
          'Verified training evidence is preserved. Use a separate unverified test dealer for the development toggle.',
        );
      }
      if (completed) {
        const verifiedAt = previous?.verifiedAt ?? new Date();
        if (!previous)
          await tx.initialTrainingVerification.create({
            data: {
              prospectUserId: user.id,
              verifiedByUserId: null,
              completedAt: verifiedAt,
              verifiedAt,
              source: DEVELOPMENT_SOURCE,
              reference,
              developmentOnly: true,
            },
          });
        const updated = await tx.user.update({
          where: { id: user.id },
          data: { initialTrainingVerifiedAt: verifiedAt },
        });
        return { access: onboardingAccess(updated), development: true };
      }
      if (previous)
        await tx.initialTrainingVerification.delete({
          where: { id: previous.id },
        });
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { initialTrainingVerifiedAt: null },
      });
      // Enrollment, certification, owner, consent and notification state are untouched.
      return { access: onboardingAccess(updated), development: true };
    });
  }
}
