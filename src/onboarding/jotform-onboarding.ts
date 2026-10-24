import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { CanonicalJotformSubmission } from '../jotform/jotform-submission.mapper';
import { activationChallengeData } from '../auth/activation-challenge';

/** Runs inside the existing canonical import transaction and privacy lock.
 * Never joins an existing account by a mutable/shared email address.
 */
export async function provisionJotformAccount(
  tx: Prisma.TransactionClient,
  submissionId: string,
  canonical: CanonicalJotformSubmission,
) {
  if (process.env.JOTFORM_ONBOARDING_ENABLED !== 'true') return;
  const email = canonical.respondentEmail;
  if (!email || !canonical.companyName || canonical.vendorStatus !== 'ACTIVE')
    return;
  const sourceAccount = await tx.user.findUnique({
    where: { activationSubmissionId: submissionId },
  });
  if (sourceAccount) {
    if (sourceAccount.email !== email)
      await tx.jotformSubmission.update({
        where: { id: submissionId },
        data: { reviewReasonCode: 'ONBOARDING_IDENTITY_REVIEW' },
      });
    return;
  }
  const existing = await tx.user.findUnique({ where: { email } });
  if (existing) return; // Duplicate imports never alter credentials, owner, profile or status.
  const managerId = process.env.JOTFORM_ONBOARDING_MANAGER_ID?.trim();
  const manager = managerId
    ? await tx.user.findFirst({
        where: { id: managerId, role: 'SALES_MANAGER', status: 'ACTIVE' },
        select: { id: true },
      })
    : null;
  if (!manager) {
    await tx.jotformSubmission.update({
      where: { id: submissionId },
      data: { reviewReasonCode: 'ONBOARDING_MANAGER_REQUIRED' },
    });
    return;
  }
  // A disabled/deleting account or pending deletion is not recreated by an import.
  if (await tx.accountDeletionRequest.findFirst({ where: { email } })) {
    await tx.jotformSubmission.update({
      where: { id: submissionId },
      data: { reviewReasonCode: 'PRIVACY_OWNERSHIP_REVIEW' },
    });
    return;
  }
  const now = new Date();
  const inDays = (days: number) => new Date(now.getTime() + days * 86400000);
  const user = await tx.user.create({
    data: {
      email,
      firstName: '',
      lastName: '',
      role: 'PROSPECT',
      status: 'INVITED',
      passwordHash: `!activation-required:${randomBytes(32).toString('hex')}`,
      onboardingRequired: true,
      activationSubmissionId: submissionId,
      prospectProfile: {
        create: {
          companyName: canonical.companyName,
          assignedSalesManagerId: manager.id,
          marketingConsultationDueAt: inDays(90),
          jbWarrantiesDueAt: inDays(30),
        },
      },
      marketingConsults: { create: {} },
      prospectLeadRecords: { create: { assignedSalesManagerId: manager.id } },
      todoItems: {
        createMany: {
          data: [
            {
              type: 'CLASS_SIGNUP',
              title: 'Choose Your LG Training',
              description:
                'Choose training; access unlocks after Hercules verifies completion.',
              dueAt: inDays(14),
            },
            {
              type: 'EQUIPMENT_REGISTRATION',
              title: 'Add Your First LG System',
              description: 'Available after verified initial training.',
              dueAt: inDays(14),
            },
            {
              type: 'JB_WARRANTIES',
              title: 'Record Your JB Warranties Setup',
              description: 'Available after verified initial training.',
              dueAt: inDays(30),
            },
            {
              type: 'MARKETING_CONSULTATION',
              title: 'Share Marketing Availability',
              description: 'Available after verified initial training.',
              dueAt: inDays(90),
            },
          ],
        },
      },
    },
  });
  await tx.conversation.create({
    data: {
      participants: {
        createMany: { data: [{ userId: user.id }, { userId: manager.id }] },
      },
    },
  });
  // Ownership remains unverified until the exact registration account verifies its mailbox.
  const challenge = activationChallengeData(
    user.id,
    email,
    user.sessionVersion,
  );
  await tx.securityChallenge.create({ data: challenge });
}
