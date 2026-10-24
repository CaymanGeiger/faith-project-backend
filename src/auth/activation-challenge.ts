import { createHmac, randomInt } from 'node:crypto';
import { encryptDeliveryCode } from './security-code';

export function hashSecurityCode(
  userId: string,
  purpose: string,
  code: string,
) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for verification codes');
  return createHmac('sha256', secret)
    .update(`${userId}:${purpose}:${code}`)
    .digest('hex');
}
export function activationChallengeData(
  userId: string,
  email: string,
  sessionVersion: number,
) {
  const purpose = 'ACCOUNT_ACTIVATION';
  const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
  return {
    userId,
    purpose,
    targetEmail: email,
    sessionVersion,
    codeHash: hashSecurityCode(userId, purpose, code),
    deliveryCode: encryptDeliveryCode(code, `${userId}:${purpose}:${email}`),
    expiresAt: new Date(Date.now() + 15 * 60_000),
  };
}
