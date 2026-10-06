import { Webmail } from '@/components/webmail';

export default async function ThreadPage({ params }: { params: Promise<{ id: string; folderId: string; threadKey: string }> }) {
  const { id, folderId, threadKey } = await params;
  let decoded = threadKey;
  try { decoded = decodeURIComponent(threadKey); } catch { /* API validation handles malformed keys */ }
  return <Webmail routedMailboxId={id} routedFolderId={folderId} routedThreadKey={decoded}/>;
}
