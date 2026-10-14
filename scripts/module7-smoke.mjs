import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../packages/database/generated/client/index.js';
import argon2 from '../packages/database/node_modules/argon2/argon2.cjs';

const db = new PrismaClient();
const web = process.env.WEB_URL;
assert(web && process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD);
const suffix = randomUUID().slice(0, 10);
const common = `common${suffix}`;
const created = { projects: [], domains: [], mailboxes: [], member: null };
let cookie;
const before = new Date('2026-09-30T00:00:00Z');
const date = new Date('2026-10-05T12:00:00Z');

async function login(email, password) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(`${web}/api/v1/auth/login`, { method: 'POST', headers: { Origin: web, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (response.status === 429) { await new Promise(resolve => setTimeout(resolve, 10000)); continue; }
    assert.equal(response.status, 200, `login: ${response.status}`);
    return response.headers.get('set-cookie')?.split(';')[0];
  }
  throw new Error('Login rate limit did not clear');
}
async function search(input, session = cookie) {
  const response = await fetch(`${web}/api/v1/mail/search?${new URLSearchParams(input)}`, { headers: session ? { Cookie: session } : {} });
  return { status: response.status, data: await response.json() };
}
async function fixture(projectName) {
  const slug = `module7-${projectName}-${suffix}`;
  const project = await db.project.create({ data: { name: `Module 7 ${projectName}`, slug } }); created.projects.push(project.id);
  const domain = await db.domain.create({ data: { projectId: project.id, domain: `${slug}.example.test` } }); created.domains.push(domain.id);
  const mailbox = await db.mailbox.create({ data: { projectId: project.id, domainId: domain.id, email: `box@${slug}.example.test` } }); created.mailboxes.push(mailbox.id);
  const inbox = await db.mailFolder.create({ data: { mailboxId: mailbox.id, path: 'INBOX', name: 'INBOX', specialUse: 'INBOX' } });
  return { project, mailbox, inbox };
}

try {
  cookie = await login(process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_PASSWORD);
  const a = await fixture('a'); const b = await fixture('b');
  const sent = await db.mailFolder.create({ data: { mailboxId: a.mailbox.id, path: 'Sent', name: 'Sent', specialUse: 'SENT' } });
  const root = `h:${suffix.padEnd(32, '0')}`;
  const older = await db.mailMessage.create({ data: { mailboxId: a.mailbox.id, folderId: a.inbox.id, imapUid: 1n, threadKey: root,
    subject: `Subjectfind${suffix} ${common}`, fromName: `Senderfind${suffix}`, fromEmail: `sender-${suffix}@example.test`,
    textBody: `Bodyfind${suffix} text`, messageIdHeader: `<messagefind${suffix}@example.test>`, internalDate: date,
    isSeen: false, isFlagged: true, recipients: { create: [{ type: 'TO', name: `Recipientfind${suffix}`, email: `recipient-${suffix}@example.test` }] },
    attachments: { create: [{ filename: 'test.txt', contentType: 'text/plain', sizeBytes: 10n }] } } });
  const recent = await db.mailMessage.create({ data: { mailboxId: a.mailbox.id, folderId: a.inbox.id, imapUid: 2n, threadKey: root,
    subject: `Recent ${suffix}`, fromEmail: `recent-${suffix}@example.test`, textBody: 'Latest safe preview', internalDate: new Date(date.getTime() + 1000), isSeen: true } });
  await db.mailMessage.create({ data: { mailboxId: b.mailbox.id, folderId: b.inbox.id, imapUid: 1n, threadKey: root,
    subject: `Secondbox ${suffix} ${common}`, fromEmail: `second-${suffix}@example.test`, textBody: 'Other fixture', internalDate: date, isSeen: false } });
  await db.mailMessage.create({ data: { mailboxId: b.mailbox.id, folderId: b.inbox.id, imapUid: 2n, threadKey: `h:${'f'.repeat(32)}`,
    subject: `Htmlonly ${suffix}`, fromEmail: `html-${suffix}@example.test`, htmlBody: '<p>Safe preview</p><script>private script</script>', internalDate: before } });
  await db.mailMessage.create({ data: { mailboxId: a.mailbox.id, folderId: sent.id, imapUid: 1n, threadKey: `h:${'e'.repeat(32)}`,
    subject: `Sentfixture ${suffix}`, fromEmail: a.mailbox.email, internalDate: date } });
  await db.mailMessage.createMany({ data: Array.from({ length: 54 }, (_, i) => ({ mailboxId: a.mailbox.id, folderId: a.inbox.id,
    imapUid: BigInt(i + 3), threadKey: `h:${i.toString(16).padStart(32, '0')}`, subject: `Page ${suffix} ${i}`,
    fromEmail: `page-${i}@example.test`, internalDate: new Date(date.getTime() + 2000 + i * 1000), isSeen: true })) });
  const both = `${a.mailbox.id},${b.mailbox.id}`;
  const basic = await search({ mailboxIds: both, q: `Subjectfind${suffix}` });
  assert.equal(basic.status, 200); assert.equal(basic.data.items.length, 1);
  assert.equal(basic.data.items[0].id, recent.id); assert.equal(basic.data.items[0].matchedOlderMessage, true);
  assert.equal(basic.data.items[0].matchId, older.id); assert.equal(basic.data.items[0].messageCount, 2);
  for (const [field, value] of [['q', `Senderfind${suffix}`], ['q', `Recipientfind${suffix}`], ['q', `Bodyfind${suffix}`], ['q', `messagefind${suffix}`], ['from', `sender-${suffix}@example.test`], ['to', `recipient-${suffix}@example.test`], ['hasAttachment', 'true'], ['unread', 'true'], ['flagged', 'true']]) {
    const result = await search({ mailboxIds: a.mailbox.id, [field]: value });
    assert.equal(result.status, 200, `${field}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.items.length, 1, `${field}=${value}`);
    assert.equal(result.data.items[0].threadKey, root);
  }
  assert.equal((await search({ mailboxIds: a.mailbox.id, after: '2026-10-01', before: '2026-10-06', q: `Subjectfind${suffix}` })).data.items.length, 1);
  assert.equal((await search({ mailboxIds: a.mailbox.id, after: '2026-10-06', q: `Subjectfind${suffix}` })).data.items.length, 0);
  assert.equal((await search({ mailboxIds: a.mailbox.id, projectIds: b.project.id })).data.items.length, 0);
  assert.equal((await search({ mailboxIds: both, projectIds: a.project.id, q: common })).data.items.length, 1);
  assert.equal((await search({ mailboxIds: both, projectIds: `${a.project.id},${b.project.id}`, q: common })).data.items.length, 2);
  assert.equal((await search({ mailboxIds: a.mailbox.id, folder: 'SENT' })).data.items.length, 1);
  assert.equal((await search({ mailboxIds: a.mailbox.id, folderId: sent.id })).data.items.length, 1);
  assert.equal((await search({ mailboxIds: a.mailbox.id, folder: 'ALL', q: 'Sentfixture' })).data.items.length, 1);
  assert.equal((await search({ mailboxIds: a.mailbox.id, hasAttachment: 'false', limit: '100' })).data.items.length, 54);
  const unified = await search({ mailboxIds: both, q: common });
  assert.equal(unified.status, 200);
  assert(unified.data.items.some(item => item.mailboxId === a.mailbox.id && item.projectName === a.project.name));
  assert(unified.data.items.some(item => item.mailboxId === b.mailbox.id && item.projectName === b.project.name));
  const ids = new Set(); let cursor;
  for (let pageNumber = 0; pageNumber < 6; pageNumber++) {
    const page = await search({ mailboxIds: both, limit: '13', ...(cursor ? { cursor } : {}) });
    assert.equal(page.status, 200, JSON.stringify(page.data));
    for (const item of page.data.items) { const key = `${item.mailboxId}:${item.folderId}:${item.threadKey}`; assert(!ids.has(key), 'duplicate cursor row'); ids.add(key); }
    cursor = page.data.nextCursor;
    if (!cursor) break;
  }
  assert.equal(ids.size, 57);
  const firstPage = await search({ mailboxIds: both, limit: '13' });
  assert.equal((await search({ mailboxIds: both, limit: '13', q: common, cursor: firstPage.data.nextCursor })).status, 400);
  const html = await search({ mailboxIds: b.mailbox.id, q: 'Htmlonly' });
  assert.equal(html.status, 200); assert.equal(html.data.items.length, 1);
  assert(!html.data.items[0].snippet.includes('<')); assert(!html.data.items[0].snippet.includes('private script'));
  const injection = await search({ mailboxIds: a.mailbox.id, q: "' OR 1=1 --" });
  assert.equal(injection.status, 200); assert.equal(injection.data.items.length, 0);
  assert.equal((await search({ mailboxIds: a.mailbox.id, q: '%' })).data.items.length, 0);
  assert.equal((await search({ mailboxIds: both }, null)).status, 401);
  const memberPassword = `member-${suffix}`;
  const member = await db.user.create({ data: { name: 'Module 7 member', email: `member-${suffix}@example.test`, role: 'VIEWER', passwordHash: await argon2.hash(memberPassword) } }); created.member = member.id;
  const memberCookie = await login(member.email, memberPassword);
  assert.equal((await search({ mailboxIds: both }, memberCookie)).status, 403);
  await db.mailMessage.update({ where: { id: older.id }, data: { isSeen: true, isFlagged: false } });
  assert.equal((await search({ mailboxIds: a.mailbox.id, unread: 'true' })).data.items.length, 0);
  assert.equal((await search({ mailboxIds: a.mailbox.id, flagged: 'true' })).data.items.length, 0);
  console.log('Module 7 smoke passed: subject/sender/recipient/body/message-ID search, filters, older match, two-mailbox identity, cursor, RBAC, safe snippets, injection, unread/flagged updates.');
} finally {
  if (created.mailboxes.length) await db.mailbox.deleteMany({ where: { id: { in: created.mailboxes } } });
  if (created.domains.length) await db.domain.deleteMany({ where: { id: { in: created.domains } } });
  if (created.projects.length) await db.project.deleteMany({ where: { id: { in: created.projects } } });
  if (created.member) await db.user.delete({ where: { id: created.member } });
  await db.$disconnect();
}
