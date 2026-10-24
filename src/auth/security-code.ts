import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

function deliveryKey() {
  if (!process.env.JWT_SECRET)
    throw new Error('JWT_SECRET is required for verification delivery');
  return createHash('sha256')
    .update(`hercules-security-email:${process.env.JWT_SECRET}`)
    .digest();
}
export function encryptDeliveryCode(code: string, identity: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deliveryKey(), iv);
  cipher.setAAD(Buffer.from(identity));
  const ciphertext = Buffer.concat([
    cipher.update(code, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    'base64',
  );
}
export function decryptDeliveryCode(value: string, identity: string) {
  const data = Buffer.from(value, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deliveryKey(),
    data.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(identity));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([
    decipher.update(data.subarray(28)),
    decipher.final(),
  ]).toString('utf8');
}
