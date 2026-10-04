import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateApiKey, hashApiKey } from '../packages/security/src/index';
import { classifySendError } from '../packages/mail/src/index';
import { sendMessageSchema } from '../packages/shared/src/index';

test('API keys contain high-entropy random material and verify by hash', () => {
  const first = generateApiKey('test'); const second = generateApiKey('test');
  assert.match(first.rawKey, /^umh_test_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.rawKey, second.rawKey);
  assert.equal(hashApiKey(first.rawKey), first.keyHash);
  assert.notEqual(hashApiKey(second.rawKey), first.keyHash);
  assert.equal(first.keyHash.includes(first.rawKey), false);
});

test('send request rejects SMTP credentials, arbitrary headers, attachments, and missing content', () => {
  const valid = { fromMailboxId: 'cm12345678901234567890123', to: [{ email: 'person@example.com' }], subject: 'Hello', text: 'Hello' };
  assert.equal(sendMessageSchema.safeParse(valid).success, true);
  for (const invalid of [{ ...valid, smtpPassword: 'secret' }, { ...valid, headers: { From: 'spoof' } }, { ...valid, attachments: [] }, { ...valid, text: undefined, html: undefined }]) assert.equal(sendMessageSchema.safeParse(invalid).success, false);
});

test('SMTP failures classify retryability precisely', () => {
  for (const code of [421, 450, 451, 452]) { const result = classifySendError({ responseCode: code, message: 'secret diagnostic' }); assert.equal(result.retryable, true); assert.equal(result.code, 'SMTP_TEMPORARY_FAILURE'); assert.equal(result.message.includes('secret'), false); }
  assert.equal(classifySendError({ code: 'ETIMEDOUT' }).retryable, true);
  assert.equal(classifySendError({ responseCode: 535 }).retryable, false);
  assert.equal(classifySendError({ responseCode: 535 }).code, 'SMTP_AUTH_FAILED');
  assert.equal(classifySendError({ responseCode: 550 }).retryable, false);
  assert.equal(classifySendError({ code: 'EENVELOPE', responseCode: 550 }).code, 'SMTP_RECIPIENT_REJECTED');
});
