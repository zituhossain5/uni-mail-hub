import { Webmail } from '@/components/webmail';

export default async function ThreadPage({ params, searchParams }: { params: Promise<{ id: string; folderId: string; threadKey: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const { id, folderId, threadKey } = await params;
  const { returnTo } = await searchParams;
  let decoded = threadKey;
  try { decoded = decodeURIComponent(threadKey); } catch { /* API validation handles malformed keys */ }
  const safeReturn = returnTo && /^\/(unified|search|unread|flagged|attachments)(\?|$)/.test(returnTo) ? returnTo : undefined;
  return <Webmail routedMailboxId={id} routedFolderId={folderId} routedThreadKey={decoded} returnTo={safeReturn}/>;
}
