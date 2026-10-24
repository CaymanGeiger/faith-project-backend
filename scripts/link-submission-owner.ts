import { PrismaClient } from '@prisma/client';
import { acquireJotformPrivacyLock } from '../src/jotform/jotform-privacy';
const prisma = new PrismaClient();
const option = (name: string) => { const i = process.argv.indexOf(name); const value = i >= 0 ? process.argv[i + 1]?.trim() : undefined; if (!value) throw new Error(`Required: ${name}`); return value; };
async function main() {
  const userId = option('--user-id');
  const id = option('--record-id');
  const expectedEmail = option('--expected-email').toLowerCase();
  const verifiedBy = option('--verified-by');
  if (verifiedBy.length > 160) throw new Error('Operator identifier is too long');
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true } });
    await acquireJotformPrivacyLock(tx, expectedEmail);
    await tx.$queryRaw`SELECT "id" FROM "JotformSubmission" WHERE "id" = ${id} FOR UPDATE`;
    const record = await tx.jotformSubmission.findUniqueOrThrow({ where: { id } });
    if (record.privacyErasedAt || record.respondentEmail !== expectedEmail || (record.ownerUserId && record.ownerUserId !== user.id)) throw new Error('Record changed, erased or already owned; investigate before binding.');
    await tx.jotformSubmission.update({ where: { id }, data: { ownerUserId: user.id, ownershipVerifiedAt: new Date(), ownershipVerifiedBy: verifiedBy } });
  });
  console.log(JSON.stringify({ recordId: id, userId, status: 'OWNERSHIP_VERIFIED' }));
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Unable to bind ownership'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
