import { notFound } from 'next/navigation';
import { Registry } from '@/components/registry';
import { Placeholder } from '@/components/placeholder';
import { MailServers } from '@/components/mail-servers';
import { ApiKeys } from '@/components/api-keys';
import { OutgoingMail } from '@/components/outgoing-mail';

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (section === 'projects' || section === 'domains' || section === 'mailboxes') return <Registry kind={section}/>;
  if (section === 'mail-servers') return <MailServers/>;
  if (section === 'api-keys') return <ApiKeys/>;
  if (section === 'outgoing-mail') return <OutgoingMail/>;
  if (['inbox','sent','drafts','templates','monitoring','logs','settings'].includes(section)) return <Placeholder section={section}/>;
  notFound();
}
