import { ImapFlow, type FetchMessageObject, type ListResponse, type MessageStructureObject } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { classifyConnectionError, type Endpoint } from './index';
import { parseDsn, type DsnEvidence } from './dsn';

export type SyncRecipient = { type: 'TO' | 'CC' | 'BCC' | 'REPLY_TO'; name: string | null; email: string };
export type SyncAttachment = { filename: string | null; contentType: string; sizeBytes: bigint | null; contentId: string | null; disposition: string | null; imapPart: string | null };
export type SyncMessage = {
  messageIdHeader: string | null; subject: string | null; date: Date | null; internalDate: Date | null;
  fromName: string | null; fromEmail: string | null; textBody: string | null; htmlBody: string | null;
  sizeBytes: bigint | null; contentStatus: 'COMPLETE' | 'SKIPPED_TOO_LARGE' | 'PARSE_FAILED';
  isSeen: boolean; isFlagged: boolean; isAnswered: boolean; isDraft: boolean; isDeleted: boolean;
  inReplyTo: string | null; references: string[]; recipients: SyncRecipient[]; attachments: SyncAttachment[];
  dsn?: DsnEvidence | null;
};

export function createSyncClient(endpoint: Endpoint, username: string, password: string) {
  return new ImapFlow({ host: endpoint.host, port: endpoint.port, secure: endpoint.security === 'TLS', doSTARTTLS: endpoint.security === 'STARTTLS', auth: { user: username, pass: password }, logger: false, disableAutoIdle: true, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000 });
}

export function folderSpecialUse(folder: Pick<ListResponse, 'path' | 'specialUse' | 'specialUseSource'>): 'INBOX' | 'SENT' | 'DRAFTS' | 'TRASH' | 'JUNK' | 'ARCHIVE' | 'OTHER' {
  if (folder.path.toUpperCase() === 'INBOX') return 'INBOX';
  const special = folder.specialUse?.toLowerCase();
  const known: Record<string, 'SENT' | 'DRAFTS' | 'TRASH' | 'JUNK' | 'ARCHIVE'> = { '\\sent': 'SENT', '\\drafts': 'DRAFTS', '\\trash': 'TRASH', '\\junk': 'JUNK', '\\archive': 'ARCHIVE' };
  if (special && known[special]) return known[special];
  const last = folder.path.split(/[/.]/).at(-1)?.toLowerCase();
  if (last === 'sent' || last === 'sent items') return 'SENT';
  if (last === 'drafts') return 'DRAFTS';
  if (last === 'trash') return 'TRASH';
  if (last === 'junk' || last === 'spam') return 'JUNK';
  if (last === 'archive') return 'ARCHIVE';
  return 'OTHER';
}

export function initialUids(uids: number[], maxMessages: number): number[] {
  return [...new Set(uids.filter(uid => Number.isSafeInteger(uid) && uid > 0))].sort((a, b) => a - b).slice(-maxMessages);
}

export function advanceCursor(cursor: bigint, uid: bigint, persisted: boolean): bigint {
  return persisted && uid > cursor ? uid : cursor;
}

export function classifySyncError(error: unknown) {
  const mapped = classifyConnectionError('IMAP', error);
  const rawCode = String((error as { code?: string })?.code ?? (error instanceof Error ? error.message : '')).toUpperCase();
  if (rawCode === 'IMAP_READ_ONLY_REQUIRED' || error instanceof Error && error.message === 'IMAP_READ_ONLY_REQUIRED') return { code: 'IMAP_READ_ONLY_REQUIRED', message: 'The server did not open the folder in read-only mode.', retryable: false };
  if (rawCode === 'SYNC_LEASE_LOST' || error instanceof Error && error.message === 'SYNC_LEASE_LOST') return { code: 'SYNC_LEASE_LOST', message: 'Synchronization lease was lost; retrying safely.', retryable: true };
  const code = rawCode === 'CREDENTIAL_DECRYPTION_FAILED' ? rawCode : mapped.errorCode;
  const message = code === 'CREDENTIAL_DECRYPTION_FAILED' ? 'Stored mailbox credentials could not be decrypted.' : mapped.message;
  return { code, message, retryable: !['IMAP_AUTH_FAILED', 'IMAP_TLS_FAILED', 'CREDENTIAL_DECRYPTION_FAILED'].includes(code) };
}

function recipients(addresses: AddressObject | AddressObject[] | undefined, type: SyncRecipient['type']): SyncRecipient[] {
  const values = addresses ? Array.isArray(addresses) ? addresses : [addresses] : [];
  return values.flatMap(value => value.value.filter(item => item.address).map(item => ({ type, name: item.name || null, email: item.address! })));
}

