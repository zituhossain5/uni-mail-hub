// Isolated UI fixture service. No database, SMTP, IMAP, or production API access.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

if (process.env.INBOX_DESIGN_PREVIEW !== '1' || process.env.NODE_ENV === 'production') {
  throw new Error('This fixture service requires INBOX_DESIGN_PREVIEW=1 outside production.');
}
const { PREVIEW_EMAIL, PREVIEW_PASSWORD, PREVIEW_SESSION_KEY } = process.env;
if (!PREVIEW_EMAIL || !PREVIEW_PASSWORD || !PREVIEW_SESSION_KEY) throw new Error('Preview login configuration is required.');
const user = { id:'preview-user', name:'Design workspace', email:PREVIEW_EMAIL, role:'SUPER_ADMIN' };
const uses = ['INBOX','SENT','DRAFTS','JUNK','TRASH','ARCHIVE','OTHER'];
const labels = ['Inbox','Sent','Drafts','Spam','Trash','Archive','Team updates'];
const now = new Date();
const at = (days, hour = 10, minute = 0) => { const value = new Date(now); value.setDate(value.getDate() - days); value.setHours(hour,minute,0,0); return value.toISOString(); };
const mailboxes = [
  { id:'preview-main', email:'contact@example.test', displayName:'UnicodeIT', project:{ name:'UnicodeIT' } },
  { id:'preview-support', email:'support@example.test', displayName:'Customer care', project:{ name:'Support' } },
].map(item => ({ ...item, projectId:`${item.id}-project`, status:'ACTIVE', isActive:true, credential:{ id:'sample-credential' }, mailServer:{ status:'ACTIVE', imapHost:'example.invalid', imapPort:993 }, syncRuns:[{ status:'COMPLETED', completedAt:now.toISOString(), errorCode:null, errorMessage:null }] }));
let lastSynced = now.toISOString();
const records = [];
const seed = [
  ['Sarah Chen','sarah@example.test','A fresh start for your inbox','Hi team,\n\nThe new inbox is ready for a closer look. Everything has a little more room: your folders, your conversations, and the messages that matter.\n\nHere’s what we can review together:\n\n• A calmer layout with your favorite workspace colors\n• Quick filters for unread mail, flagged messages, and files\n• A clear conversation view that works on smaller screens, too\n\nI’ve attached the review notes. Let me know what you think, and we can take it from here.\n\nThanks,\nSarah',0,10,42,true,true,true,2],
  ['Marcus Reed','marcus@example.test','Re: Website launch checklist','The launch checklist is looking good. I added the last few notes for the team to review.\n\nCould you check the copy and share any final changes by Friday?\n\nThanks,\nMarcus',0,10,28,true,false,false,3],
  ['Unigram','hello@unigram.example.test','Confirm your Unigram email','Open the confirmation email in the browser where you requested it.\n\nThis is a sample email for the design preview. There is no live verification link or token.\n\nYou can use this message to check the reading pane, reply controls, and recipient details.',0,9,55,false,false,false,1],
  ['Olivia Parker','olivia@example.test','April campaign — design files','Hi there,\n\nSharing the updated campaign notes for our next review. The attached file includes the latest decisions.\n\nHappy to walk through everything together.\n\nOlivia',0,9,17,true,false,true,1],
  ['Billing team','billing@example.test','Your monthly invoice is ready','Your sample invoice is ready to review.\n\nThis is demo content. No payment is required.\n\nThank you for being part of the workspace.',0,8,35,false,true,true,1],
  ['James Wilson','james@example.test','Quick catch-up next week?','Do you have a few minutes next week to talk through the project?\n\nTuesday or Wednesday works well for me. Let me know what suits you.\n\nJames',1,16,20,true,false,false,1],
  ['Product updates','updates@example.test','A few things we think you’ll love','Your workspace keeps getting better.\n\nThis month we focused on clearer navigation, faster replies, and a little more space to focus.\n\nTake a look around and tell us what you think.',1,14,10,false,false,false,1],
  ['Emma Taylor','emma@example.test','Feedback on the new dashboard','The new colors look great across the dashboard. I especially like how the panels feel connected to the rest of the workspace.\n\nI left a couple of ideas for the inbox in our review notes.\n\nEmma',1,11,5,false,true,false,2],
  ['Alex Morgan','alex@example.test','Project handoff notes','Hi team,\n\nEverything is ready for the handoff. You’ll find the notes attached.\n\nPlease keep all feedback in this conversation so nothing gets lost.\n\nAlex',2,15,25,false,false,true,1],
  ['Design team','design@example.test','The small details make a difference','A clear reading pane, a familiar folder list, and consistent colors help the workspace feel connected.\n\nWe can use this preview to try those details before making any live changes.',2,9,10,true,false,false,1],
  ['Noah Davis','noah@example.test','Updated timeline for the next release','Here’s the revised timeline for next week.\n\nThe review session is scheduled first, followed by any design changes we agree on.\n\nNoah',3,14,30,false,false,false,1],
  ['Workspace team','workspace@example.test','Welcome to your shared workspace','Welcome aboard!\n\nThis is a sample mailbox built for reviewing the inbox design. Try the filters, switch colors, open a conversation, or compose a test message.\n\nEverything stays inside this preview.',4,10,0,false,false,false,1],
  ['Mia Thompson','mia@example.test','Notes from our planning session','Thanks for the thoughtful discussion today.\n\nI’ve captured our decisions so the whole team can review them.\n\nMia',5,13,0,false,false,true,1],
  ['Ethan Brooks','ethan@example.test','A quick question about the brief','Could you share the latest version of the project brief when you have a moment?\n\nThanks,\nEthan',6,11,0,true,false,false,1],
];
for (const mailbox of mailboxes) {
  seed.forEach(([name,email,subject,text,days,hour,minute,unread,flagged,attachment,count], index) => {
    const threadKey = `sample-${index + 1}`;
    const messages = Array.from({ length:count }, (_,messageIndex) => ({
      id:`${mailbox.id}-${threadKey}-${messageIndex}`, subject, date:at(days,hour,minute-count+messageIndex+1), internalDate:at(days,hour,minute-count+messageIndex+1),
      fromName:name, fromEmail:email, textBody:messageIndex === count-1 ? text : 'Thanks for sharing the first draft. Let’s keep the feedback in this conversation and review the next version together.', htmlBody:null,
      hasRemoteImages:false, bodyLoaded:true, contentStatus:'AVAILABLE', isSeen:!unread || messageIndex !== count-1, isFlagged:flagged && messageIndex === count-1,
      recipients:[{ type:'TO', name:mailbox.displayName, email:mailbox.email }, ...(index === 0 ? [{ type:'CC', name:'Design team', email:'design@example.test' }] : [])],
      attachments:attachment && messageIndex === count-1 ? [{ id:'review-notes', filename:'review-notes.txt', contentType:'text/plain', sizeBytes:'412', disposition:'attachment', contentId:null, available:true }] : [],
      snippet:text.replaceAll('\n',' ').slice(0,180),
    }));
    records.push({ mailboxId:mailbox.id, folderId:`${mailbox.id}-inbox`, threadKey, messages });
  });
  records.push({ mailboxId:mailbox.id, folderId:`${mailbox.id}-archive`, threadKey:'archived-note', messages:[{ ...records.find(item => item.mailboxId === mailbox.id).messages[0], id:`${mailbox.id}-archived-note`, subject:'Completed: workspace planning', isSeen:true, isFlagged:false, attachments:[] }] });
}
const outbox = new Map();
const submitted = new Map();
function folderList(mailboxId) {
  return uses.map((specialUse,index) => {
    const id = `${mailboxId}-${specialUse.toLowerCase()}`;
    const messages = records.filter(item => item.mailboxId === mailboxId && item.folderId === id).flatMap(item => item.messages);
    return { id, mailboxId, path:labels[index], name:labels[index], specialUse, isSelectable:true, messageCount:messages.length, unseenCount:messages.filter(item => !item.isSeen).length, lastSyncedAt:lastSynced };
  });
}
function threadItem(record) {
  const latest = record.messages.at(-1);
  return { id:latest.id, threadKey:record.threadKey, subject:latest.subject, fromName:latest.fromName, fromEmail:latest.fromEmail, at:latest.date, messageCount:record.messages.length, unread:record.messages.some(item => !item.isSeen), flagged:record.messages.some(item => item.isFlagged), attachment:record.messages.some(item => item.attachments.length), snippet:latest.snippet };
}
function secureEqual(a, b) { const left=Buffer.from(a || ''); const right=Buffer.from(b || ''); return left.length === right.length && timingSafeEqual(left,right); }
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }); res.end(JSON.stringify(value)); }
async function readBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2097152) throw new Error('Request too large'); }
  return body ? JSON.parse(body) : {};
}

