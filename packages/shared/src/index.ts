import { z } from 'zod';

export const userRoles = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF', 'VIEWER'] as const;
export const projectStatuses = ['ACTIVE', 'INACTIVE'] as const;
export const domainStatuses = ['UNVERIFIED', 'ACTIVE', 'ISSUE', 'DISABLED'] as const;
export const mailboxStatuses = ['UNKNOWN', 'HEALTHY', 'WARNING', 'ERROR', 'DISABLED'] as const;
export const providerTypes = ['CPANEL', 'GENERIC', 'CUSTOM', 'OTHER'] as const;
export const connectionSecurities = ['NONE', 'STARTTLS', 'TLS'] as const;
export const smtpAuthModes = ['PASSWORD', 'NONE'] as const;
const host = z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.[\]:-]+$/);
const port = z.number().int().min(1).max(65535);
export const mailServerFields = z.object({
  name: z.string().trim().min(1).max(120),
  providerType: z.enum(providerTypes),
  imapHost: host.nullable().optional(), imapPort: port.nullable().optional(), imapSecurity: z.enum(connectionSecurities),
  smtpHost: host.nullable().optional(), smtpPort: port.nullable().optional(), smtpSecurity: z.enum(connectionSecurities),
  smtpAuthMode: z.enum(smtpAuthModes), status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});
export const mailServerSchema = mailServerFields.refine(v => Boolean(v.imapHost) === Boolean(v.imapPort), { message: 'IMAP host and port must be set together' })
  .refine(v => Boolean(v.smtpHost) === Boolean(v.smtpPort), { message: 'SMTP host and port must be set together' })
  .refine(v => Boolean(v.imapHost || v.smtpHost), { message: 'At least one protocol must be configured' });
export const credentialSchema = z.object({ username: z.string().trim().min(1).max(320), password: z.string().min(1).max(4096) });

export const projectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(projectStatuses).optional(),
});
export const domainSchema = z.object({
  projectId: z.string().cuid(),
  domain: z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/).max(253),
  status: z.enum(domainStatuses).optional(),
});
export const mailboxSchema = z.object({
  projectId: z.string().cuid(),
  domainId: z.string().cuid(),
  mailServerId: z.string().cuid().nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(320),
  displayName: z.string().trim().max(120).nullable().optional(),
  status: z.enum(mailboxStatuses).optional(),
  isActive: z.boolean().optional(),
});
export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export const queueNames = ['mail-send', 'mail-sync', 'cpanel-discovery', 'monitoring', 'webhook-delivery'] as const;
const address = z.object({ email: z.string().trim().toLowerCase().email().max(320), name: z.string().trim().max(120).optional() }).strict();
export const mailAttachmentLimits = { count:20, fileBytes:10 * 1024 * 1024, totalBytes:20 * 1024 * 1024, requestBytes:30 * 1024 * 1024 } as const;
export function base64Bytes(value: string) { return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0); }
export const outgoingAttachmentSchema = z.object({
  filename:z.string().min(1).max(255).regex(/^[^/\\]+$/).refine(value => Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'Invalid filename'),
  contentType:z.string().max(127).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  contentBase64:z.string().max(Math.ceil(mailAttachmentLimits.fileBytes / 3) * 4).refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'Invalid base64 content'),
  disposition:z.enum(['attachment','inline']),
  contentId:z.string().max(160).regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/).optional(),
}).strict().superRefine((file,ctx) => {
  if (base64Bytes(file.contentBase64) > mailAttachmentLimits.fileBytes) ctx.addIssue({ code:'custom',message:'File exceeds 10 MB' });
  if (file.disposition === 'inline' && (!file.contentId || !/^image\/(png|jpeg|gif|webp)$/i.test(file.contentType))) ctx.addIssue({ code:'custom',message:'Inline images require a content ID and PNG, JPEG, GIF or WebP format' });
  if (file.disposition === 'attachment' && file.contentId) ctx.addIssue({ code:'custom',message:'Only inline images may have a content ID' });
});
export type OutgoingAttachmentInput = z.infer<typeof outgoingAttachmentSchema>;
export const sendMessageSchema = z.object({
  fromMailboxId: z.string().cuid(),
  to: z.array(address).max(50).default([]),
  cc: z.array(address).max(50).default([]),
  bcc: z.array(address).max(50).default([]),
  replyTo: address.optional(),
  subject: z.string().trim().min(1).max(998),
  text: z.string().max(1048576).optional(),
  html: z.string().max(1048576).optional(),
  attachments:z.array(outgoingAttachmentSchema).max(mailAttachmentLimits.count).optional(),
}).strict().superRefine((value,ctx) => {
  const files = value.attachments ?? [];
  if (files.reduce((sum,file) => sum + base64Bytes(file.contentBase64),0) > mailAttachmentLimits.totalBytes) ctx.addIssue({ code:'custom',message:'Attachments exceed 20 MB total' });
  const ids = files.filter(file => file.disposition === 'inline').map(file => file.contentId!);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code:'custom',message:'Duplicate inline image content ID' });
  for (const match of (value.html ?? '').matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"cid:([^"]+)"|'cid:([^']+)'|cid:([^\s>]+))/gi)) if (!ids.includes((match[1] ?? match[2] ?? match[3])!)) ctx.addIssue({ code:'custom',message:'Inline image is missing its attachment' });
}).refine(value => Boolean(value.text || value.html || value.attachments?.length), { message: 'Message content or an attachment is required' })
  .refine(value => value.to.length + value.cc.length + value.bcc.length > 0, { message: 'At least one recipient is required' });
export const apiKeyCreateSchema = z.object({
  projectId: z.string().cuid(), name: z.string().trim().min(1).max(120),
  mailboxIds: z.array(z.string().cuid()).min(1).max(100),
  expiresAt: z.string().datetime().nullable().optional(),
  scopes: z.array(z.literal('MAIL_SEND')).min(1).default(['MAIL_SEND']),
  integration: z.literal(true).optional(),
}).strict();
export type UserRole = (typeof userRoles)[number];
export type ProjectStatus = (typeof projectStatuses)[number];
export type DomainStatus = (typeof domainStatuses)[number];
export type MailboxStatus = (typeof mailboxStatuses)[number];
export type ProjectInput = z.infer<typeof projectSchema>;
export type DomainInput = z.infer<typeof domainSchema>;
export type MailboxInput = z.infer<typeof mailboxSchema>;
