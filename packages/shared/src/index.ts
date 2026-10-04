import { z } from 'zod';

export const userRoles = ['SUPER_ADMIN', 'ADMIN', 'MEMBER'] as const;
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
export const queueNames = ['mail-send', 'mail-sync', 'mail-health', 'mail-webhook'] as const;
export type UserRole = (typeof userRoles)[number];
export type ProjectStatus = (typeof projectStatuses)[number];
export type DomainStatus = (typeof domainStatuses)[number];
export type MailboxStatus = (typeof mailboxStatuses)[number];
export type ProjectInput = z.infer<typeof projectSchema>;
export type DomainInput = z.infer<typeof domainSchema>;
export type MailboxInput = z.infer<typeof mailboxSchema>;
