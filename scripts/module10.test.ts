import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../packages/database/generated/client';
import { encryptSecret, generateWebhookSecret } from '../packages/security/src/index';
import { parseDsn, pinnedWebhookLookupAnswer, publicWebhookAddress, resolveWebhookTarget, signWebhook, verifyWebhookSignature, webhookUrl } from '../packages/mail/src/index';
import { deliveryDecision } from '../apps/worker/src/webhook-delivery';
import { emitWebhookEvent } from '../apps/worker/src/webhook-events';
import { recordDsn } from '../apps/worker/src/bounces';
import { saveMessage } from '../apps/worker/src/imap-sync';
import { ClientMessagesController } from '../apps/api/dist/sending.js';
import { webhookEndpointSelect } from '../apps/api/dist/webhooks.js';

function fixture(status: string, action: string, id = '<synthetic-123@example.org>') {
  return Buffer.from(`From: daemon@example.org\r\nTo: test@example.org\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="synthetic"\r\n\r\n--synthetic\r\nContent-Type: text/plain\r\n\r\nSynthetic delivery report\r\n--synthetic\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; example.org\r\n\r\nFinal-Recipient: rfc822; failed@example.org\r\nAction: ${action}\r\nStatus: ${status}\r\nOriginal-Message-ID: ${id}\r\n\r\n--synthetic--\r\n`);
}

test('HMAC covers exact bytes and timestamp', () => {
  const body = '{"eventId":"synthetic"}';
  const signature = signWebhook('synthetic-secret', '1234567890', body);
  assert.match(signature, /^sha256=[a-f0-9]{64}$/);
  assert.equal(verifyWebhookSignature('synthetic-secret', '1234567890', body, signature), true);
  assert.equal(verifyWebhookSignature('wrong', '1234567890', body, signature), false);
  assert.equal(verifyWebhookSignature('synthetic-secret', '1234567891', body, signature), false);
  assert.equal(verifyWebhookSignature('synthetic-secret', '1234567890', `${body} `, signature), false);
});

