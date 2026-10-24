import {
  PrismaClient,
  UserRole,
  UserStatus,
  TodoItemType,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { CURRENT_TERMS_VERSION } from '../legal/legal.constants';
import { areDevelopmentFeaturesEnabled } from './development';

const managerEmail = 'manager@hercules.local';
const dealerEmail = 'prospect@hercules.local';
const fixturePassword = 'password123';

/** Sets up only the reserved synthetic login fixtures in an isolated preview. */
export async function preparePreviewFixtures(prisma: PrismaClient) {
  if (
    process.env.APP_ENV !== 'preview' ||
    !areDevelopmentFeaturesEnabled() ||
    process.env.ALLOW_PREVIEW_FIXTURES !== 'true'
  )
    throw new Error(
      'Preview fixtures require APP_ENV=preview, DEV_FEATURES_ENABLED=true and ALLOW_PREVIEW_FIXTURES=true.',
    );

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(784618926)::text`;
      const existing = await tx.user.findMany({
        where: { email: { in: [managerEmail, dealerEmail] } },
        include: { initialTrainingVerification: true },
      });
      for (const user of existing) {
        const expectedRole =
          user.email === managerEmail
            ? UserRole.SALES_MANAGER
            : UserRole.PROSPECT;
        const evidence = user.initialTrainingVerification;
        const ownsMock =
          evidence?.developmentOnly === true &&
          evidence.source === 'DEVELOPMENT_TRAINING_TOGGLE' &&
          evidence.reference === `development-toggle:${user.id}` &&
          evidence.verifiedByUserId === null &&
          evidence.enrollmentId === null;
        if (
          user.role !== expectedRole ||
          user.activationSubmissionId ||
          (evidence && !ownsMock) ||
          (!evidence && user.initialTrainingVerifiedAt)
        )
          throw new Error(
            'Reserved fixture identity contains non-fixture account or training evidence; no accounts were changed.',
          );
      }

      const passwordFor = async (email: string) => {
        const user = existing.find((candidate) => candidate.email === email);
        if (user && (await bcrypt.compare(fixturePassword, user.passwordHash)))
          return { passwordHash: user.passwordHash };
        return {
          passwordHash: await bcrypt.hash(fixturePassword, 12),
          ...(user ? { sessionVersion: { increment: 1 } } : {}),
        };
      };
      const now = new Date();
      const policy = {
        termsAcceptedAt: now,
        termsVersion: CURRENT_TERMS_VERSION,
        privacyPolicyAcceptedAt: now,
        status: UserStatus.ACTIVE,
      };
      const managerPassword = await passwordFor(managerEmail);
      const manager = await tx.user.upsert({
        where: { email: managerEmail },
        update: { ...managerPassword, ...policy },
        create: {
          email: managerEmail,
          passwordHash: managerPassword.passwordHash,
          firstName: 'Avery',
          lastName: 'Cole',
          role: UserRole.SALES_MANAGER,
          ...policy,
        },
      });
      await tx.salesManagerProfile.upsert({
        where: { userId: manager.id },
        update: {},
        create: { userId: manager.id },
      });
      const dealerPassword = await passwordFor(dealerEmail);
      const dealer = await tx.user.upsert({
        where: { email: dealerEmail },
        update: { ...dealerPassword, ...policy, onboardingRequired: true },
        create: {
          email: dealerEmail,
          passwordHash: dealerPassword.passwordHash,
          firstName: 'Mike',
          lastName: 'Johnson',
          role: UserRole.PROSPECT,
          onboardingRequired: true,
          ...policy,
        },
      });
      await tx.prospectProfile.upsert({
        where: { userId: dealer.id },
        update: { assignedSalesManagerId: manager.id },
        create: {
          userId: dealer.id,
          companyName: 'Preview Demo Dealer',
          assignedSalesManagerId: manager.id,
          marketingConsultationDueAt: new Date(now.getTime() + 90 * 86400000),
          jbWarrantiesDueAt: new Date(now.getTime() + 30 * 86400000),
        },
      });
      await tx.marketingConsultation.upsert({
        where: { prospectUserId: dealer.id },
        update: {},
        create: { prospectUserId: dealer.id },
      });
      await tx.leadRecord.upsert({
        where: { prospectUserId: dealer.id },
        update: { assignedSalesManagerId: manager.id },
        create: {
          prospectUserId: dealer.id,
          assignedSalesManagerId: manager.id,
        },
      });
      await tx.todoItem.createMany({
        data: [
          { type: TodoItemType.CLASS_SIGNUP, title: 'Choose Your LG Training' },
          {
            type: TodoItemType.EQUIPMENT_REGISTRATION,
            title: 'Add Your First LG System',
          },
          {
            type: TodoItemType.JB_WARRANTIES,
            title: 'Record Your JB Warranties Setup',
          },
          {
            type: TodoItemType.MARKETING_CONSULTATION,
            title: 'Share Marketing Availability',
          },
        ].map((item) => ({
          ...item,
          prospectUserId: dealer.id,
          description: 'Complete this step with your Hercules sales manager.',
          dueAt: new Date(now.getTime() + 14 * 86400000),
        })),
        skipDuplicates: true,
      });
      const conversation = await tx.conversation.findFirst({
        where: {
          participants: { every: { userId: { in: [dealer.id, manager.id] } } },
          AND: [
            { participants: { some: { userId: dealer.id } } },
            { participants: { some: { userId: manager.id } } },
          ],
        },
      });
      if (!conversation)
        await tx.conversation.create({
          data: {
            participants: {
              create: [{ userId: dealer.id }, { userId: manager.id }],
            },
          },
        });
      return {
        prepared: true,
        accounts: [managerEmail, dealerEmail],
        trainingRequired: !dealer.initialTrainingVerifiedAt,
      };
    },
    { timeout: 30000 },
  );
}
