import { notFound } from 'next/navigation';
import { Registry } from '@/components/registry';
import { Placeholder } from '@/components/placeholder';

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (section === 'projects' || section === 'domains' || section === 'mailboxes') return <Registry kind={section}/>;
  if (['inbox','sent','drafts','api-keys','templates','monitoring','logs','settings'].includes(section)) return <Placeholder section={section}/>;
  notFound();
}
