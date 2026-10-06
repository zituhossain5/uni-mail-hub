import { createHash } from 'node:crypto';

/** A deliberately conservative mailbox-local conversation identity. */
export function headerId(value: string | null | undefined): string | null {
  if (!value) return null;
  const bracketed = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  const candidate = (bracketed?.[1] ?? value.trim().replace(/^</, '').replace(/>$/, '')).trim();
  return /^[^<>\s]+@[^<>\s]+$/.test(candidate) ? candidate.toLowerCase() : null;
}

export function headerThreadKey(value: string): string {
  return `h:${createHash('md5').update(value).digest('hex')}`;
}

export function threadKeyFor(message: { references: string[]; inReplyTo: string | null; messageIdHeader: string | null }, folderId: string, uid: bigint, parentKey?: string | null): string {
  const root = message.references.map(headerId).find((id): id is string => !!id);
  if (root) return headerThreadKey(root);
  const parent = headerId(message.inReplyTo);
  if (parent) return parentKey ?? headerThreadKey(parent);
  const own = headerId(message.messageIdHeader);
  return own ? headerThreadKey(own) : `local:${folderId}:${uid}`;
}
