import { Webmail } from '@/components/webmail';

export default async function FolderPage({ params }: { params: Promise<{ id: string; folderId: string }> }) {
  const { id, folderId } = await params;
  return <Webmail routedMailboxId={id} routedFolderId={folderId}/>;
}
