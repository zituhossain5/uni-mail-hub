'use client';
import { useState } from 'react';
import { Archive, Flag, FolderInput, MailOpen, Mail, RotateCcw, Trash2 } from 'lucide-react';

type Folder = { id: string; name: string; path: string; specialUse: string; isSelectable: boolean };
type ActionResult = { status: string; messageId: string; folderId: string; isSeen?: boolean; isFlagged?: boolean };

export function WebmailActions({ mailboxId, message, folders, currentFolderId, onChanged, onMoved }: {
  mailboxId: string; message: { id: string; isSeen: boolean; isFlagged: boolean }; folders: Folder[]; currentFolderId: string;
  onChanged: (state: { isSeen: boolean; isFlagged: boolean }) => void; onMoved: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const archive = folders.find(item => item.specialUse === 'ARCHIVE' && item.isSelectable && item.id !== currentFolderId);
  const trash = folders.find(item => item.specialUse === 'TRASH' && item.isSelectable && item.id !== currentFolderId);
  const inbox = folders.find(item => item.specialUse === 'INBOX' && item.isSelectable && item.id !== currentFolderId);
  const inTrash = folders.some(item => item.id === currentFolderId && item.specialUse === 'TRASH');
  async function run(action: string, folderId?: string) {
    if (busy) return;
    setBusy(action); setError('');
    try {
      const response = await fetch(`/api/v1/mailboxes/${mailboxId}/messages/${message.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(folderId ? { body: JSON.stringify({ folderId }) } : {}) });
      const result = await response.json() as ActionResult & { message?: string };
      if (!response.ok) throw new Error(result.message ?? 'Mail action failed. Refresh and try again.');
      if (action === 'move' || action === 'archive' || action === 'trash' || action === 'restore') onMoved();
      else onChanged({ isSeen: result.isSeen ?? message.isSeen, isFlagged: result.isFlagged ?? message.isFlagged });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Mail action failed.'); }
    finally { setBusy(''); }
  }
  const destinations = folders.filter(item => item.isSelectable && item.id !== currentFolderId);
  return <div className="webmail-action-area"><div className="webmail-action-toolbar" aria-label="Message actions">
    <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void run(message.isSeen ? 'unread' : 'read')}>{message.isSeen ? <Mail size={14}/> : <MailOpen size={14}/>} {message.isSeen ? 'Mark unread' : 'Mark read'}</button>
    <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void run(message.isFlagged ? 'unflag' : 'flag')}><Flag size={14}/> {message.isFlagged ? 'Unflag' : 'Flag'}</button>
    {archive && <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void run('archive')}><Archive size={14}/> Archive</button>}
    {trash && <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void run('trash')}><Trash2 size={14}/> Trash</button>}
    {inTrash && inbox && <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void run('restore')}><RotateCcw size={14}/> Restore to Inbox</button>}
    <label className="webmail-move-label"><FolderInput size={14}/><select aria-label="Move to folder" value={target} disabled={!!busy} onChange={event => setTarget(event.target.value)}><option value="">Move to…</option>{destinations.map(item => <option key={item.id} value={item.id}>{item.name || item.path}</option>)}</select></label>
    <button type="button" className="secondary-button" disabled={!target || !!busy} onClick={() => void run('move', target)}>Move</button>
  </div>{busy && <p className="webmail-action-status" role="status">Updating mail on the server…</p>}{error && <p className="form-error" role="alert">{error}</p>}</div>;
}
