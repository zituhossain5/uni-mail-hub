'use client';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from './dialog';

export type ResponseKind = 'REPLY' | 'REPLY_ALL' | 'FORWARD';
type Draft = { kind: ResponseKind; to: { email: string; name: string | null }[]; cc: { email: string; name: string | null }[]; subject: string; text: string; attachmentCount: number; threadingAvailable: boolean };
function addresses(value: string) { return value.split(/[,;\n]+/).map(email => email.trim()).filter(Boolean).map(email => ({ email })); }

export function WebmailResponse({ mailboxId, sourceMessageId, kind, onClose }: { mailboxId: string; sourceMessageId: string; kind: ResponseKind; onClose: () => void }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const idempotency = useRef('');
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/v1/admin/compose/respond/${sourceMessageId}?fromMailboxId=${encodeURIComponent(mailboxId)}&kind=${kind}`, { cache: 'no-store' }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.message ?? 'Unable to prepare response.');
      return value as Draft;
    }).then(value => { if (!cancelled) { setDraft(value); setText(kind === 'FORWARD' ? '' : value.text); } }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to prepare response.'); });
    return () => { cancelled = true; };
  }, [mailboxId, sourceMessageId, kind]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !draft) return;
    const form = new FormData(event.currentTarget);
    idempotency.current ||= window.crypto.randomUUID();
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/admin/compose/respond', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency.current }, body: JSON.stringify({ fromMailboxId: mailboxId, sourceMessageId, kind, text, ...(kind === 'FORWARD' ? { to: addresses(String(form.get('to') ?? '')), cc: addresses(String(form.get('cc') ?? '')), bcc: addresses(String(form.get('bcc') ?? '')) } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Unable to queue response.');
      idempotency.current = '';
      onClose();
      router.push(`/outgoing-mail/${result.id}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to queue response.'); }
    finally { setBusy(false); }
  }
  const label = kind === 'REPLY_ALL' ? 'Reply all' : kind === 'FORWARD' ? 'Forward' : 'Reply';
  return <Dialog open title={label} description="Send through the selected managed mailbox and track delivery in Outgoing Mail." size="wide" onClose={() => { if (!busy) onClose(); }} dismissible={!busy} footer={<><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" form="webmail-response-form" className="primary-button" disabled={busy || !draft}>{busy ? 'Queuing…' : `Send ${label.toLowerCase()}`}</button></>}>
    {!draft && !error ? <p role="status">Preparing recipients and threading headers…</p> : <form id="webmail-response-form" className="entity-form" onSubmit={submit}>
      {draft && <><label>Subject<input value={draft.subject} readOnly/></label>{kind === 'FORWARD' ? <><label>To<input name="to" placeholder="recipient@example.com" required/></label><div className="form-row"><label>CC<input name="cc" placeholder="Optional"/></label><label>BCC<input name="bcc" placeholder="Optional"/></label></div></> : <><p className="webmail-response-recipients"><strong>To:</strong> {draft.to.map(item => item.email).join(', ') || 'No valid recipient'}</p>{draft.cc.length > 0 && <p className="webmail-response-recipients"><strong>CC:</strong> {draft.cc.map(item => item.email).join(', ')}</p>}</>}
      <label>Message<textarea rows={9} value={text} onChange={event => setText(event.target.value)} placeholder="Write your message…" maxLength={1048576}/></label>
      {kind === 'FORWARD' && <details className="webmail-forward-preview"><summary>Forwarded message preview</summary><pre>{draft.text}</pre></details>}
      {draft.attachmentCount > 0 && <p className="form-note">Original attachments are not included. Download and attach them separately when attachment sending is available.</p>}
      {kind !== 'FORWARD' && !draft.threadingAvailable && <p className="form-note">The original has no usable Message-ID, so the response may appear as a separate conversation.</p>}</>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>}
  </Dialog>;
}
