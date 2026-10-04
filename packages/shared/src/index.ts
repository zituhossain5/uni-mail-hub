import { z } from 'zod';

export const userRoles = ['SUPER_ADMIN', 'ADMIN', 'MEMBER'] as const;
export const projectStatuses = ['ACTIVE', 'INACTIVE'] as const;
export const domainStatuses = ['UNVERIFIED', 'ACTIVE', 'ISSUE', 'DISABLED'] as const;
export const mailboxStatuses = ['UNKNOWN', 'HEALTHY', 'WARNING', 'ERROR', 'DISABLED'] as const;
export const providerTypes = ['CPANEL', 'CUSTOM', 'OTHER'] as const;

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
