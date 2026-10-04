import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { decodeEncryptionKey, decryptSecret, encryptSecret } from '../packages/security/src/index';
import { classifyConnectionError, testSmtp } from '../packages/mail/src/index';
import { mailServerSchema } from '../packages/shared/src/index';

test('AES-GCM encrypts, randomizes, authenticates, and rejects invalid keys', () => {
  const key = decodeEncryptionKey(randomBytes(32).toString('base64'));
  const a = encryptSecret('private password', key);
  const b = encryptSecret('private password', key);
  assert.equal(decryptSecret(a, key), 'private password');
  assert.notEqual(a.encryptedPassword, b.encryptedPassword);
  assert.notEqual(a.encryptionIv, b.encryptionIv);
  assert.throws(() => decryptSecret(a, randomBytes(32)), /CREDENTIAL_DECRYPTION_FAILED/);
  assert.throws(() => decryptSecret({ ...a, encryptedPassword: b.encryptedPassword }, key), /CREDENTIAL_DECRYPTION_FAILED/);
  assert.throws(() => decodeEncryptionKey('bad key'), /MAIL_CREDENTIAL_ENCRYPTION_KEY/);
});

test('mail server validation rejects invalid host, port, and provider', () => {
  const valid = { name: 'Local', providerType: 'GENERIC', imapHost: null, imapPort: null, imapSecurity: 'TLS', smtpHost: '127.0.0.1', smtpPort: 51025, smtpSecurity: 'NONE', smtpAuthMode: 'NONE' };
  assert.equal(mailServerSchema.safeParse(valid).success, true);
  for (const invalid of [{ ...valid, smtpHost: '' }, { ...valid, smtpPort: 0 }, { ...valid, providerType: 'MADE_UP' }]) assert.equal(mailServerSchema.safeParse(invalid).success, false);
});

test('connection errors are normalized without raw server text', () => {
  const samples = [
    [{ code: 'ETIMEDOUT', message: 'secret' }, 'IMAP_TIMEOUT'],
    [{ code: 'EAUTH', message: 'secret' }, 'IMAP_AUTH_FAILED'],
    [{ code: 'CERT_HAS_EXPIRED', message: 'secret' }, 'IMAP_TLS_FAILED'],
    [{ code: 'ECONNREFUSED', message: 'secret' }, 'IMAP_CONNECTION_REFUSED'],
  ] as const;
  for (const [error, code] of samples) { const result = classifyConnectionError('IMAP', error); assert.equal(result.errorCode, code); assert.equal(result.message.includes('secret'), false); }
});

test('Mailpit SMTP verification makes no send attempt', { skip: process.env.MAILPIT_INTEGRATION !== '1' }, async () => {
  const result = await testSmtp({ host: '127.0.0.1', port: 51025, security: 'NONE' }, null);
  assert.equal(result.status, 'SUCCESS');
  assert.match(result.message, /authentication is disabled/);
});
