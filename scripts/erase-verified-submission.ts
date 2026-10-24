import { PrismaClient } from '@prisma/client';
import { acquireJotformPrivacyLock } from '../src/jotform/jotform-privacy';
const prisma = new PrismaClient();
const option = (name: string) => { const i = process.argv.indexOf(name); const value = i >= 0 ? process.argv[i + 1]?.trim() : undefined; if (!value) throw new Error(`Required: ${name}`); return value; };
async function main() {
  const id = option('--record-id'); const requestId = option('--request-id');
  const email = option('--expected-email').toLowerCase(); const verifiedBy = option('--verified-by');
  if (verifiedBy.length > 160) throw new Error('Operator identifier is too long');
  await prisma.$transaction(async tx => {
    const request = await tx.accountDeletionRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.email !== email) throw new Error('Requested identity does not match; investigate the request first');
    await acquireJotformPrivacyLock(tx, email);
    await tx.$queryRaw`SELECT "id" FROM "JotformSubmission" WHERE "id" = ${id} FOR UPDATE`;
    const record = await tx.jotformSubmission.findUniqueOrThrow({ where: { id } });
    if (record.privacyErasedAt) return;
    if (record.respondentEmail !== email || (record.ownerUserId && record.ownerUserId !== request.userId)) throw new Error('Record changed or belongs to another account; erasure refused');
    await tx.jotformSubmission.update({ where: { id }, data: { respondentEmail: null, companyName: null, dealerNumber: null, contentHash: null, privacyErasedAt: new Date(), ownershipVerifiedAt: new Date(), ownershipVerifiedBy: verifiedBy, reviewReasonCode: 'ACCOUNT_PRIVACY_ERASED' } });
    await tx.accountDeletionRequest.update({ where: { id: requestId }, data: { verifiedAt: request.verifiedAt ?? new Date(), verifiedBy: request.verifiedBy ?? verifiedBy } });
  });
  console.log(JSON.stringify({ recordId: id, requestId, status: 'VERIFIED_RECORD_ERASED' }));
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Erasure failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
