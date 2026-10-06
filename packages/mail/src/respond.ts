import { headerId } from './threading';

type Address = { email: string; name: string | null };
type Recipient = Address & { type: string };
type Original = { fromEmail: string | null; fromName: string | null; messageIdHeader: string | null; references: string[]; subject: string | null; date: Date | null; textBody: string | null; recipients: Recipient[]; attachments?: unknown[] };

function usable(email: string | null): string | null {
  const value = email?.trim().toLowerCase();
  return value && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) ? value : null;
}

export function replyRecipients(original: Pick<Original, 'fromEmail' | 'fromName' | 'recipients'>, sendingEmail: string, all: boolean): { to: Address[]; cc: Address[] } {
  const own = usable(sendingEmail);
  const seen = new Set(all && own ? [own] : []);
  const to: Address[] = [];
  const cc: Address[] = [];
  const add = (email: string | null, name: string | null, group: Address[]) => {
    const valid = usable(email);
    if (!valid || seen.has(valid)) return;
    seen.add(valid); group.push({ email: valid, name });
  };
  const replyTo = original.recipients.find(item => item.type === 'REPLY_TO' && usable(item.email));
  add(replyTo?.email ?? original.fromEmail, replyTo?.name ?? original.fromName, to);
  if (all) {
    // The original BCC list is never reconstructed into a reply.
    for (const recipient of original.recipients.filter(item => item.type === 'TO')) add(recipient.email, recipient.name, to);
    for (const recipient of original.recipients.filter(item => item.type === 'CC')) add(recipient.email, recipient.name, cc);
  }
  return { to, cc };
}

export function responseHeaders(original: Pick<Original, 'messageIdHeader' | 'references'>): { inReplyTo: string | null; references: string[] } {
  const parent = headerId(original.messageIdHeader);
  const ids = [...original.references.map(headerId), parent].filter((value): value is string => !!value);
  const unique = [...new Set(ids)].slice(-40).map(value => `<${value}>`);
  return { inReplyTo: parent ? `<${parent}>` : null, references: unique };
}

export function responseSubject(kind: 'REPLY' | 'REPLY_ALL' | 'FORWARD', original: Pick<Original, 'subject'>): string {
  const subject = original.subject?.trim() || '(No subject)';
  const prefix = kind === 'FORWARD' ? 'Fwd:' : 'Re:';
  return new RegExp(`^${prefix.replace(':', '')}:`, 'i').test(subject) ? subject : `${prefix} ${subject}`;
}

export function forwardedBlock(original: Pick<Original, 'fromEmail' | 'fromName' | 'date' | 'subject' | 'textBody' | 'recipients'>): string {
  const from = original.fromName ? `${original.fromName} <${original.fromEmail ?? ''}>` : original.fromEmail ?? 'Unknown';
  const to = original.recipients.filter(item => item.type === 'TO').map(item => item.email).join(', ') || 'Undisclosed';
  return `\n\n---------- Forwarded message ----------\nFrom: ${from}\nDate: ${original.date?.toISOString() ?? 'Unknown'}\nSubject: ${original.subject ?? '(No subject)'}\nTo: ${to}\n\n${original.textBody ?? '[Original HTML body omitted from this text forward]'}`;
}
