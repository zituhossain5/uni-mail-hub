export type SpecialUse = 'INBOX' | 'SENT' | 'DRAFTS' | 'JUNK' | 'TRASH' | 'ARCHIVE';
export type FolderLike = { id: string; mailboxId: string; specialUse: string; isSelectable: boolean };
export const specialPaths: Record<SpecialUse, string> = { INBOX: '/inbox', SENT: '/sent', DRAFTS: '/drafts', JUNK: '/spam', TRASH: '/trash', ARCHIVE: '/archive' };

export function resolveFolder<T extends FolderLike>(folders: T[], mailboxId: string | undefined, specialUse?: SpecialUse, folderId?: string): T | undefined {
  return folderId ? folders.find(item => item.mailboxId === mailboxId && item.id === folderId) : folders.find(item => item.mailboxId === mailboxId && item.specialUse === specialUse && item.isSelectable);
}

export function extraFolders<T extends FolderLike>(folders: T[]): T[] {
  return folders.filter(item => item.isSelectable && (item.specialUse === 'OTHER' || folders.find(first => first.specialUse === item.specialUse && first.isSelectable)?.id !== item.id));
}

export function folderHref(mailboxId: string, folder: FolderLike): string {
  const special = folder.specialUse as SpecialUse;
  return special in specialPaths ? `${specialPaths[special]}?mailbox=${encodeURIComponent(mailboxId)}` : `/mailboxes/${mailboxId}/folders/${folder.id}`;
}
