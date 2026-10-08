import { headerId } from './threading';

export type DsnEvidence = { recipientEmail: string | null; originalMessageId: string | null; action: string | null; statusCode: string | null; classification: 'HARD_BOUNCE' | 'SOFT_BOUNCE' | 'UNKNOWN' };

function field(block: string, name: string): string | null {
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  return unfolded.match(new RegExp(`(?:^|\\r?\\n)${name}:\\s*([^\\r\\n]+)`, 'i'))?.[1]?.trim() ?? null;
}

export function parseDsn(source: Buffer): DsnEvidence | null {
  const raw = source.toString('latin1');
  const separator = raw.search(/\r?\n\r?\n/);
  if (separator < 0) return null;
  const header = raw.slice(0, separator);
  const contentType = field(header, 'Content-Type');
  if (!contentType || !/^multipart\/report\s*;/i.test(contentType) || !/report-type\s*=\s*"?delivery-status"?/i.test(contentType)) return null;
  const boundary = contentType.match(/boundary\s*=\s*(?:"([^"]{1,70})"|([^;\s]{1,70}))/i)?.[1] ?? contentType.match(/boundary\s*=\s*([^;\s]{1,70})/i)?.[1];
  if (!boundary || /[\r\n]/.test(boundary)) return null;
  const parts = raw.slice(separator).split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?(?:\\r?\\n|$)`));
  const statusPart = parts.find(part => /^\s*Content-Type:\s*message\/delivery-status\b/im.test(part.slice(0, 1000)));
  if (!statusPart) return null;
  const statusBody = statusPart.split(/\r?\n\r?\n/).slice(1).join('\n\n');
  const blocks = statusBody.split(/\r?\n\r?\n/).filter(block => /(?:^|\n)Final-Recipient:/i.test(block));
  if (blocks.length !== 1) return { recipientEmail: null, originalMessageId: null, action: null, statusCode: null, classification: 'UNKNOWN' };
  const recipientRaw = field(blocks[0]!, 'Final-Recipient');
  const recipientEmail = recipientRaw?.match(/^rfc822\s*;\s*([^\s;<>]+@[^\s;<>]+)$/i)?.[1]?.toLowerCase() ?? null;
  const action = field(blocks[0]!, 'Action')?.toLowerCase() ?? null;
  const statusCode = field(blocks[0]!, 'Status')?.match(/^([245]\.\d{1,3}\.\d{1,3})\b/)?.[1] ?? null;
  const embedded = parts.find(part => /^\s*Content-Type:\s*message\/rfc822\b/im.test(part.slice(0, 1000)));
  const originalMessageId = headerId(field(blocks[0]!, 'Original-Message-ID') ?? field(statusBody, 'Original-Message-ID') ?? (embedded ? field(embedded, 'Message-ID') : null));
  const classification = action === 'failed' && statusCode?.startsWith('5.') ? 'HARD_BOUNCE'
    : statusCode?.startsWith('4.') && ['failed', 'delayed'].includes(action ?? '') ? 'SOFT_BOUNCE' : 'UNKNOWN';
  return { recipientEmail, originalMessageId, action, statusCode, classification };
}
