import { notFound } from 'next/navigation';
import { Registry } from '@/components/registry';
import { Placeholder } from '@/components/placeholder';
import { MailServers } from '@/components/mail-servers';
import { ApiKeys } from '@/components/api-keys';
import { OutgoingMail } from '@/components/outgoing-mail';
import { Webmail } from '@/components/webmail';
import { MailExplorer } from '@/components/mail-explorer';
import { CpanelAccounts } from '@/components/cpanel-accounts';
import { Monitoring } from '@/components/monitoring';
import { SecuritySettings } from '@/components/security-settings';
import { Suspense } from 'react';

export default async function SectionPage({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ mailbox?: string }> }) {
  const { section } = await params;
  const { mailbox } = await searchParams;
  if (section === 'projects' || section === 'domains' || section === 'mailboxes') return <Registry kind={section}/>;
  if (section === 'mail-servers') return <MailServers/>;
  if (section === 'cpanel-accounts') return <CpanelAccounts/>;
  if (section === 'monitoring') return <Monitoring/>;
  if (section === 'api-keys') return <ApiKeys/>;
  if (section === 'outgoing-mail') return <OutgoingMail/>;
  if (['unified', 'search', 'unread', 'flagged', 'attachments'].includes(section)) return <Suspense fallback={<div className="webmail-skeleton" role="status">Loading mail…</div>}><MailExplorer view={section as 'unified' | 'search' | 'unread' | 'flagged' | 'attachments'}/></Suspense>;
  const mailFolders = { inbox: 'INBOX', sent: 'SENT', drafts: 'DRAFTS', spam: 'JUNK', trash: 'TRASH', archive: 'ARCHIVE' } as const;
  if (section in mailFolders) return <Webmail specialUse={mailFolders[section as keyof typeof mailFolders]} initialMailboxId={mailbox}/>;
  if (section === 'settings') return <SecuritySettings/>;
  if (['templates','logs'].includes(section)) return <Placeholder section={section}/>;
  notFound();
}
