import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { UserDetail } from '@/components/users';

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await apiGet<{ role: 'SUPER_ADMIN' | 'ADMIN' }>('auth/me');
  if (!actor || !['SUPER_ADMIN','ADMIN'].includes(actor.role)) notFound();
  return <UserDetail id={id} actor={actor.role}/>;
}
