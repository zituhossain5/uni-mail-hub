'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Archive, ArrowLeft, ChevronDown, ChevronRight, FileText, Inbox, Mail, Paperclip, RefreshCw, Send, ShieldAlert, Star, Trash2 } from 'lucide-react';
import { WebmailCompose } from './webmail-compose';
import { WebmailActions } from './webmail-actions';
import { WebmailResponse, type ResponseKind } from './webmail-response';
import { extraFolders, folderHref, resolveFolder, specialPaths, type SpecialUse } from '@/lib/webmail-folders';
import { createAutoReadGate } from '@/lib/auto-read';
import { conversationFlags, plainTextLines, unseenChange } from '@/lib/webmail-state';

type Mailbox = { id: string; email: string; displayName: string | null; projectId: string; project: { name: string }; status: string; isActive: boolean; credential: { id: string } | null; mailServer: { status: string; imapHost: string | null; imapPort: number | null } | null; syncRuns: { status: string; completedAt: string | null; errorCode: string | null; errorMessage: string | null }[] };
type Folder = { id: string; mailboxId: string; path: string; name: string; specialUse: string; isSelectable: boolean; messageCount: number | null; unseenCount: number | null; lastSyncedAt: string | null };
type Thread = { id: string; threadKey: string; subject: string | null; fromName: string | null; fromEmail: string | null; at: string; messageCount: number; unread: boolean; flagged: boolean; attachment: boolean; snippet: string };
type ThreadPage = { folder: Folder; items: Thread[]; nextCursor: string | null };
type Recipient = { type: string; name: string | null; email: string };
type Attachment = { id: string; filename: string | null; contentType: string; sizeBytes: string | null; disposition: string | null; contentId: string | null; available: boolean };
type Message = { id: string; subject: string | null; date: string | null; internalDate: string | null; fromName: string | null; fromEmail: string | null; textBody: string | null; htmlBody: string | null; hasRemoteImages: boolean; bodyLoaded: boolean; snippet?: string; contentStatus: string; isSeen: boolean; isFlagged: boolean; recipients: Recipient[]; attachments: Attachment[] };
type ThreadDetail = { items: Message[]; nextCursor: string | null };
type SyncStatus = { latest: { status: string; startedAt: string; completedAt: string | null; errorCode: string | null; errorMessage: string | null } | null; folderCount: number; messageCount: number };
type MessageChange = { threadKey: string; wasSeen: boolean; isSeen: boolean; unread: boolean | null; flagged: boolean | null };

const order: SpecialUse[] = ['INBOX', 'SENT', 'DRAFTS', 'JUNK', 'TRASH', 'ARCHIVE'];
const names: Record<SpecialUse, string> = { INBOX: 'Inbox', SENT: 'Sent', DRAFTS: 'Drafts', JUNK: 'Spam', TRASH: 'Trash', ARCHIVE: 'Archive' };
const icons = { INBOX: Inbox, SENT: Send, DRAFTS: FileText, JUNK: ShieldAlert, TRASH: Trash2, ARCHIVE: Archive };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers }, cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? 'The mail service is unavailable.');
  return value as T;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'Unable to load mail right now.'; }
function threadHref(mailboxId: string, folderId: string, key: string): string { return `/mailboxes/${mailboxId}/folders/${folderId}/threads/${key}`; }
function displayDate(value: string, full = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown date';
  if (full) return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  if (now.getTime() - date.getTime() < 6 * 86400000 && now.getTime() >= date.getTime()) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}
