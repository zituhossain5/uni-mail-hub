'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Inbox, MailSearch, Paperclip, RefreshCw, Search, SlidersHorizontal, Star, X } from 'lucide-react';

type View = 'unified' | 'search' | 'unread' | 'flagged' | 'attachments';
type Mailbox = { id: string; email: string; projectId: string; project: { name: string } };
type Row = { id: string; mailboxId: string; folderId: string; threadKey: string; subject: string | null;
  fromName: string | null; fromEmail: string | null; at: string; messageCount: number; unread: boolean;
  flagged: boolean; attachment: boolean; snippet: string; matchSnippet: string; matchedOlderMessage: boolean;
  matchSubject: string | null; matchFromName: string | null; matchFromEmail: string | null;
  mailboxEmail: string; projectId: string; projectName: string; folderName: string; folderSpecialUse: string };
type Page = { items: Row[]; nextCursor: string | null };

const viewNames: Record<View, string> = { unified: 'Unified Inbox', search: 'Mail search', unread: 'Unread', flagged: 'Flagged', attachments: 'Attachments' };
const visibleFilters = ['q', 'mailboxIds', 'projectIds', 'folder', 'from', 'to', 'after', 'before', 'unread', 'flagged', 'hasAttachment'] as const;
const folders = ['INBOX', 'SENT', 'DRAFTS', 'TRASH', 'JUNK', 'ARCHIVE', 'OTHER', 'ALL'];

function queryFor(view: View, current: URLSearchParams): URLSearchParams {
  const query = new URLSearchParams();
  for (const key of visibleFilters) { const value = current.get(key); if (value) query.set(key, value); }
  if (view === 'unread') query.set('unread', 'true');
  if (view === 'flagged') query.set('flagged', 'true');
  if (view === 'attachments') query.set('hasAttachment', 'true');
  if (view !== 'search' && !query.has('folder')) query.set('folder', 'INBOX');
  return query;
}

