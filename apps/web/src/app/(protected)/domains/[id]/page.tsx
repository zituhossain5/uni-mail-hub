import { DomainHealth } from '@/components/domain-health';

export default async function DomainPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DomainHealth id={id}/>;
}
