import { redirect } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { Shell } from '@/components/shell';

export const dynamic = 'force-dynamic';
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const user = await apiGet<{ name: string; email: string; role: string }>('auth/me');
  if (!user) redirect('/login');
  return <Shell user={user}>{children}</Shell>;
}