function displaySize(value: string | null): string { if (!value) return 'Unknown size'; const size = Number(value); if (!Number.isFinite(size)) return 'Unknown size'; return size < 1024 ? `${size} B` : size < 1048576 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`; }
function sender(message: { fromName: string | null; fromEmail: string | null }) { return message.fromName || message.fromEmail || 'Unknown sender'; }

export function Webmail({ specialUse, initialMailboxId, routedMailboxId, routedFolderId, routedThreadKey, returnTo }: { specialUse?: SpecialUse; initialMailboxId?: string; routedMailboxId?: string; routedFolderId?: string; routedThreadKey?: string; returnTo?: string }) {
  const router = useRouter();
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loadingMailboxes, setLoadingMailboxes] = useState(true);
  const [mailboxError, setMailboxError] = useState('');
  const mailboxId = routedMailboxId ?? (initialMailboxId && mailboxes.some(item => item.id === initialMailboxId) ? initialMailboxId : mailboxes[0]?.id);
  const mailbox = mailboxes.find(item => item.id === mailboxId);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [folderLoading, setFolderLoading] = useState(true);
  const [loadedMailboxId, setLoadedMailboxId] = useState('');
  const [folderError, setFolderError] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [loadedThreadScope, setLoadedThreadScope] = useState('');
  const [threadError, setThreadError] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncQueuedAt, setSyncQueuedAt] = useState(0);
  const [syncError, setSyncError] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api<Mailbox[]>('webmail/mailboxes').then(items => { if (!cancelled) { setMailboxes(items); setMailboxError(''); } }).catch(error => { if (!cancelled) setMailboxError(errorText(error)); }).finally(() => { if (!cancelled) setLoadingMailboxes(false); });
    return () => { cancelled = true; };
  }, []);

  const loadFolderState = useCallback(async (id: string) => {
    const [found, sync] = await Promise.all([api<Folder[]>(`mailboxes/${id}/folders`), api<SyncStatus>(`mailboxes/${id}/sync-status`)]);
    return { found, sync };
  }, []);
  useEffect(() => {
    if (!mailboxId) return;
    let cancelled = false;
    void Promise.resolve().then(() => { setFolderLoading(true); setFolderError(''); }).then(() => loadFolderState(mailboxId)).then(({ found, sync }) => { if (!cancelled) { setFolders(found); setStatus(sync); } }).catch(error => { if (!cancelled) setFolderError(errorText(error)); }).finally(() => { if (!cancelled) { setLoadedMailboxId(mailboxId); setFolderLoading(false); } });
    return () => { cancelled = true; };
  }, [mailboxId, loadFolderState, reload]);

  const folder = useMemo(() => resolveFolder(folders, mailboxId, specialUse, routedFolderId), [folders, mailboxId, routedFolderId, specialUse]);
  const messageChanged = useCallback((change: MessageChange) => {
    if (change.wasSeen !== change.isSeen) setFolders(current => current.map(item => item.id === folder?.id && item.unseenCount !== null ? { ...item, unseenCount: Math.max(0, item.unseenCount + unseenChange(change.wasSeen, change.isSeen)) } : item));
    setThreads(current => current.map(item => item.threadKey === change.threadKey ? { ...item, unread: change.unread ?? item.unread, flagged: change.flagged ?? item.flagged } : item));
  }, [folder?.id]);
  const threadScope = `${mailboxId ?? ''}:${folder?.id ?? ''}:${reload}`;
  useEffect(() => {
    if (!mailboxId || !folder?.id) { return; }
    let cancelled = false;
    const scope = `${mailboxId}:${folder.id}:${reload}`;
    void Promise.resolve().then(() => { setThreadsLoading(true); setThreadError(''); setThreads([]); setNextCursor(null); }).then(() => api<ThreadPage>(`mailboxes/${mailboxId}/folders/${folder.id}/threads`)).then(page => { if (!cancelled) { setThreads(page.items); setNextCursor(page.nextCursor); } }).catch(error => { if (!cancelled) setThreadError(errorText(error)); }).finally(() => { if (!cancelled) { setLoadedThreadScope(scope); setThreadsLoading(false); } });
    return () => { cancelled = true; };
  }, [mailboxId, folder?.id, reload]);

  useEffect(() => {
    if (!mailboxId || !syncQueuedAt) return;
    const timer = window.setInterval(() => {
      void loadFolderState(mailboxId).then(({ found, sync }) => {
        setFolders(found); setStatus(sync);
        if (sync.latest?.completedAt && new Date(sync.latest.completedAt).getTime() >= syncQueuedAt - 1000 || Date.now() - syncQueuedAt > 300000) {
          setSyncQueuedAt(0); setReload(value => value + 1);
        }
      }).catch(error => setSyncError(errorText(error)));
    }, 3500);
    return () => window.clearInterval(timer);
  }, [mailboxId, syncQueuedAt, loadFolderState]);

  async function loadMore() {
    if (!mailboxId || !folder || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<ThreadPage>(`mailboxes/${mailboxId}/folders/${folder.id}/threads?cursor=${encodeURIComponent(nextCursor)}`);
      setThreads(current => [...current, ...page.items.filter(item => !current.some(existing => existing.threadKey === item.threadKey))]);
      setNextCursor(page.nextCursor); setThreadError('');
    } catch (error) { setThreadError(errorText(error)); }
    finally { setLoadingMore(false); }
  }
  async function syncNow() {
    if (!mailboxId || syncing || syncQueuedAt) return;
    setSyncing(true); setSyncError('');
    try { await api(`mailboxes/${mailboxId}/sync`, { method: 'POST' }); setSyncQueuedAt(Date.now()); }
    catch (error) { setSyncError(errorText(error)); }
    finally { setSyncing(false); }
  }
  function switchMailbox(id: string) {
    if (specialUse) router.push(`${specialPaths[specialUse]}?mailbox=${encodeURIComponent(id)}`);
    else router.push(`/inbox?mailbox=${encodeURIComponent(id)}`);
  }
  const currentStatus = loadedMailboxId === mailboxId ? status : null;
  const issue = !mailbox?.isActive || mailbox?.status === 'DISABLED' ? 'This mailbox is disabled.' : !mailbox?.credential ? 'Mailbox credentials are missing.' : !mailbox?.mailServer?.imapHost || !mailbox?.mailServer?.imapPort || mailbox?.mailServer?.status !== 'ACTIVE' ? 'An active IMAP server is required.' : currentStatus?.latest?.status === 'FAILED' ? `Last sync failed: ${currentStatus.latest.errorMessage ?? currentStatus.latest.errorCode ?? 'Connection error'}.` : loadedMailboxId === mailboxId && !currentStatus?.latest ? 'This mailbox has not been synchronized yet.' : '';
  const canSync = !!mailbox?.isActive && mailbox.status !== 'DISABLED' && !!mailbox.credential && mailbox.mailServer?.status === 'ACTIVE' && !!mailbox.mailServer.imapHost && !!mailbox.mailServer.imapPort;
  const title = folder ? folder.specialUse in names ? names[folder.specialUse as SpecialUse] : folder.name : specialUse ? names[specialUse] : 'Folder';
  const moreFolders = extraFolders(folders);

  return <div className={`webmail ${routedThreadKey ? 'webmail-thread-open' : ''}`}>
    <div className="webmail-heading"><div><div className="eyebrow">WEBMAIL · SYNCED MAIL</div><h1>{title}</h1><p>{mailbox?.project.name ?? 'Workspace'}{mailbox ? ` / ${mailbox.email}` : ''}</p></div><div className="webmail-actions"><label className="webmail-mailbox-label">Mailbox<select aria-label="Select mailbox" value={mailboxId ?? ''} onChange={event => switchMailbox(event.target.value)} disabled={loadingMailboxes || mailboxes.length === 0}>{mailboxes.length === 0 && <option value="">No mailboxes</option>}{mailboxes.map(item => <option key={item.id} value={item.id}>{item.project.name} / {item.email}</option>)}</select></label><button className="secondary-button" onClick={() => void syncNow()} disabled={!canSync || syncing || !!syncQueuedAt}><RefreshCw size={15} className={syncing || syncQueuedAt ? 'webmail-spin' : ''} aria-hidden="true"/>{syncing ? 'Queuing…' : syncQueuedAt ? 'Sync queued' : 'Sync now'}</button><button className="primary-button" onClick={() => setComposeOpen(true)} disabled={!mailbox || !mailbox.isActive || mailbox.status === 'DISABLED'}><Mail size={15} aria-hidden="true"/>Compose</button></div></div>
    {mailboxError && <div className="webmail-notice error" role="alert"><AlertCircle size={17}/>{mailboxError}</div>}
    {folderError && <div className="webmail-notice error" role="alert"><AlertCircle size={17}/>{folderError}</div>}
    {syncError && <div className="webmail-notice error" role="alert"><AlertCircle size={17}/>{syncError}</div>}
    {mailbox && issue && <div className="webmail-notice" role="status"><AlertCircle size={17}/><span>{issue} <Link href={`/mailboxes/${mailbox.id}`}>Open mailbox settings</Link></span></div>}
    {!!syncQueuedAt && <div className="webmail-notice" role="status"><RefreshCw size={16} className="webmail-spin"/>Synchronization is queued or running. Messages will refresh when it finishes.</div>}
    {loadingMailboxes || folderLoading || !!mailboxId && loadedMailboxId !== mailboxId ? <div className="webmail-skeleton" role="status" aria-label="Loading mail"><span/><span/><span/><span/></div> : mailboxes.length === 0 ? <div className="webmail-empty"><Mail size={34}/><h2>No mailboxes yet</h2><p>Add a mailbox to begin browsing synchronized mail.</p><Link className="secondary-button" href="/mailboxes">Manage mailboxes</Link></div> : !mailbox ? <div className="webmail-empty"><h2>Mailbox unavailable</h2><p>This mailbox is not available in your workspace.</p><Link href="/inbox" className="secondary-button">Go to Inbox</Link></div> : <div className="webmail-layout">
      <nav className="webmail-folders" aria-label="Mailbox folders"><div className="webmail-rail-title">FOLDERS <span>{folders.length}</span></div>{order.map(use => { const found = resolveFolder(folders, mailbox.id, use); const Icon = icons[use]; return found ? <Link key={use} href={folderHref(mailbox.id, found)} className={`webmail-folder ${found.id === folder?.id ? 'active' : ''}`} aria-current={found.id === folder?.id ? 'page' : undefined}><Icon size={17} aria-hidden="true"/><span>{names[use]}</span>{found.unseenCount != null && found.unseenCount > 0 && <small aria-label={`${found.unseenCount} unread`}>{found.unseenCount}</small>}</Link> : null; })}{moreFolders.length > 0 && <><div className="webmail-rail-title more">MORE</div>{moreFolders.map(item => <Link key={item.id} href={`/mailboxes/${mailbox.id}/folders/${item.id}`} className={`webmail-folder ${item.id === folder?.id ? 'active' : ''}`} aria-current={item.id === folder?.id ? 'page' : undefined}><Mail size={16} aria-hidden="true"/><span title={item.path}>{item.name || item.path}</span>{item.unseenCount != null && item.unseenCount > 0 && <small>{item.unseenCount}</small>}</Link>)}</>}</nav>
      <section className="webmail-list" aria-label={`${title} conversations`}><div className="webmail-list-head"><div><h2>{title}</h2><p>{folder ? `${folder.messageCount ?? '—'} on server · ${threads.length}${nextCursor ? '+' : ''} conversations shown` : 'Synchronized folder'}</p></div><button className="icon-button" aria-label="Refresh synchronized messages" onClick={() => setReload(value => value + 1)}><RefreshCw size={17}/></button></div>
        {!folder ? <div className="webmail-empty"><Inbox size={30}/><h3>{specialUse ? `No ${names[specialUse]} folder` : 'Folder unavailable'}</h3><p>{currentStatus?.latest ? 'This mail server has not exposed this synchronized folder.' : 'Run the first mailbox sync to discover folders and messages.'}</p>{canSync && !currentStatus?.latest && <button className="secondary-button" onClick={() => void syncNow()}>Sync now</button>}</div> : threadsLoading || loadedThreadScope !== threadScope ? <div className="webmail-list-skeleton" role="status" aria-label="Loading conversations">{Array.from({ length: 6 }, (_, index) => <div key={index}><i/><span><b/><em/></span></div>)}</div> : threadError && threads.length === 0 ? <div className="webmail-empty"><AlertCircle size={28}/><h3>Unable to load messages</h3><p>{threadError}</p><button className="secondary-button" onClick={() => setReload(value => value + 1)}>Try again</button></div> : threads.length === 0 ? <div className="webmail-empty"><Inbox size={30}/><h3>{title} is empty</h3><p>No messages are currently synchronized for this folder.</p></div> : <><div className="webmail-rows">{threads.map(item => <Link key={item.threadKey} href={threadHref(mailbox.id, folder.id, item.threadKey)} className={`webmail-row ${item.unread ? 'unread' : ''} ${item.threadKey === routedThreadKey ? 'selected' : ''}`} aria-label={`${item.unread ? 'Unread, ' : ''}${sender(item)}, ${item.subject || 'No subject'}, ${item.messageCount} messages`}><span className="webmail-avatar" aria-hidden="true">{sender(item).slice(0, 1).toUpperCase()}</span><span className="webmail-row-main"><span className="webmail-row-top"><strong title={sender(item)}>{sender(item)}</strong><time dateTime={item.at} title={displayDate(item.at, true)}>{displayDate(item.at)}</time></span><span className="webmail-row-subject" title={item.subject ?? undefined}>{item.subject || '(No subject)'}{item.messageCount > 1 && <small> {item.messageCount}</small>}</span><span className="webmail-row-bottom"><span>{item.snippet || 'No preview available'}</span>{item.attachment && <Paperclip size={13} aria-label="Has attachment"/>}{item.flagged && <Star size={13} fill="currentColor" aria-label="Flagged"/>}</span></span>{item.unread && <span className="webmail-unread-dot" aria-hidden="true"/>}</Link>)}</div>{threadError && <p className="form-error" role="alert">{threadError}</p>}{nextCursor && <div className="webmail-load-more"><button className="secondary-button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more conversations'}</button></div>}</>}
      </section>
      {routedThreadKey && folder ? <ThreadReader key={`${folder.id}:${routedThreadKey}`} mailboxId={mailbox.id} folder={folder} folders={folders} threadKey={routedThreadKey} returnTo={returnTo} onChanged={messageChanged}/> : <div className="webmail-reader-placeholder"><Mail size={35}/><h2>Select a conversation</h2><p>Choose a conversation to read it here.</p></div>}
    </div>}
    {mailbox && <WebmailCompose key={mailbox.id} open={composeOpen} mailboxId={mailbox.id} email={mailbox.email} onClose={() => setComposeOpen(false)}/>}
  </div>;
}

function ThreadReader({ mailboxId, folder, folders, threadKey, returnTo, onChanged }: { mailboxId: string; folder: Folder; folders: Folder[]; threadKey: string; returnTo?: string; onChanged: (change: MessageChange) => void }) {
  const router = useRouter();
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const detailRef = useRef<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [remoteImages, setRemoteImages] = useState(false);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [loadingMessageId, setLoadingMessageId] = useState('');
  const [loadingImages, setLoadingImages] = useState(false);
  const [respond, setRespond] = useState<{ messageId: string; kind: ResponseKind } | null>(null);
  const [autoReadError, setAutoReadError] = useState('');
  const [autoReadAttempted, setAutoReadAttempted] = useState<Set<string>>(() => new Set());
  const path = `mailboxes/${mailboxId}/folders/${folder.id}/threads/${threadKey}`;
  const backHref = returnTo ?? folderHref(mailboxId, folder);
  useEffect(() => { detailRef.current = detail; }, [detail]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement;
      if (target instanceof HTMLElement && target.closest('[role=dialog]')) return;
      const menu = document.querySelector<HTMLDetailsElement>('.webmail-reader .webmail-more-actions[open]');
      if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); event.preventDefault(); return; }
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      router.push(backHref);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router, backHref]);
  useEffect(() => {
    let cancelled = false;
    void api<ThreadDetail>(path).then(value => { if (!cancelled) { setDetail(value); setError(''); } }).catch(reason => { if (!cancelled) setError(errorText(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);
  async function loadImages() {
    if (!detail) return;
    setLoadingImages(true);
    try { const loaded = await Promise.all(detail.items.filter(item => item.bodyLoaded).map(item => api<Message>(`mailboxes/${mailboxId}/messages/${item.id}?remoteImages=true`))); const byId = new Map(loaded.map(item => [item.id, item])); setDetail(current => current ? { ...current, items: current.items.map(item => byId.has(item.id) ? { ...byId.get(item.id)!, snippet: item.snippet } : item) } : current); setRemoteImages(true); setError(''); }
    catch (reason) { setError(errorText(reason)); }
    finally { setLoadingImages(false); }
  }
  async function loadMessage(id: string) {
    setLoadingMessageId(id);
    try { const value = await api<Message>(`mailboxes/${mailboxId}/messages/${id}${remoteImages ? '?remoteImages=true' : ''}`); setDetail(current => current ? { ...current, items: current.items.map(item => item.id === id ? { ...value, snippet: item.snippet } : item) } : current); setError(''); }
    catch (reason) { setError(errorText(reason)); }
    finally { setLoadingMessageId(''); }
  }
  async function loadEarlier() {
    if (!detail?.nextCursor) return;
    setLoadingEarlier(true);
    try {
      const page = await api<ThreadDetail>(`${path}?cursor=${encodeURIComponent(detail.nextCursor)}${remoteImages ? '&remoteImages=true' : ''}`);
      setDetail(current => current ? { items: [...page.items, ...current.items], nextCursor: page.nextCursor } : page);
      setError('');
    } catch (reason) { setError(errorText(reason)); }
    finally { setLoadingEarlier(false); }
  }
  function toggle(id: string, currentlyOpen: boolean, bodyLoaded: boolean) { setExpanded(current => { const latestId = detail?.items.at(-1)?.id; const next = new Set(current ?? (latestId ? [latestId] : [])); if (next.has(id)) next.delete(id); else next.add(id); return next; }); if (!currentlyOpen && !bodyLoaded) void loadMessage(id); }
  function changed(id: string, state: { isSeen: boolean; isFlagged: boolean }) {
    const current = detailRef.current;
    const previous = current?.items.find(item => item.id === id);
    if (!previous) return;
    if (!state.isSeen) setAutoReadAttempted(current => new Set(current).add(id));
    const updated = current!.items.map(item => item.id === id ? { ...item, ...state } : item);
    detailRef.current = { ...current!, items: updated };
    setDetail(detailRef.current);
    setAutoReadError('');
    const flags = conversationFlags(updated, !!current!.nextCursor);
    onChanged({ threadKey, wasSeen: previous.isSeen, isSeen: state.isSeen,
      unread: flags.unread, flagged: flags.flagged });
  }
  async function autoRead(id: string) {
    const result = await api<{ isSeen: boolean; isFlagged: boolean }>(`mailboxes/${mailboxId}/messages/${id}/read`, { method: 'POST' });
    changed(id, result);
  }
  function moved() { router.push(backHref); }
  const latest = detail?.items.at(-1);
  return <article className="webmail-reader" aria-label="Conversation reader"><div className="webmail-reader-head"><Link className="webmail-back" href={backHref}><ArrowLeft size={16}/>Back to {returnTo ? 'results' : folder.specialUse in names ? names[folder.specialUse as SpecialUse] : folder.name}</Link><span className="webmail-readonly">SERVER SYNCED</span></div>
    {loading ? <div className="webmail-list-skeleton" role="status" aria-label="Loading message">{Array.from({ length: 3 }, (_, index) => <div key={index}><i/><span><b/><em/></span></div>)}</div> : error && !detail ? <div className="webmail-empty"><AlertCircle size={28}/><h2>Unable to open conversation</h2><p>{error}</p><Link href={backHref} className="secondary-button">Back to list</Link></div> : detail?.items.length ? <><div className="webmail-thread-heading"><h2>{latest?.subject || '(No subject)'}</h2>{detail.items.length > 1 && <p>{detail.items.length}{detail.nextCursor ? '+' : ''} messages in this conversation</p>}</div>{error && <p className="form-error" role="alert">{error}</p>}{autoReadError && <p className="webmail-auto-read-error" role="alert"><AlertCircle size={14} aria-hidden="true"/>{autoReadError}</p>}{detail.nextCursor && <div className="webmail-load-more"><button className="secondary-button" onClick={() => void loadEarlier()} disabled={loadingEarlier}>{loadingEarlier ? 'Loading…' : 'Load earlier messages'}</button></div>}<div className="webmail-message-stack">{detail.items.map((message, index) => { const open = expanded ? expanded.has(message.id) : index === detail.items.length - 1; const sentAt = message.date ?? message.internalDate; return <section className={`webmail-message ${open ? 'open' : ''}`} key={message.id}><button className="webmail-message-toggle" type="button" aria-expanded={open} aria-controls={`webmail-body-${message.id}`} onClick={() => toggle(message.id, open, message.bodyLoaded)}><span className="webmail-avatar" aria-hidden="true">{sender(message).slice(0, 1).toUpperCase()}</span><span className="webmail-message-summary"><strong>{sender(message)}</strong><small>{message.fromEmail ?? 'Address unavailable'}{!open && message.snippet ? ` · ${message.snippet.slice(0, 65)}` : ''}</small></span><time dateTime={sentAt ?? undefined} title={sentAt ? displayDate(sentAt, true) : undefined}>{sentAt ? displayDate(sentAt) : 'Unknown date'}</time>{open ? <ChevronDown size={17}/> : <ChevronRight size={17}/>}</button>{open && <AutoReadOnView id={`webmail-body-${message.id}`} messageId={message.id} enabled={message.bodyLoaded && !message.isSeen && !respond && !autoReadAttempted.has(message.id)} onRead={() => autoRead(message.id)} onError={reason => setAutoReadError(reason instanceof TypeError ? 'Unable to update read status. Please try again.' : errorText(reason))}><div className="webmail-recipient-summary">to {message.recipients.filter(item => item.type === 'TO').map(item => item.name || item.email).join(', ') || 'undisclosed recipients'}</div><details className="webmail-headers"><summary>Show recipient details</summary><dl><dt>From</dt><dd>{message.fromName ? `${message.fromName} <${message.fromEmail ?? ''}>` : message.fromEmail ?? 'Unknown'}</dd>{(['TO', 'CC', 'BCC', 'REPLY_TO'] as const).map(type => { const items = message.recipients.filter(item => item.type === type); return items.length ? <div key={type}><dt>{type === 'REPLY_TO' ? 'Reply-To' : type}</dt><dd>{items.map(item => item.name ? `${item.name} <${item.email}>` : item.email).join(', ')}</dd></div> : null; })}<dt>Date</dt><dd>{sentAt ? displayDate(sentAt, true) : 'Unknown'}</dd></dl></details>
        <div className="webmail-response-actions"><button className="secondary-button" type="button" onClick={() => setRespond({ messageId: message.id, kind: 'REPLY' })}>Reply</button><button className="secondary-button" type="button" onClick={() => setRespond({ messageId: message.id, kind: 'REPLY_ALL' })}>Reply all</button><button className="secondary-button" type="button" onClick={() => setRespond({ messageId: message.id, kind: 'FORWARD' })}>Forward</button></div>
        <WebmailActions mailboxId={mailboxId} message={message} folders={folders} currentFolderId={folder.id} onChanged={state => changed(message.id, state)} onMoved={moved} onReadActionStart={() => setAutoReadAttempted(current => new Set(current).add(message.id))}/>
        {!message.bodyLoaded ? <div className="webmail-body-note" role="status">{loadingMessageId === message.id ? 'Loading message body…' : <button className="secondary-button" onClick={() => void loadMessage(message.id)}>Load message body</button>}</div> : message.htmlBody ? <><iframe className="webmail-html" title={`Email body from ${sender(message)}`} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={emailDocument(message.htmlBody, remoteImages)}/>{message.hasRemoteImages && !remoteImages && <div className="webmail-image-notice"><span>Images are hidden for privacy.</span><button className="webmail-image-button" type="button" onClick={() => void loadImages()} disabled={loadingImages}>{loadingImages ? 'Loading images…' : 'Load images'}</button></div>}</> : message.textBody ? <pre className="webmail-plain">{plainTextLines(message.textBody).map((line, lineIndex) => <span key={lineIndex} className={line.quoted ? 'quoted' : undefined}>{line.text}</span>)}</pre> : <p className="webmail-body-note">{message.contentStatus === 'SKIPPED_TOO_LARGE' ? 'Body omitted because this email exceeded the sync size limit.' : 'No readable body was synchronized.'}</p>}
        {message.attachments.length > 0 && <div className="webmail-attachments"><h3>Attachments <span>· {message.attachments.length}</span></h3>{message.attachments.map((attachment, attachmentIndex) => <div className="webmail-attachment" key={`${message.id}:${attachmentIndex}`}><span className="webmail-attachment-kind" aria-hidden="true">{attachment.filename?.split('.').at(-1)?.slice(0, 4).toUpperCase() || 'FILE'}</span><span><strong>{attachment.filename || 'Unnamed attachment'}</strong><small>{attachment.contentType} · {displaySize(attachment.sizeBytes)}{attachment.disposition === 'inline' ? ' · Inline' : ''}</small></span>{attachment.available && <a className="secondary-button" href={`/api/v1/mailboxes/${mailboxId}/messages/${message.id}/attachments/${attachment.id}`} aria-label={`Download ${attachment.filename || 'attachment'}`}>Download</a>}</div>)}{message.attachments.some(item => !item.available) && <p>Some attachments cannot be retrieved because their IMAP part or size is unavailable.</p>}</div>}
      </AutoReadOnView>}</section>; })}</div>{latest && <div className="webmail-thread-reply" aria-label="Conversation reply actions"><button className="secondary-button" type="button" onClick={() => setRespond({ messageId: latest.id, kind: 'REPLY' })}>Reply</button><button className="secondary-button" type="button" onClick={() => setRespond({ messageId: latest.id, kind: 'REPLY_ALL' })}>Reply all</button><button className="secondary-button" type="button" onClick={() => setRespond({ messageId: latest.id, kind: 'FORWARD' })}>Forward</button></div>}</> : <div className="webmail-empty"><Mail size={28}/><h2>Conversation unavailable</h2><p>These synchronized messages may have been removed during a later sync.</p><Link href={backHref} className="secondary-button">Back to list</Link></div>}
    {respond && <WebmailResponse key={`${respond.messageId}:${respond.kind}`} mailboxId={mailboxId} sourceMessageId={respond.messageId} kind={respond.kind} onClose={() => setRespond(null)}/>}
  </article>;
}

function AutoReadOnView({ id, messageId, enabled, onRead, onError, children }: {
  id: string; messageId: string; enabled: boolean; onRead: () => Promise<void>; onError: (error: unknown) => void; children: React.ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onRead, onError });
  useEffect(() => { callbacks.current = { onRead, onError }; }, [onRead, onError]);
  useEffect(() => {
    if (!enabled || !element.current) return;
    const target = element.current.querySelector<HTMLElement>('.webmail-html, .webmail-plain, .webmail-body-note') ?? element.current;
    const gate = createAutoReadGate(() => callbacks.current.onRead(), error => callbacks.current.onError(error));
    gate.setReady(true);
    function visibleNow() {
      const bounds = target.getBoundingClientRect();
      const reader = target.closest('.webmail-reader')?.getBoundingClientRect();
      return !!bounds && !!reader && Math.min(bounds.right, reader.right, window.innerWidth) > Math.max(bounds.left, reader.left, 0)
        && Math.min(bounds.bottom, reader.bottom, window.innerHeight) - Math.max(bounds.top, reader.top, 0) >= Math.min(48, bounds.height);
    }
    const observer = new IntersectionObserver(() => gate.setVisible(document.visibilityState === 'visible' && visibleNow()), { threshold: [0, 0.01, 0.1] });
    observer.observe(target);
    const visibilityChanged = () => gate.setVisible(document.visibilityState === 'visible' && visibleNow());
    const navigationIntent = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (anchor && anchor.origin === window.location.origin && anchor.href !== window.location.href && !anchor.pathname.startsWith('/api/v1/')) gate.dispose();
    };
    const backIntent = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as Element | null)?.closest?.('input,textarea,select,[role=dialog]') && !document.querySelector('.webmail-reader .webmail-more-actions[open]')) gate.dispose(); };
    const leave = () => gate.dispose();
    document.addEventListener('visibilitychange', visibilityChanged);
    document.addEventListener('click', navigationIntent, true);
    document.addEventListener('keydown', backIntent, true);
    window.addEventListener('popstate', leave);
    window.addEventListener('pagehide', leave);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', visibilityChanged); document.removeEventListener('click', navigationIntent, true); document.removeEventListener('keydown', backIntent, true); window.removeEventListener('popstate', leave); window.removeEventListener('pagehide', leave); gate.dispose(); };
  }, [enabled, messageId]);
  return <div className="webmail-message-content" id={id} ref={element}>{children}</div>;
}

function emailDocument(body: string, remoteImages: boolean): string {
  const images = remoteImages ? "'self' https: http:" : "'self'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>html{font:14px/1.7 Arial,sans-serif;color:#263345}body{margin:0;padding:20px 24px;overflow-wrap:anywhere}p{margin:.7em 0 1em}h1,h2,h3{line-height:1.35}blockquote{color:#64748b;border-left:2px solid #e2e8f0;margin:1em 0;padding-left:1em}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{max-width:100%}img{max-width:100%;height:auto}a{color:#2563eb}@media(max-width:600px){body{padding:16px}}</style></head><body>${body}</body></html>`;
}