async function loadPage(queryString: string, cursor?: string): Promise<Page> {
  const search = new URLSearchParams(queryString);
  if (cursor) search.set('cursor', cursor);
  const response = await fetch(`/api/v1/mail/search?${search}`, { cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? 'Could not load synchronized mail.');
  return value as Page;
}

function resultHref(row: Row, returnTo: string): string {
  return `/mailboxes/${row.mailboxId}/folders/${row.folderId}/threads/${encodeURIComponent(row.threadKey)}?returnTo=${encodeURIComponent(returnTo)}`;
}

export function MailExplorer({ view }: { view: View }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const current = new URLSearchParams(queryString);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mailboxError, setMailboxError] = useState('');
  const [items, setItems] = useState<Row[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draft, setDraft] = useState(current.get('q') ?? '');
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const effective = queryFor(view, current);
  const effectiveString = effective.toString();
  const projects = [...new Map(mailboxes.map(item => [item.projectId, { id: item.projectId, name: item.project.name }])).values()];
  const selectedMailboxes = new Set((current.get('mailboxIds') ?? '').split(',').filter(Boolean));
  const selectedProjects = new Set((current.get('projectIds') ?? '').split(',').filter(Boolean));

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/v1/webmail/mailboxes', { cache: 'no-store' }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.message ?? 'Could not load mailbox choices.');
      return value as Mailbox[];
    }).then(value => { if (!cancelled) { setMailboxes(value); setMailboxError(''); } })
      .catch(reason => { if (!cancelled) setMailboxError(reason instanceof Error ? reason.message : 'Could not load mailbox choices.'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => { setLoading(true); setError(''); setItems([]); setSelected(-1); setNextCursor(null); })
      .then(() => loadPage(effectiveString)).then(page => { if (!cancelled) { setItems(page.items); setNextCursor(page.nextCursor); } })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load mail.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [effectiveString, reload]);

  function update(next: URLSearchParams) {
    next.delete('cursor');
    setDraft(next.get('q') ?? '');
    router.push(`${pathname}${next.size ? `?${next}` : ''}`);
  }
  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(queryString);
    if ((next.get(key) ?? '') === value) return;
    if (value) next.set(key, value); else next.delete(key);
    update(next);
  }
  function toggleSelection(key: 'mailboxIds' | 'projectIds', id: string) {
    const values = new Set((current.get(key) ?? '').split(',').filter(Boolean));
    if (values.has(id)) values.delete(id); else values.add(id);
    const next = new URLSearchParams(queryString);
    if (values.size) next.set(key, [...values].sort().join(',')); else next.delete(key);
    if (key === 'projectIds' && values.size) {
      const visible = [...selectedMailboxes].filter(boxId => mailboxes.some(box => box.id === boxId && values.has(box.projectId)));
      if (visible.length) next.set('mailboxIds', visible.sort().join(',')); else next.delete('mailboxIds');
    }
    update(next);
  }
  async function more() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await loadPage(effectiveString, nextCursor);
      setItems(previous => [...previous, ...page.items.filter(item => !previous.some(old => old.mailboxId === item.mailboxId && old.folderId === item.folderId && old.threadKey === item.threadKey))]);
      setNextCursor(page.nextCursor); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load more mail.'); }
    finally { setLoadingMore(false); }
  }
  const returnTo = `${pathname}${queryString ? `?${queryString}` : ''}`;
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
      if (event.key === '/' && !editing) { event.preventDefault(); inputRef.current?.focus(); return; }
      if (editing || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); setSelected(index => Math.min(index + 1, items.length - 1)); }
      if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); setSelected(index => Math.max(index - 1, 0)); }
      if ((event.key === 'Enter' || event.key === 'o') && selected >= 0 && items[selected]) {
        event.preventDefault(); router.push(resultHref(items[selected], returnTo));
      }
    }
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [items, selected, router, returnTo]);
  useEffect(() => { if (selected >= 0) rowRefs.current[selected]?.focus(); }, [selected]);

  const chips = visibleFilters.filter(key => current.get(key) && !(key === 'folder' && current.get(key) === 'INBOX'));
  return <div className="webmail mail-explorer">
    <div className="webmail-heading"><div><div className="eyebrow">WEBMAIL · SYNCHRONIZED MAIL</div><h1>{viewNames[view]}</h1><p>Conversations across allowed mailboxes, with each mailbox identity kept separate.</p></div></div>
    <div className="mail-explorer-toolbar"><form role="search" onSubmit={event => { event.preventDefault(); setFilter('q', draft.trim()); }}><Search size={17} aria-hidden="true"/><input ref={inputRef} aria-label="Search mail" placeholder="Search subject, people, body or Message-ID" value={draft} onChange={event => setDraft(event.target.value)}/><button className="primary-button" type="submit">Search</button></form><button className="secondary-button" type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal size={16}/> Filters</button><button className="icon-button" aria-label="Refresh results" onClick={() => setReload(value => value + 1)}><RefreshCw size={16}/></button></div>
    {filtersOpen && <div className="mail-explorer-filters">
      <fieldset><legend>Projects</legend><label><input type="radio" name="projectScope" checked={!selectedProjects.size} onChange={() => setFilter('projectIds', '')}/> All allowed projects</label>{projects.map(project => <label key={project.id}><input type="checkbox" checked={selectedProjects.has(project.id)} onChange={() => toggleSelection('projectIds', project.id)}/>{project.name}</label>)}</fieldset>
      <fieldset><legend>Mailboxes</legend><label><input type="radio" name="mailboxScope" checked={!selectedMailboxes.size} onChange={() => setFilter('mailboxIds', '')}/> All allowed mailboxes</label>{mailboxes.filter(item => !selectedProjects.size || selectedProjects.has(item.projectId)).map(item => <label key={item.id}><input type="checkbox" checked={selectedMailboxes.has(item.id)} onChange={() => toggleSelection('mailboxIds', item.id)}/>{item.email}</label>)}</fieldset>
      <div className="mail-explorer-fields"><label>Folder<select value={current.get('folder') ?? 'INBOX'} onChange={event => setFilter('folder', event.target.value)}>{folders.map(item => <option key={item} value={item}>{item === 'ALL' ? 'All folders' : item}</option>)}</select></label>
        <label>From email<input key={`from:${current.get('from') ?? ''}`} type="email" defaultValue={current.get('from') ?? ''} onBlur={event => setFilter('from', event.target.value.trim())} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/></label>
        <label>To email<input key={`to:${current.get('to') ?? ''}`} type="email" defaultValue={current.get('to') ?? ''} onBlur={event => setFilter('to', event.target.value.trim())} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/></label>
        <label>After<input type="date" value={current.get('after')?.slice(0, 10) ?? ''} onChange={event => setFilter('after', event.target.value)}/></label><label>Before<input type="date" value={current.get('before')?.slice(0, 10) ?? ''} onChange={event => setFilter('before', event.target.value)}/></label>
        <label><input type="checkbox" checked={effective.get('unread') === 'true'} onChange={event => setFilter('unread', event.target.checked ? 'true' : '')} disabled={view === 'unread'}/> Unread</label><label><input type="checkbox" checked={effective.get('flagged') === 'true'} onChange={event => setFilter('flagged', event.target.checked ? 'true' : '')} disabled={view === 'flagged'}/> Flagged</label><label><input type="checkbox" checked={effective.get('hasAttachment') === 'true'} onChange={event => setFilter('hasAttachment', event.target.checked ? 'true' : '')} disabled={view === 'attachments'}/> Has attachment</label>
      </div>
    </div>}
    {chips.length > 0 && <div className="mail-explorer-chips" aria-label="Active filters">{chips.map(key => <button key={key} type="button" onClick={() => setFilter(key, '')}>{key === 'q' ? `Search: ${current.get(key)}` : `${key}: ${key.endsWith('Ids') ? current.get(key)?.split(',').length : current.get(key)}`} <X size={12}/></button>)}<button type="button" onClick={() => update(new URLSearchParams())}>Clear filters</button></div>}
    {mailboxError && <div className="webmail-notice error" role="alert"><AlertCircle size={16}/>{mailboxError}</div>}
    <div className="mail-explorer-results"><div className="webmail-list-head"><div><h2>{viewNames[view]}</h2><p>{loading ? 'Loading conversations…' : `${items.length}${nextCursor ? '+' : ''} conversations shown`}</p></div><span className="mail-explorer-hint">↑ ↓ or j k · Enter/open · / search</span></div>
      {loading ? <div className="webmail-list-skeleton" role="status" aria-label="Loading conversations">{Array.from({ length: 6 }, (_, i) => <div key={i}><i/><span><b/><em/></span></div>)}</div> : error && !items.length ? <div className="webmail-empty" role="alert"><AlertCircle size={28}/><h3>Search unavailable</h3><p>{error}</p><button className="secondary-button" onClick={() => setReload(value => value + 1)}>Try again</button></div> : !items.length ? <div className="webmail-empty"><MailSearch size={30}/><h3>No matching conversations</h3><p>Try a different search or clear some filters. Only synchronized mail can appear here.</p></div> : <><div className="webmail-rows">{items.map((item, index) => <Link key={`${item.mailboxId}:${item.folderId}:${item.threadKey}`} ref={element => { rowRefs.current[index] = element; }} href={resultHref(item, returnTo)} onFocus={() => setSelected(index)} className={`webmail-row mail-explorer-row ${item.unread ? 'unread' : ''} ${selected === index ? 'selected' : ''}`} aria-label={`${item.unread ? 'Unread, ' : ''}${item.fromName || item.fromEmail || 'Unknown sender'}, ${item.subject || 'No subject'}, ${item.mailboxEmail}, ${item.messageCount} messages`}><span className="webmail-avatar" aria-hidden="true">{(item.fromName || item.fromEmail || '?').slice(0, 1).toUpperCase()}</span><span className="webmail-row-main"><span className="webmail-row-top"><strong>{item.fromName || item.fromEmail || 'Unknown sender'}</strong><time dateTime={item.at}>{new Date(item.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></span><span className="webmail-row-subject">{item.subject || '(No subject)'}{item.messageCount > 1 && <small> {item.messageCount}</small>}</span><span className="webmail-row-bottom"><span>{item.matchedOlderMessage ? `Matched older message: ${item.matchSnippet}` : item.snippet || 'No preview available'}</span>{item.attachment && <Paperclip size={13} aria-label="Has attachment"/>}{item.flagged && <Star size={13} fill="currentColor" aria-label="Flagged"/>}</span><span className="mail-explorer-identity">{item.projectName} / {item.mailboxEmail} · {item.folderName}</span></span>{item.unread && <span className="webmail-unread-dot" aria-hidden="true"/>}<ArrowRight className="mail-explorer-open" size={15} aria-hidden="true"/></Link>)}</div>{error && <p className="form-error" role="alert">{error}</p>}{nextCursor && <div className="webmail-load-more"><button className="secondary-button" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? 'Loading…' : 'Load more conversations'}</button></div>}</>}
    </div><p className="mail-explorer-note"><Inbox size={14}/> Results reflect the most recent synchronization. Opening a message does not mark it read.</p>
  </div>;
}