test('signing secrets have random 256-bit material and are omitted from endpoint projection', () => {
  const first = generateWebhookSecret(); const second = generateWebhookSecret();
  assert.match(first, /^umhwh_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  const stored = encryptSecret(first, Buffer.alloc(32, 7));
  assert.equal(stored.encryptedPassword.includes(first), false);
  for (const field of ['encryptedSecret', 'encryptionIv', 'encryptionAuthTag', 'encryptionVersion']) assert.equal(field in webhookEndpointSelect, false);
});

test('SSRF validation rejects local, private DNS answers, and malformed destinations', async () => {
  for (const value of ['http://receiver.example.org/hook', 'https://localhost/hook', 'https://127.0.0.1/hook', 'https://receiver.example.org:8443/hook', 'https://user:pass@receiver.example.org/hook']) assert.throws(() => webhookUrl(value), /WEBHOOK_ENDPOINT_INVALID/);
  for (const value of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', '2001:db8::1']) assert.equal(publicWebhookAddress(value), false, value);
  assert.equal(publicWebhookAddress('8.8.8.8'), true);
  assert.equal(webhookUrl('https://receiver.example.org/hook').hostname, 'receiver.example.org');
  assert.deepEqual(pinnedWebhookLookupAnswer({ address: '8.8.8.8', family: 4 }, true), [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(pinnedWebhookLookupAnswer({ address: '8.8.8.8', family: 4 }, false), '8.8.8.8');
  const privateResolver = (async () => [{ address: '127.0.0.1', family: 4 }]) as never;
  await assert.rejects(resolveWebhookTarget('https://receiver.example.org/hook', privateResolver), /WEBHOOK_ENDPOINT_INVALID/);
});

test('retries transient responses and stops on success or permanent failure', () => {
  assert.equal(deliveryDecision(200, 1, 5).status, 'DELIVERED');
  assert.equal(deliveryDecision(429, 1, 5, 600).delaySeconds, 600);
  assert.equal(deliveryDecision(500, 2, 5).delaySeconds, 300);
  assert.equal(deliveryDecision(408, 3, 5).status, 'RETRY_SCHEDULED');
  assert.equal(deliveryDecision(400, 1, 5).status, 'FAILED');
  assert.equal(deliveryDecision(503, 5, 5).status, 'FAILED');
});

test('DSN requires MIME evidence and classifies conservatively', () => {
  assert.equal(parseDsn(Buffer.from('Subject: Mail delivery failed\r\n\r\nNo MIME evidence')), null);
  const hard = parseDsn(fixture('5.1.1', 'failed'));
  assert.deepEqual(hard, { recipientEmail: 'failed@example.org', originalMessageId: 'synthetic-123@example.org', action: 'failed', statusCode: '5.1.1', classification: 'HARD_BOUNCE' });
  assert.equal(parseDsn(fixture('4.2.2', 'delayed'))?.classification, 'SOFT_BOUNCE');
  assert.equal(parseDsn(fixture('5.1.1', 'delivered'))?.classification, 'UNKNOWN');
  const multi = Buffer.from(fixture('5.1.1', 'failed').toString().replace('--synthetic--', 'Final-Recipient: rfc822; second@example.org\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n--synthetic--'));
  assert.equal(parseDsn(multi)?.classification, 'UNKNOWN');
});

test('suppressed recipient is rejected before API acceptance; removal allows a new submission', async () => {
  let suppressed = true;
  let created = 0;
  const db = {
    outgoingMessage: { findUnique: async () => null, create: async () => { created++; return { id: 'synthetic-message', status: 'QUEUED', createdAt: new Date(), outboxEvents: [{ id: 'synthetic-outbox' }] }; } },
    mailbox: { findFirst: async () => ({ id: 'cm12345678901234567890123', projectId: 'synthetic-project', isActive: true, status: 'HEALTHY', mailServer: { status: 'ACTIVE', smtpHost: 'smtp.example.org', smtpPort: 587, smtpAuthMode: 'NONE' }, apiKeyGrants: [{ id: 'synthetic-grant' }], credential: null }) },
    suppression: { findFirst: async () => suppressed ? { email: 'blocked@example.org' } : null },
    outboxEvent: { update: async () => undefined },
  };
  const queue = { publish: async () => undefined };
  const controller = new ClientMessagesController(db as never, queue as never);
  const request = { apiPrincipal: { id: 'synthetic-key', projectId: 'synthetic-project', scopes: ['MAIL_SEND'] } } as Parameters<typeof controller.submit>[2];
  const payload = { fromMailboxId: 'cm12345678901234567890123', to: [{ email: 'blocked@example.org' }], subject: 'Synthetic', text: 'Test' };
  await assert.rejects(controller.submit(payload, 'first-attempt', request), error => (error as { getResponse: () => { code: string } }).getResponse().code === 'RECIPIENT_SUPPRESSED');
  assert.equal(created, 0);
  suppressed = false;
  assert.equal((await controller.submit(payload, 'second-attempt', request)).status, 'QUEUED');
  assert.equal(created, 1);
});

test('events are idempotent and project subscriptions are isolated; hard DSN suppresses only exact recipient', async () => {
  const db = new PrismaClient();
  const marker = `module10-${randomUUID()}`;
  try {
    await assert.rejects(db.$transaction(async tx => {
      const project = await tx.project.create({ data: { name: 'Synthetic Module 10', slug: marker } });
      const other = await tx.project.create({ data: { name: 'Synthetic Other', slug: `${marker}-other` } });
      const domain = await tx.domain.create({ data: { projectId: project.id, domain: `${marker}.example.org` } });
      const mailbox = await tx.mailbox.create({ data: { projectId: project.id, domainId: domain.id, email: `sender@${marker}.example.org` } });
      const folder = await tx.mailFolder.create({ data: { mailboxId: mailbox.id, path: 'INBOX', name: 'INBOX', specialUse: 'INBOX' } });
      const secret = encryptSecret('synthetic-secret', Buffer.alloc(32, 7));
      const a = await tx.webhookEndpoint.create({ data: { projectId: project.id, name: 'Subscribed', url: 'https://receiver.example.org/hook', subscriptions: ['mail.received', 'mail.bounced'], encryptedSecret: secret.encryptedPassword, encryptionIv: secret.encryptionIv, encryptionAuthTag: secret.encryptionAuthTag } });
      await tx.webhookEndpoint.create({ data: { projectId: project.id, name: 'Unsubscribed', url: 'https://receiver.example.org/other', subscriptions: ['mail.failed'], encryptedSecret: secret.encryptedPassword, encryptionIv: secret.encryptionIv, encryptionAuthTag: secret.encryptionAuthTag } });
      await tx.webhookEndpoint.create({ data: { projectId: other.id, name: 'Other project', url: 'https://receiver.example.org/other', subscriptions: ['mail.received'], encryptedSecret: secret.encryptedPassword, encryptionIv: secret.encryptionIv, encryptionAuthTag: secret.encryptionAuthTag } });
      const eventKey = `mail.received:${marker}`;
      const input = { projectId: project.id, eventKey, type: 'mail.received' as const, resourceType: 'MailMessage', resourceId: marker, payload: { messageId: marker } };
      assert.equal(await emitWebhookEvent(tx, input), true);
      assert.equal(await emitWebhookEvent(tx, input), false);
      const event = await tx.webhookEvent.findUniqueOrThrow({ where: { eventKey }, include: { deliveries: true } });
      assert.equal(event.deliveries.length, 1);
      assert.equal(event.deliveries[0]!.endpointId, a.id);
      assert.equal((event.payload as { projectId: string }).projectId, project.id);
      const syncDb = { $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) } as never;
      const flags = { isSeen: false, isFlagged: false, isAnswered: false, isDraft: false, isDeleted: false };
      const incoming = { messageIdHeader: '<synthetic-incoming@example.org>', subject: 'Synthetic incoming', date: new Date(), internalDate: new Date(), fromName: 'Synthetic Sender', fromEmail: 'sender@example.org', textBody: 'Test only', htmlBody: null, sizeBytes: 100n, contentStatus: 'COMPLETE' as const, ...flags, inReplyTo: null, references: [], recipients: [], attachments: [], dsn: null };
      assert.equal((await saveMessage(syncDb, mailbox.id, folder.id, 10n, incoming, flags)).added, true);
      assert.equal((await saveMessage(syncDb, mailbox.id, folder.id, 10n, null, flags)).added, false);
      assert.equal(await tx.webhookEvent.count({ where: { projectId: project.id, type: 'mail.received' } }), 2); // One explicit event above and one actual sync event.

      const outgoing = await tx.outgoingMessage.create({ data: { projectId: project.id, fromMailboxId: mailbox.id, subject: 'Synthetic', idempotencyKey: marker, requestHash: marker, status: 'SMTP_ACCEPTED', rfcMessageId: '<synthetic-123@example.org>', recipients: { create: [{ type: 'TO', email: 'failed@example.org', smtpStatus: 'ACCEPTED' }] } }, include: { recipients: true } });
      const message = await tx.mailMessage.create({ data: { mailboxId: mailbox.id, folderId: folder.id, imapUid: 1n } });
      const bounce = await recordDsn(tx, project.id, message.id, parseDsn(fixture('5.1.1', 'failed'))!);
      assert.equal(bounce.outgoingMessageId, outgoing.id);
      assert.equal((await tx.outgoingRecipient.findUniqueOrThrow({ where: { id: outgoing.recipients[0]!.id } })).smtpStatus, 'BOUNCED');
      assert.equal((await tx.suppression.findUniqueOrThrow({ where: { projectId_email: { projectId: project.id, email: 'failed@example.org' } } })).reason, 'HARD_BOUNCE');
      const softOutgoing = await tx.outgoingMessage.create({ data: { projectId: project.id, fromMailboxId: mailbox.id, subject: 'Synthetic soft', idempotencyKey: `${marker}-soft`, requestHash: marker, status: 'SMTP_ACCEPTED', rfcMessageId: '<soft@example.org>', recipients: { create: [{ type: 'TO', email: 'soft@example.org', smtpStatus: 'ACCEPTED' }] } }, include: { recipients: true } });
      const softSource = await tx.mailMessage.create({ data: { mailboxId: mailbox.id, folderId: folder.id, imapUid: 2n } });
      const softEvidence = parseDsn(Buffer.from(fixture('4.2.2', 'delayed', '<soft@example.org>').toString().replace('failed@example.org', 'soft@example.org')))!;
      const soft = await recordDsn(tx, project.id, softSource.id, softEvidence);
      assert.equal(soft.outgoingMessageId, softOutgoing.id);
      assert.equal((await tx.outgoingRecipient.findUniqueOrThrow({ where: { id: softOutgoing.recipients[0]!.id } })).smtpStatus, 'ACCEPTED');
      assert.equal(await tx.suppression.count({ where: { projectId: project.id, email: 'soft@example.org' } }), 0);
      const unmatchedSource = await tx.mailMessage.create({ data: { mailboxId: mailbox.id, folderId: folder.id, imapUid: 3n } });
      const unmatched = await recordDsn(tx, project.id, unmatchedSource.id, parseDsn(fixture('5.1.1', 'failed', '<unmatched@example.org>'))!);
      assert.equal(unmatched.outgoingMessageId, null);
      assert.equal(unmatched.correlationCode, 'BOUNCE_UNMATCHED');
      assert.equal(await tx.suppression.count({ where: { projectId: project.id } }), 1);
      await tx.suppression.delete({ where: { projectId_email: { projectId: project.id, email: 'failed@example.org' } } });
      assert.equal(await tx.suppression.count({ where: { projectId: project.id } }), 0);
      throw new Error('synthetic rollback');
    }), /synthetic rollback/);
    assert.equal(await db.project.count({ where: { slug: marker } }), 0);
  } finally { await db.$disconnect(); }
});
