import { Prisma } from '@prisma/client';
import { acquireJotformPrivacyLock } from './jotform-privacy';

export async function eraseOwnedSubmissions(
  tx: Prisma.TransactionClient,
  userId: string,
  emails: string[],
) {
  for (const email of [...new Set(emails)].sort())
    await acquireJotformPrivacyLock(tx, email);
  const ambiguous = await tx.jotformSubmission.count({
    where: {
      ownerUserId: null,
      privacyErasedAt: null,
      respondentEmail: { in: emails },
    },
  });
  if (ambiguous) return false;
  await tx.jotformSubmission.updateMany({
    where: { ownerUserId: userId },
    data: {
      respondentEmail: null,
      companyName: null,
      dealerNumber: null,
      contentHash: null,
      reviewReasonCode: 'ACCOUNT_PRIVACY_ERASED',
      privacyErasedAt: new Date(),
    },
  });
  return true;
}
