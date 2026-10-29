import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.NODE_ENV !== 'test' || new URL(process.env.DATABASE_URL).hostname !== 'attachment-test-postgres' || new URL(process.env.API_URL).hostname !== 'attachment-test-api') throw new Error('ISOLATED_ATTACHMENT_TEST_ONLY');
const require=createRequire('/app/apps/api/package.json');
const { PrismaClient }=require('@uni/database');
const argon2=require('argon2');
const { simpleParser }=createRequire('/app/packages/mail/package.json')('mailparser');
const db=new PrismaClient();
const origin=process.env.API_URL;
const capture='http://attachment-test-smtp:8080';
let token;
async function request(path,body,key) {
  return fetch(origin+'/api/v1/'+path,{ method:body === undefined ? 'GET' : 'POST',headers:{ 'Content-Type':'application/json',...(token ? { Authorization:'Bearer '+token } : {}),...(key ? { 'Idempotency-Key':key } : {}) },...(body === undefined ? {} : { body:JSON.stringify(body) }) });
}
async function accepted(id) {
  for (let attempt=0;attempt<100;attempt++) {
    const message=await db.outgoingMessage.findUniqueOrThrow({ where:{ id } });
    if (message.status === 'SMTP_ACCEPTED') return message;
    assert.notEqual(message.status,'FAILED',message.lastErrorCode || 'SMTP failed');
    await delay(300);
  }
  throw new Error('SMTP acceptance timeout');
}
try {
  const password=randomBytes(32).toString('base64url');
  const user=await db.user.create({ data:{ email:'attachment-check@example.invalid',name:'Isolated attachment check',passwordHash:await argon2.hash(password),role:'SUPER_ADMIN' } });
  const project=await db.project.create({ data:{ name:'Isolated attachments',slug:'attachments-'+randomUUID() } });
  const domain=await db.domain.create({ data:{ projectId:project.id,domain:'attachments.example.invalid',status:'ACTIVE' } });
  const server=await db.mailServer.create({ data:{ name:'Local capture',smtpHost:'attachment-test-smtp',smtpPort:1025,smtpSecurity:'NONE',smtpAuthMode:'NONE',status:'ACTIVE' } });
  const mailbox=await db.mailbox.create({ data:{ projectId:project.id,domainId:domain.id,mailServerId:server.id,email:'sender@attachments.example.invalid',isActive:true,status:'HEALTHY' } });
  const login=await request('auth/login',{ email:user.email,password }); assert.equal(login.status,201); token=(await login.json()).token; assert.ok(token);
  const capability=await request('admin/compose/capabilities'); assert.equal(capability.status,200); assert.equal((await capability.json()).attachments,true);
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=','base64');
  const file=Buffer.alloc(3*1024*1024,0xa5);
  const textFile=Buffer.from('Attached text with Unicode ✓');
  const payload={ fromMailboxId:mailbox.id,to:[{ email:'recipient@example.invalid' }],bcc:[{ email:'blind@example.invalid' }],subject:'Isolated attachment delivery',text:'Rich email with image and files ✓',html:'<p><strong>Rich email ✓</strong><img src="cid:pixel@attachment-test"></p>',attachments:[
    { filename:'pixel.png',contentType:'image/png',contentBase64:image.toString('base64'),disposition:'inline',contentId:'pixel@attachment-test' },
    { filename:'binary.bin',contentType:'application/octet-stream',contentBase64:file.toString('base64'),disposition:'attachment' },
    { filename:'Résumé.txt',contentType:'text/plain',contentBase64:textFile.toString('base64'),disposition:'attachment' },
  ] };
  const key=randomUUID(); const queued=await request('admin/compose',payload,key); assert.equal(queued.status,202,JSON.stringify(await queued.clone().json())); const result=await queued.json();
  await accepted(result.id);
  const stored=await db.outgoingAttachment.findMany({ where:{ messageId:result.id } }); assert.equal(stored.length,3); assert.deepEqual(Buffer.from(stored.find(item => item.filename === 'binary.bin').content),file);
  const raw=await (await fetch(capture+'/messages/0.eml')).text(); const parsed=await simpleParser(raw,{ skipImageLinks:true });
  assert.equal(parsed.attachments.length,3); assert.deepEqual(parsed.attachments.find(item => item.filename === 'binary.bin').content,file); assert.deepEqual(parsed.attachments.find(item => item.filename === 'Résumé.txt').content,textFile); assert.deepEqual(parsed.attachments.find(item => item.cid === 'pixel@attachment-test').content,image); assert.match(parsed.html,/cid:pixel@attachment-test/); assert.doesNotMatch(raw,/^Bcc:/mi); assert.match(parsed.text,/files ✓/);
  const repeated=await request('admin/compose',payload,key); assert.equal(repeated.status,202); assert.equal((await repeated.json()).id,result.id); await delay(500); assert.equal((await (await fetch(capture+'/messages')).json()).count,1);
  const conflict=await request('admin/compose',{ ...payload,attachments:payload.attachments.slice(0,2) },key); assert.equal(conflict.status,409);
  const invalid=await request('admin/compose',{ ...payload,attachments:[{ ...payload.attachments[0],path:'/etc/passwd' }] },randomUUID()); assert.equal(invalid.status,400);
  const legacy=await request('admin/compose',{ fromMailboxId:mailbox.id,to:[{ email:'recipient@example.invalid' }],subject:'Legacy compose',text:'Text-only production compatibility' },randomUUID()); assert.equal(legacy.status,202); await accepted((await legacy.json()).id); assert.equal((await (await fetch(capture+'/messages')).json()).count,2);
  console.log(JSON.stringify({ passed:true,delivery:'isolated SMTP capture',externalEmailsSent:0,checks:['real login and capabilities','4 MB JSON request accepted','database attachment bytes','API → durable outbox → Redis → worker → SMTP','inline CID linkage','Unicode file names','exact binary bytes','BCC headers omitted','idempotent retries','changed-content conflict','file paths rejected','legacy messages delivered'] }));
} finally {
  if (token) await request('auth/logout',{}).catch(() => {});
  await db.$disconnect();
}