http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://127.0.0.1');
    const path = url.pathname.replace(/^\/api\/v1\//,'');
    if (path === 'health') return json(res,{ status:'ok', mode:'isolated-inbox-preview', outboundMail:false });
    const body = ['POST','PUT','PATCH'].includes(req.method) ? await readBody(req) : {};
    if (path === 'auth/login' && req.method === 'POST') {
      if (!secureEqual(body.email,PREVIEW_EMAIL) || !secureEqual(body.password,PREVIEW_PASSWORD)) return json(res,{ message:'Use the design preview account.' },401);
      return json(res,{ user, token:PREVIEW_SESSION_KEY });
    }
    if (!secureEqual(req.headers.authorization,`Bearer ${PREVIEW_SESSION_KEY}`)) return json(res,{ message:'Sign in to the design preview.' },401);
    if (path === 'auth/me') return json(res,user);
    if (path === 'auth/logout') return json(res,{ success:true });
    if (path === 'webmail/mailboxes') return json(res,mailboxes);
    if (path === 'admin/messages') return json(res,[...outbox.values()]);
    if (path.startsWith('admin/messages/')) return outbox.has(path.split('/')[2]) ? json(res,outbox.get(path.split('/')[2])) : json(res,{ message:'Sample message not found.' },404);
    const responseDraft = path.match(/^admin\/compose\/respond\/(.+)$/);
    if (responseDraft && req.method === 'GET') {
      const message = records.flatMap(item => item.messages).find(item => item.id === responseDraft[1]);
      if (!message) return json(res,{ message:'Sample source message not found.' },404);
      const kind=url.searchParams.get('kind') || 'REPLY';
      return json(res,{ kind, to:[{ email:message.fromEmail,name:message.fromName }], cc:kind === 'REPLY_ALL' ? message.recipients.filter(item => item.type === 'CC') : [], subject:`${kind === 'FORWARD' ? 'Fwd' : 'Re'}: ${message.subject}`, text:kind === 'FORWARD' ? message.textBody : '', attachmentCount:message.attachments.length, threadingAvailable:true });
    }
    if ((path === 'admin/compose' || path === 'admin/compose/respond') && req.method === 'POST') {
      const key=req.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length > 128) return json(res,{ message:'A preview request key is required.' },400);
      if (submitted.has(key)) return json(res,{ id:submitted.get(key) });
      const mailbox=mailboxes.find(item => item.id === body.fromMailboxId);
      if (!mailbox) return json(res,{ message:'Select a sample mailbox.' },400);
      const source=records.flatMap(item => item.messages).find(item => item.id === body.sourceMessageId);
      const id=randomUUID(); const createdAt=new Date().toISOString();
      const recipients=body.to?.length ? body.to : source ? [{ email:source.fromEmail }] : [];
      outbox.set(id,{ id, subject:body.subject || `Re: ${source?.subject || 'Sample response'}`, textBody:body.text || '', status:'QUEUED', createdAt, queuedAt:createdAt, processingAt:null, smtpAcceptedAt:null, failedAt:null, attemptCount:0, lastErrorCode:null, lastErrorMessage:null, rfcMessageId:null, apiKey:null, project:{ id:mailbox.projectId,name:mailbox.project.name }, fromMailbox:{ id:mailbox.id,email:mailbox.email }, recipients:recipients.map(item => ({ type:'TO',email:item.email,name:null,smtpStatus:'PENDING',smtpResponse:null })), attempts:[] });
      submitted.set(key,id);
      return json(res,{ id, status:'QUEUED', preview:true });
    }
    const scoped = path.match(/^mailboxes\/([^/]+)\/(.+)$/);
    if (scoped) {
      const [,mailboxId,route]=scoped;
      if (!mailboxes.some(item => item.id === mailboxId)) return json(res,{ message:'Sample mailbox not found.' },404);
      const folders=folderList(mailboxId);
      if (route === 'folders') return json(res,folders);
      if (route === 'sync-status') return json(res,{ latest:{ status:'COMPLETED',startedAt:lastSynced,completedAt:lastSynced,errorCode:null,errorMessage:null }, folderCount:folders.length,messageCount:folders.reduce((sum,item) => sum + item.messageCount,0) });
      if (route === 'sync' && req.method === 'POST') { lastSynced=new Date().toISOString(); return json(res,{ status:'QUEUED',preview:true }); }
      const threadRoute=route.match(/^folders\/([^/]+)\/threads(?:\/([^/]+))?$/);
      if (threadRoute) {
        const [,folderId,threadKey]=threadRoute;
        const folder=folders.find(item => item.id === folderId);
        if (!folder) return json(res,{ message:'Sample folder not found.' },404);
        const found=records.filter(item => item.mailboxId === mailboxId && item.folderId === folderId);
        if (threadKey) { const record=found.find(item => item.threadKey === decodeURIComponent(threadKey)); return record ? json(res,{ items:record.messages,nextCursor:null }) : json(res,{ items:[],nextCursor:null }); }
        const sorted=found.map(threadItem).sort((a,b) => new Date(b.at)-new Date(a.at));
        const offset=Math.max(0,Number(url.searchParams.get('cursor')) || 0);
        return json(res,{ folder,items:sorted.slice(offset,offset+10),nextCursor:offset+10 < sorted.length ? String(offset+10) : null });
      }
      const messageRoute=route.match(/^messages\/([^/]+)(?:\/(.+))?$/);
      if (messageRoute) {
        const [,messageId,action]=messageRoute;
        const record=records.find(item => item.mailboxId === mailboxId && item.messages.some(message => message.id === messageId));
        const message=record?.messages.find(item => item.id === messageId);
        if (!record || !message) return json(res,{ message:'Sample message not found.' },404);
        if (action?.startsWith('attachments/')) { res.writeHead(200,{ 'Content-Type':'text/plain','Content-Disposition':'attachment; filename="review-notes.txt"','Cache-Control':'no-store' }); return res.end('INBOX DESIGN REVIEW\n\nSample attachment for the isolated development preview.\n\nReview the folder list, message filters, reading pane, colors, and motion.\nNo real email is sent from this environment.\n'); }
        if (!action && req.method === 'GET') return json(res,message);
        if (req.method === 'POST') {
          if (action === 'read' || action === 'unread') message.isSeen=action === 'read';
          else if (action === 'flag' || action === 'unflag') message.isFlagged=action === 'flag';
          else if (['archive','trash','restore','move'].includes(action)) {
            const destination=action === 'move' ? body.folderId : `${mailboxId}-${action === 'restore' ? 'inbox' : action}`;
            if (!folders.some(item => item.id === destination)) return json(res,{ message:'Select a sample destination.' },400);
            record.folderId=destination;
          } else return json(res,{ message:'This action is unavailable in the preview.' },400);
          return json(res,{ status:'APPLIED',messageId,folderId:record.folderId,isSeen:message.isSeen,isFlagged:message.isFlagged,preview:true });
        }
      }
    }
    if (path === 'dashboard') return json(res,{ projects:2,domains:1,mailboxes:2,healthyMailboxes:2,warningMailboxes:0,errorMailboxes:0,unknownMailboxes:0,issueMailboxes:0,queuedMessages:outbox.size,processingMessages:0,retryScheduledMessages:0,smtpAcceptedToday:0,failedToday:0,recentActivity:[],monitoring:{ lastCheckedAt:lastSynced,criticalIssues:0,domainWarnings:0,queueFailures:0,healthyMailboxes:2,attentionMailboxes:0,worker:'UNKNOWN' } });
    if (path === 'dashboard/activity') return json(res,{ daily:Array.from({ length:30 },(_,index) => ({ date:new Date(now.getTime()-(29-index)*86400000).toISOString().slice(0,10),count:0 })),recentMessages:[...outbox.values()].slice(-5),timeZone:'UTC' });
    return json(res,{ message:'This isolated development preview supports Inbox, folders, and Outgoing Mail.' },404);
  } catch { if (!res.headersSent) json(res,{ message:'Unable to process this preview request.' },400); else res.end(); }
}).listen(Number(process.env.PREVIEW_API_PORT || 4396),'127.0.0.1',() => console.log('Isolated inbox fixture API ready on loopback. No outbound mail connections.'));
