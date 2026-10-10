import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { generateApiKey, hashApiKey } from '../packages/security/src/index';
import { classifySendError, sendSmtp } from '../packages/mail/src/index';
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

test('patched Nodemailer sends one synthetic message to an in-process SMTP server', async () => {
  let message = '';
  const server = createServer(socket => {
    socket.write('220 localhost synthetic SMTP\r\n');
    let buffer = '';
    let data = false;
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) { if (line === '.') { data = false; socket.write('250 2.0.0 accepted\r\n'); } else message += line + '\n'; }
        else if (/^EHLO /i.test(line)) socket.write('250 localhost\r\n');
        else if (/^MAIL FROM:|^RCPT TO:/i.test(line)) socket.write('250 2.1.0 ok\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await sendSmtp({ endpoint: { host: '127.0.0.1', port: address.port, security: 'NONE' }, auth: null, from: { email: 'sender@example.invalid' }, to: [{ email: 'recipient@example.invalid' }], cc: [], bcc: [], subject: 'Synthetic regression', text: 'Only local test content' });
    assert.deepEqual(result.accepted, ['recipient@example.invalid']);
    assert.match(message, /Only local test content/);
  } finally { server.close(); }
});
