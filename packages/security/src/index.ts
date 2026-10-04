import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type EncryptedSecret = { encryptedPassword: string; encryptionIv: string; encryptionAuthTag: string; encryptionVersion: number };

export function decodeEncryptionKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('MAIL_CREDENTIAL_ENCRYPTION_KEY must be a Base64-encoded 32-byte key');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('MAIL_CREDENTIAL_ENCRYPTION_KEY must be a Base64-encoded 32-byte key');
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  if (key.length !== 32) throw new Error('Invalid encryption key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encryptedPassword = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
  return { encryptedPassword, encryptionIv: iv.toString('base64'), encryptionAuthTag: cipher.getAuthTag().toString('base64'), encryptionVersion: 1 };
}

export function decryptSecret(payload: EncryptedSecret, key: Buffer): string {
  try {
    if (payload.encryptionVersion !== 1 || key.length !== 32) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.encryptionIv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.encryptionAuthTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload.encryptedPassword, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new Error('CREDENTIAL_DECRYPTION_FAILED'); }
}
