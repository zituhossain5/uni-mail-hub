import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { Prisma } from '../packages/database/generated/client';
import type { AuthedRequest, Database } from '../apps/api/src/core';
import type { MailQueue } from '../apps/api/src/sending';

Object.assign(process.env,{
  NODE_ENV:'test', DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:1/unused', REDIS_URL:'redis://127.0.0.1:1',
  JWT_SECRET:'isolated-compose-test-secret-at-least-32-characters', WEB_URL:'http://127.0.0.1:4395', API_URL:'http://127.0.0.1:4396',
  MAIL_CREDENTIAL_ENCRYPTION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
});
const { AdminComposeController } = createRequire(`${process.cwd()}/package.json`)('./apps/api/dist/sending.js') as typeof import('../apps/api/src/sending');

test('compose stores attachment bytes with the durable outbox and retries submissions without duplicating files', async () => {
  const mailboxId='cm12345678901234567890123';
  const userId='cm12345678901234567890124';
  const raw=Buffer.from('durable attachment bytes ✓');
  const input={ fromMailboxId:mailboxId,to:[{ email:'recipient@example.test' }],subject:'Files',attachments:[{ filename:'document.txt',contentType:'text/plain',contentBase64:raw.toString('base64'),disposition:'attachment' }] };
  let stored:Prisma.OutgoingMessageCreateInput | undefined;
  let createCount=0;
  let publishCount=0;
  let allowed=true;
  const db={
    mailbox:{ findFirst:async () => allowed ? { id:mailboxId } : null,findUnique:async () => ({ id:mailboxId,projectId:'project',isActive:true,status:'HEALTHY',mailServer:{ smtpHost:'smtp.example.invalid',smtpPort:587,status:'ACTIVE',smtpAuthMode:'NONE' } }) },
    outgoingMessage:{
      findUnique:async () => stored ? { id:'outgoing',requestHash:stored.requestHash,status:'QUEUED',createdAt:new Date() } : null,
      create:async ({ data }:{ data:Prisma.OutgoingMessageCreateInput }) => { stored=data; createCount++; return { id:'outgoing',status:'QUEUED',createdAt:new Date(),outboxEvents:[{ id:'outbox' }] }; },
    },
    suppression:{ findFirst:async () => null },
    auditLog:{ create:async () => ({}) },
    outboxEvent:{ update:async () => ({}),findFirst:async () => ({ id:'outbox' }) },
  };
  const controller=new AdminComposeController(db as unknown as Database,{ publish:async () => { publishCount++; } } as unknown as MailQueue);
  const request={ user:{ id:userId,role:'SUPER_ADMIN' },ip:'127.0.0.1' } as AuthedRequest;
  await controller.submit(input,'attachment-submission',request);
  assert.ok(stored?.outboxEvents?.create,'Outbox persisted in the same nested create');
  const files=stored?.attachments?.create as Prisma.OutgoingAttachmentCreateWithoutMessageInput[];
  assert.equal(files.length,1);
  assert.deepEqual(files[0]!.content,raw);
  assert.equal(files[0]!.sizeBytes,raw.length);
  assert.equal(publishCount,1);
  await controller.submit(input,'attachment-submission',request);
  assert.equal(createCount,1,'Retry must not create duplicate files');
  await assert.rejects(() => controller.submit({ ...input,attachments:[{ ...input.attachments[0],contentBase64:Buffer.from('changed').toString('base64') }] },'attachment-submission',request),/different content/);
  allowed=false;
  await assert.rejects(() => controller.submit(input,'another-key',request),/Forbidden/);
  assert.equal(createCount,1,'Unauthorized sender must not persist attachments');
  assert.equal(controller.capabilities().attachments,true);
});
