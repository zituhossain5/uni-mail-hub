'use client';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ChevronDown, Download, FileText, ImagePlus, Mail, Maximize2, Minimize2, Paperclip, Send, X } from 'lucide-react';
import { Dialog } from './dialog';
import type { ComposerValue, MailEditorHandle } from './mail-rich-editor';
import { mailAttachmentLimits, sendMessageSchema } from '@uni/shared';
import { composerTestMime, encodeComposerFiles, fileSize, inlineImageType, usedComposerFiles, type ComposerFile } from '@/lib/composer-files';
import { requestKey } from '@/lib/request-key';

const MailRichEditor = dynamic(() => import('./mail-rich-editor').then(module => module.MailRichEditor), { ssr:false, loading:() => <div className="mail-editor-loading" role="status">Preparing your editor…</div> });
const emptyBody: ComposerValue = { html:'',text:'',empty:true };
function addresses(value: string) { return value.split(/[,;\n]+/).map(email => email.trim()).filter(Boolean).map(email => ({ email })); }

export function WebmailCompose({ open, mailboxId, email, onClose }: { open:boolean; mailboxId:string; email:string; onClose:() => void }) {
  const router = useRouter();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [expanded,setExpanded] = useState(false);
  const [extraRecipients,setExtraRecipients] = useState(false);
  const [editorReady,setEditorReady] = useState(false);
  const [body,setBody] = useState<ComposerValue>(emptyBody);
  const [files,setFiles] = useState<ComposerFile[]>([]);
  const filesRef = useRef<ComposerFile[]>([]);
  const bodyRef = useRef(emptyBody);
  const [supportsAttachments,setSupportsAttachments] = useState<boolean | null>(null);
  const [testNotice,setTestNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const getFiles = useCallback(() => filesRef.current,[]);
  const changeBody = useCallback((value:ComposerValue) => { bodyRef.current=value; setBody(value); },[]);
  const addFiles = useCallback((incoming:File[],inline:boolean) => {
    const current = usedComposerFiles(filesRef.current,bodyRef.current.html);
    if (current.length + incoming.length > mailAttachmentLimits.count) throw new Error('Add up to 20 files per message, including inline images.');
    for (const file of incoming) if (file.size > mailAttachmentLimits.fileBytes) throw new Error(`${file.name} exceeds the 10 MB file limit.`);
    if (current.reduce((sum,item) => sum + item.file.size,0) + incoming.reduce((sum,file) => sum + file.size,0) > mailAttachmentLimits.totalBytes) throw new Error('The combined file limit is 20 MB. Remove a file before adding more.');
    const added = incoming.map(file => { const id=requestKey(); return { id,file,url:URL.createObjectURL(file),inline:inline && inlineImageType(file.type),contentId:`${id}@uni-mail-hub` }; });
    filesRef.current=[...filesRef.current,...added]; setFiles(filesRef.current); setError(''); setTestNotice(''); return added;
  },[]);
  useEffect(() => () => { for (const file of filesRef.current) URL.revokeObjectURL(file.url); },[]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch('/api/v1/admin/compose/capabilities',{ signal:controller.signal }).then(async response => {
      const result = response.ok ? await response.json() : null;
      setSupportsAttachments(result?.attachments === true);
    }).catch(() => { if (!controller.signal.aborted) setSupportsAttachments(false); });
    return () => controller.abort();
  },[open]);
  function pickFiles(incoming:File[],inline:boolean) {
    try { const added=addFiles(incoming,inline); if (inline) editorRef.current?.insertImages(added); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to add files.'); }
  }
  function removeFile(file:ComposerFile) {
    if (file.inline) editorRef.current?.removeImage(file.url);
    else { filesRef.current=filesRef.current.filter(item => item.id !== file.id); setFiles(filesRef.current); URL.revokeObjectURL(file.url); }
    setTestNotice('');
  }
  const editorRef = useRef<MailEditorHandle>(null);
  const idempotency = useRef('');
  function close() { if (!busy) { setError(''); setEditorReady(false); setExpanded(false); idempotency.current=''; onClose(); } }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !editorRef.current) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const to = addresses(String(form.get('to') || ''));
    const cc = addresses(String(form.get('cc') || ''));
    const bcc = addresses(String(form.get('bcc') || ''));
    const replyTo = String(form.get('replyTo') || '').trim();
    if (!to.length && !cc.length && !bcc.length) { setError('Add at least one recipient.'); return; }
    const { html,text,empty } = editorRef.current.getValue();
    const activeFiles = usedComposerFiles(filesRef.current,html);
    if (empty && !activeFiles.length) { setError('Write a message before sending.'); return; }
    if (Math.max(html.length,text.length) > 1048576) { setError('Your message exceeds the 1 MB body limit. Shorten it before sending.'); return; }
    setBusy(true); setError('');
    try {
      const attachments = await encodeComposerFiles(activeFiles);
      const parsed = sendMessageSchema.safeParse({ fromMailboxId:mailboxId,to,cc,bcc,...(replyTo ? { replyTo:{ email:replyTo } } : {}),subject:String(form.get('subject') || ''),text,html,...(attachments.length ? { attachments } : {}) });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || 'Check the message and attachments.');
      if (attachments.length && supportsAttachments !== true) {
        const mime = composerTestMime({ ...parsed.data,from:email,text,html,attachments },requestKey());
        const url = URL.createObjectURL(new Blob([mime],{ type:'message/rfc822' }));
        const link = document.createElement('a'); link.href=url; link.download='compose-test.eml'; link.click();
        setTimeout(() => URL.revokeObjectURL(url),10000);
        setTestNotice('Test email downloaded with your images and files. It has not been sent to recipients.'); return;
      }
      const payload = JSON.stringify(parsed.data);
      if (new TextEncoder().encode(payload).length > mailAttachmentLimits.requestBytes) throw new Error('This message is too large to submit. Remove a file before sending.');
      idempotency.current ||= requestKey();
      const response = await fetch('/api/v1/admin/compose', { method:'POST',headers:{ 'Content-Type':'application/json','Idempotency-Key':idempotency.current },body:payload });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Unable to queue message.');
      idempotency.current=''; formElement.reset(); changeBody(emptyBody); for (const file of filesRef.current) URL.revokeObjectURL(file.url); filesRef.current=[]; setFiles([]); setTestNotice(''); setExtraRecipients(false); setEditorReady(false); setExpanded(false); onClose();
      router.push(`/outgoing-mail/${result.id}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to queue message.'); }
    finally { setBusy(false); }
  }
  const activeFiles = usedComposerFiles(files,body.html);
  const totalBytes = activeFiles.reduce((sum,item) => sum + item.file.size,0);
  const testDownload = activeFiles.length > 0 && supportsAttachments === false;
  const words = body.text.trim() ? body.text.trim().split(/\s+/).length : 0;
  return <Dialog open={open} title="New message" description="Write freely. Your formatting travels with your message." size="wide" className={`mail-composer ${expanded ? 'mail-composer-expanded' : ''}`} onClose={close} dismissible={!busy}
    headerActions={<button type="button" className="icon-button" disabled={busy} aria-label={expanded ? 'Restore composer size' : 'Expand composer'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={18}/> : <Maximize2 size={18}/>}</button>}
    footer={<><span className="mail-composer-footer-note"><Mail size={14} aria-hidden="true"/><span>Formatted email<span className="mail-composer-word-count"> · {words} {words === 1 ? 'word' : 'words'}</span></span></span><button type="button" className="secondary-button" onClick={close} disabled={busy}>Close</button><button type="submit" form="webmail-compose-form" className="primary-button" disabled={busy || !editorReady || (activeFiles.length > 0 && supportsAttachments === null)}>{testDownload ? <Download size={15} aria-hidden="true"/> : <Send size={15} aria-hidden="true"/>}{busy ? 'Preparing…' : testDownload ? 'Download test email' : 'Send message'}</button></>}>
    <form id="webmail-compose-form" className="mail-compose-form" onSubmit={submit}>
      <fieldset className="mail-compose-envelope" disabled={busy}>
        <label className="mail-compose-from"><span>From</span><input value={email} disabled aria-label="Sender mailbox"/></label>
        <div className="mail-compose-to"><label><span>To</span><input name="to" aria-label="To" placeholder="name@example.com, other@example.com" autoComplete="off"/></label><button type="button" aria-expanded={extraRecipients} aria-controls="mail-extra-recipients" onClick={() => setExtraRecipients(value => !value)}>Cc / Bcc<ChevronDown size={13} aria-hidden="true"/></button></div>
        <div id="mail-extra-recipients" className="mail-compose-extra" hidden={!extraRecipients}><label><span>Cc</span><input name="cc" aria-label="CC" placeholder="Optional" autoComplete="off"/></label><label><span>Bcc</span><input name="bcc" aria-label="BCC" placeholder="Optional" autoComplete="off"/></label><label><span>Reply-To</span><input name="replyTo" aria-label="Reply-To" type="email" placeholder="Optional reply address"/></label></div>
        <label className="mail-compose-subject"><span>Subject</span><input name="subject" aria-label="Subject" placeholder="Add a subject" maxLength={998} required/></label>
      </fieldset>
      {open && <MailRichEditor editorRef={editorRef} initialContent={body.html} onChange={changeBody} getFiles={getFiles} onFiles={addFiles} onReady={() => setEditorReady(true)} disabled={busy}/>}
      <div className="mail-compose-files">
        <input ref={fileInput} type="file" multiple hidden aria-label="Attachment files" onChange={event => { pickFiles(Array.from(event.target.files || []),false); event.target.value=''; }}/>
        <input ref={imageInput} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Inline image files" onChange={event => { pickFiles(Array.from(event.target.files || []),true); event.target.value=''; }}/>
        <div className="mail-attachment-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => fileInput.current?.click()}><Paperclip size={15} aria-hidden="true"/>Attach files</button><button type="button" className="secondary-button" disabled={busy || !editorReady} onClick={() => imageInput.current?.click()}><ImagePlus size={15} aria-hidden="true"/>Add image</button><span>{activeFiles.length ? `${activeFiles.length} / 20 files · ${fileSize(totalBytes)} / 20 MB` : 'Paste or drop images and files · 10 MB per file'}</span></div>
        {activeFiles.length > 0 && <ul className="mail-attachment-list" aria-label="Message attachments">{activeFiles.map(file => <li key={file.id}>
          {file.inline ? <Image src={file.url} alt="" className="mail-attachment-thumb" width={40} height={40} unoptimized/> : <span className="mail-attachment-icon"><FileText size={21} aria-hidden="true"/></span>}
          <span className="mail-attachment-details"><strong title={file.file.name}>{file.file.name}</strong><small>{fileSize(file.file.size)}{file.inline ? ' · In message' : ' · Attachment'}</small></span>
          <button type="button" className="icon-button" disabled={busy} aria-label={`Remove ${file.file.name}`} onClick={() => removeFile(file)}><X size={15}/></button>
        </li>)}</ul>}
        {testDownload && <p className="mail-attachment-dev-note">Attachment delivery is being developed. Download this test email to check your images and files in a mail app. Recipients will not receive it.</p>}
      </div>
      {testNotice && <p className="mail-composer-test-notice" role="status">{testNotice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </Dialog>;
}
