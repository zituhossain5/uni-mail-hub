import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { composerTestMime } from '../apps/web/src/lib/composer-files';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { generateApiKey, hashApiKey } from '../packages/security/src/index';
import { classifySendError, sendSmtp } from '../packages/mail/src/index';
import { mailAttachmentLimits, sendMessageSchema } from '../packages/shared/src/index';

test('API keys contain high-entropy random material and verify by hash', () => {
  const first = generateApiKey('test'); const second = generateApiKey('test');
  assert.match(first.rawKey, /^umh_test_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.rawKey, second.rawKey);
  assert.equal(hashApiKey(first.rawKey), first.keyHash);
  assert.notEqual(hashApiKey(second.rawKey), first.keyHash);
  assert.equal(first.keyHash.includes(first.rawKey), false);
});

test('send request rejects SMTP credentials, arbitrary headers, untrusted file paths, and missing content', () => {
  const valid = { fromMailboxId: 'cm12345678901234567890123', to: [{ email: 'person@example.com' }], subject: 'Hello', text: 'Hello' };
  assert.equal(sendMessageSchema.safeParse(valid).success, true);
  assert.equal(sendMessageSchema.safeParse({ ...valid,html:'<p>Use the cid:example identifier in your documentation.</p>' }).success,true);
  for (const invalid of [{ ...valid, smtpPassword: 'secret' }, { ...valid, headers: { From: 'spoof' } }, { ...valid, attachments: [{ filename:'secret',path:'/etc/passwd' }] }, { ...valid, text: undefined, html: undefined }]) assert.equal(sendMessageSchema.safeParse(invalid).success, false);
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
    const result = await sendSmtp({ endpoint: { host: '127.0.0.1', port: address.port, security: 'NONE' }, auth: null, from: { email: 'sender@example.invalid' }, to: [{ email: 'recipient@example.invalid' }], cc: [], bcc: [], subject: 'Synthetic regression', text: 'Only local test content', html:'<p>Local test<img src="cid:local-image@example.invalid"></p>', attachments:[{ filename:'pixel.png',contentType:'image/png',content:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=','base64'),contentDisposition:'inline',cid:'local-image@example.invalid' },{ filename:'résumé.txt',contentType:'text/plain',content:Buffer.from('Attachment bytes — exact'),contentDisposition:'attachment' }] });
    assert.deepEqual(result.accepted, ['recipient@example.invalid']);
    assert.match(message, /Only local test content/);
    const { simpleParser } = createRequire(require.resolve('../packages/mail/package.json'))('mailparser');
    const parsed = await simpleParser(message);
    assert.equal(parsed.attachments.length,2);
    assert.equal(parsed.attachments.find((file:{ filename:string }) => file.filename === 'résumé.txt').content.toString(),'Attachment bytes — exact');
    const image = parsed.attachments.find((file:{ contentId:string }) => file.contentId === '<local-image@example.invalid>');
    assert.equal(image.contentDisposition,'inline');
    assert.equal(image.content.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.doesNotMatch(message,/Bcc:/i);
  } finally { server.close(); }
});

test('attachments validate bytes, limits, content IDs and strict input boundaries', () => {
  const valid = { fromMailboxId:'cm12345678901234567890123',to:[{ email:'person@example.test' }],subject:'Files',html:'<img src="cid:pixel@example.test">',attachments:[{ filename:'pixel.png',contentType:'image/png',contentBase64:'aGVsbG8=',disposition:'inline',contentId:'pixel@example.test' }] };
  assert.equal(sendMessageSchema.safeParse(valid).success,true);
  assert.equal(sendMessageSchema.safeParse({ ...valid,html:undefined,attachments:[{ filename:'empty.txt',contentType:'text/plain',contentBase64:'',disposition:'attachment' }] }).success,true);
  for (const file of [
    { filename:'../secret' }, { filename:'bad\r\nheader.txt' }, { contentType:'text/plain\r\nInjected: yes' },
    { contentBase64:'not base64!!' }, { contentId:undefined }, { contentType:'image/svg+xml' },
    { contentBase64:Buffer.alloc(mailAttachmentLimits.fileBytes + 1).toString('base64') },
    { path:'/etc/passwd' }, { href:'https://example.test/file' },
  ]) assert.equal(sendMessageSchema.safeParse({ ...valid,attachments:[{ ...valid.attachments[0],...file }] }).success,false,JSON.stringify(Object.keys(file)));
  assert.equal(sendMessageSchema.safeParse({ ...valid,attachments:[] }).success,false,'missing CID rejected');
  assert.equal(sendMessageSchema.safeParse({ ...valid,attachments:[...valid.attachments,...valid.attachments] }).success,false,'duplicate CID rejected');
  assert.equal(sendMessageSchema.safeParse({ ...valid,html:undefined,attachments:Array.from({ length:21 },() => ({ filename:'file.txt',contentType:'text/plain',contentBase64:'aGVsbG8=',disposition:'attachment' })) }).success,false);
  assert.equal(sendMessageSchema.safeParse({ ...valid,html:undefined,attachments:Array.from({ length:3 },() => ({ filename:'file.bin',contentType:'application/octet-stream',contentBase64:Buffer.alloc(8 * 1024 * 1024).toString('base64'),disposition:'attachment' })) }).success,false,'combined limit enforced');
});

test('dev test download is a MIME email with exact file bytes and CID image linkage', async () => {
  const { simpleParser } = createRequire(require.resolve('../packages/mail/package.json'))('mailparser');
  const content = Buffer.from('A file with unicode ✓ and binary \x00');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=','base64');
  const mime = composerTestMime({ from:'sender@example.test',to:[{ email:'recipient@example.test' }],cc:[],subject:'Test ✓ '.repeat(20),text:'Formatted text ✓',html:'<p><strong>Formatted text ✓</strong><img src="cid:pixel@example.test"></p>',attachments:[{ filename:'Résumé ✓.txt',contentType:'text/plain',contentBase64:content.toString('base64'),disposition:'attachment' },{ filename:'image.png',contentType:'image/png',contentBase64:image.toString('base64'),disposition:'inline',contentId:'pixel@example.test' }] },'test-boundary');
  const parsed = await simpleParser(mime,{ skipImageLinks:true });
  assert.equal(parsed.subject,'Test ✓ '.repeat(20));
  assert.match(parsed.text,/Formatted text ✓/);
  assert.match(parsed.html,/cid:pixel@example.test/);
  assert.equal(parsed.attachments.length,2);
  assert.deepEqual(parsed.attachments.find((file:{ filename:string }) => file.filename === 'Résumé ✓.txt').content,content);
  assert.deepEqual(parsed.attachments.find((file:{ contentId:string }) => file.contentId === '<pixel@example.test>').content,image);
});