function envelopeRecipients(message: FetchMessageObject): SyncRecipient[] {
  const envelope = message.envelope;
  if (!envelope) return [];
  const groups: Array<[SyncRecipient['type'], typeof envelope.to]> = [['TO', envelope.to], ['CC', envelope.cc], ['BCC', envelope.bcc], ['REPLY_TO', envelope.replyTo]];
  return groups.flatMap(([type, values]) => (values ?? []).filter(item => item.address).map(item => ({ type, name: item.name || null, email: item.address! })));
}

function structureAttachments(node: MessageStructureObject | undefined): SyncAttachment[] {
  if (!node) return [];
  const children = node.childNodes?.flatMap(structureAttachments) ?? [];
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
  const disposition = node.disposition?.toLowerCase() ?? null;
  if (!node.childNodes?.length && (filename || node.id || disposition === 'attachment' || disposition === 'inline')) {
    return [{ filename, contentType: node.type || 'application/octet-stream', sizeBytes: Number.isSafeInteger(node.size) && node.size! >= 0 ? BigInt(node.size!) : null, contentId: node.id ?? null, disposition, imapPart: node.part ?? null }];
  }
  return children;
}

function parsedAttachments(parsed: ParsedMail, structure: SyncAttachment[]): SyncAttachment[] {
  return parsed.attachments.map((attachment, index) => ({
    filename: attachment.filename ?? structure[index]?.filename ?? null,
    contentType: attachment.contentType || structure[index]?.contentType || 'application/octet-stream',
    sizeBytes: Number.isSafeInteger(attachment.size) ? BigInt(attachment.size) : structure[index]?.sizeBytes ?? null,
    contentId: attachment.contentId ?? structure[index]?.contentId ?? null,
    disposition: attachment.contentDisposition ?? structure[index]?.disposition ?? null,
    imapPart: attachment.partId ?? structure[index]?.imapPart ?? null,
  }));
}

export async function parseSyncMessage(message: FetchMessageObject, source: Buffer | undefined, maxBytes: number): Promise<SyncMessage> {
  const size = Number.isSafeInteger(message.size) && message.size! >= 0 ? BigInt(message.size!) : null;
  const tooLarge = size !== null && size > BigInt(maxBytes) || source !== undefined && source.length > maxBytes;
  let parsed: ParsedMail | null = null;
  let contentStatus: SyncMessage['contentStatus'] = tooLarge ? 'SKIPPED_TOO_LARGE' : 'COMPLETE';
  if (!tooLarge && source) {
    try { parsed = await simpleParser(source, { skipImageLinks: true, skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true }); }
    catch { contentStatus = 'PARSE_FAILED'; }
  } else if (!tooLarge) contentStatus = 'PARSE_FAILED';
  const envelope = message.envelope;
  const from = parsed?.from?.value[0] ?? envelope?.from?.[0];
  const references = parsed?.references ? Array.isArray(parsed.references) ? parsed.references : [parsed.references] : [];
  const structure = structureAttachments(message.bodyStructure);
  const flags = message.flags ?? new Set<string>();
  const internalDate = message.internalDate ? new Date(message.internalDate) : null;
  return {
    messageIdHeader: parsed?.messageId ?? envelope?.messageId ?? null,
    subject: parsed?.subject ?? envelope?.subject ?? null,
    date: parsed?.date ?? envelope?.date ?? null,
    internalDate: internalDate && Number.isFinite(internalDate.getTime()) ? internalDate : null,
    fromName: from?.name || null, fromEmail: from?.address || null,
    textBody: parsed?.text ?? null, htmlBody: parsed && typeof parsed.html === 'string' ? parsed.html : null,
    sizeBytes: size, contentStatus,
    isSeen: flags.has('\\Seen'), isFlagged: flags.has('\\Flagged'), isAnswered: flags.has('\\Answered'), isDraft: flags.has('\\Draft'), isDeleted: flags.has('\\Deleted'),
    inReplyTo: parsed?.inReplyTo ?? envelope?.inReplyTo ?? null,
    references,
    recipients: parsed ? [...recipients(parsed.to, 'TO'), ...recipients(parsed.cc, 'CC'), ...recipients(parsed.bcc, 'BCC'), ...recipients(parsed.replyTo, 'REPLY_TO')] : envelopeRecipients(message),
    attachments: parsed ? parsedAttachments(parsed, structure) : structure,
    dsn: parsed && source ? parseDsn(source) : null,
  };
}
