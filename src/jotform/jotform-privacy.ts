import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

/**
 * Serializes import, ownership review and erasure for a normalized identity.
 * Stable owner links and per-submission tombstones authorize erasure; an email
 * match alone only identifies records that need privacy review.
 */
export async function acquireJotformPrivacyLock(
  tx: Prisma.TransactionClient,
  normalizedEmail: string,
) {
  const digest = createHash('sha256')
    .update('jotform-privacy-lock:v1\0', 'utf8')
    .update(normalizedEmail, 'utf8')
    .digest();
  const lockId = digest.readBigInt64BE(0);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockId})::text`;
}
