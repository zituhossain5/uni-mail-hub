'use client';
import { FormEvent, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from './dialog';

function addresses(value: string) { return value.split(/[,;\n]+/).map(email => email.trim()).filter(Boolean).map(email => ({ email })); }

export function WebmailCompose({ open, mailboxId, email, onClose }: { open: boolean; mailboxId: string; email: string; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const idempotency = useRef('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const to = addresses(String(form.get('to') ?? ''));
    const cc = addresses(String(form.get('cc') ?? ''));
    const bcc = addresses(String(form.get('bcc') ?? ''));
    const replyToEmail = String(form.get('replyTo') ?? '').trim();
    const text = String(form.get('text') ?? '').trim();
    const html = String(form.get('html') ?? '').trim();
    if (!to.length && !cc.length && !bcc.length) { setError('Add at least one recipient.'); setBusy(false); return; }
    if (!text && !html) { setError('Add a plain-text or HTML body.'); setBusy(false); return; }
    idempotency.current ||= window.crypto.randomUUID();
    try {
      const response = await fetch('/api/v1/admin/compose', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency.current }, body: JSON.stringify({ fromMailboxId: mailboxId, to, cc, bcc, ...(replyToEmail ? { replyTo: { email: replyToEmail } } : {}), subject: String(form.get('subject') ?? ''), ...(text ? { text } : {}), ...(html ? { html } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Unable to queue message.');
      idempotency.current = '';
      onClose();
      router.push(`/outgoing-mail/${result.id}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to queue message.'); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} title="Compose message" description="Send through the selected mailbox using Uni Mail Hub's outgoing queue." size="wide" onClose={() => { if (!busy) { setError(''); idempotency.current = ''; onClose(); } }} dismissible={!busy} footer={<><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="webmail-compose-form" className="primary-button" disabled={busy}>{busy ? 'Queuing…' : 'Send message'}</button></>}><form id="webmail-compose-form" className="entity-form" onSubmit={submit}><label>From<input value={email} disabled aria-label="Sender mailbox"/></label><label>To<input name="to" placeholder="name@example.com, other@example.com" autoComplete="off"/></label><div className="form-row"><label>CC<input name="cc" placeholder="Optional" autoComplete="off"/></label><label>BCC<input name="bcc" placeholder="Optional" autoComplete="off"/></label></div><label>Reply-To<input name="replyTo" type="email" placeholder="Optional"/></label><label>Subject<input name="subject" maxLength={998} required/></label><label>Plain-text body<textarea name="text" rows={8} maxLength={1048576} placeholder="Write your message…"/></label><label>HTML body <small>Optional. Sent as supplied; include plain text for broad compatibility.</small><textarea name="html" rows={5} maxLength={1048576} placeholder="<p>Optional HTML version</p>"/></label>{error && <p className="form-error" role="alert">{error}</p>}<p className="form-note">Delivery progress appears in Outgoing Mail. The IMAP Sent folder updates only if your mail server stores a sent copy.</p></form></Dialog>;
}
