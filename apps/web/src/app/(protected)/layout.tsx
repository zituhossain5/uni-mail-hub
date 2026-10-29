import { redirect } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { Shell } from '@/components/shell';
import type { WorkspaceRole } from '@/components/access-context';

export const dynamic = 'force-dynamic';
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const user = await apiGet<{ name: string; email: string; role: WorkspaceRole }>('auth/me');
  if (!user) redirect('/login');
  const preview = process.env.NODE_ENV === 'development' && process.env.INBOX_DESIGN_PREVIEW === '1';
  return <Shell user={user} preview={preview} livePreview={preview && process.env.INBOX_PREVIEW_BACKEND === 'live'}>{children}</Shell>;
}
