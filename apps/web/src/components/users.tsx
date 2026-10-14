'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { UserPlus, Search } from 'lucide-react';
import { Dialog } from './dialog';
import { DateTime, EmptyState, PageHeader, StatusBadge } from './ui';
import './users.css';

type Role = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF' | 'VIEWER';
type UserRow = { id: string; name: string; email: string; role: Role; isActive: boolean; createdAt: string; lastLoginAt: string | null; projectMemberships: { project: { id: string; name: string } }[]; mailboxGrants: { mailbox: { id: string; email: string; projectId: string } }[]; invitations: { id: string; expiresAt: string; revokedAt: string | null }[] };
type Detail = UserRow & { sessions: { id: string; createdAt: string; lastUsedAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null }[]; activity: { id: string; action: string; createdAt: string; userId: string | null }[] };
type Project = { id: string; name: string };
type Mailbox = { id: string; email: string; projectId: string };
type Page = { items: UserRow[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? 'Request failed');
  return data as T;
}
function userStatus(user: UserRow) { return user.isActive ? 'ACTIVE' : user.invitations.some(invite => !invite.revokedAt && new Date(invite.expiresAt) > new Date()) ? 'PENDING' : 'DISABLED'; }

export function Users() {
  const [actor, setActor] = useState<Role>('VIEWER');
  const [data, setData] = useState<Page | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');
  const load = useCallback(async () => {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search) query.set('search', search);
    if (role) query.set('role', role);
    if (status) query.set('status', status);
    try {
      const result = await api<Page>(`users?${query}`);
      if (result.pagination.totalPages && page > result.pagination.totalPages) { setPage(result.pagination.totalPages); return; }
      setData(result); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load users'); }
  }, [page, pageSize, search, role, status]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => { void Promise.all([api<{ role: Role }>('auth/me'), api<Project[]>('projects'), api<Mailbox[]>('mailboxes')]).then(([user, p, m]) => { setActor(user.role); setProjects(p); setMailboxes(m); }).catch(() => setError('Could not load access options')); }, []);
  function reset(setter: (value: string) => void, value: string) { setter(value); setPage(1); }
  return <><PageHeader eyebrow="ACCESS CONTROL" title="Users" description="Manage access to Uni Mail Hub" actions={<button className="primary-button" onClick={() => { setInviteUrl(''); setOpen(true); }}><UserPlus size={17} aria-hidden="true"/>Add user</button>}/>
    <section className="panel users-panel"><div className="users-toolbar"><label className="table-search"><Search size={16} aria-hidden="true"/><input aria-label="Search users" value={search} onChange={event => reset(setSearch, event.target.value)} placeholder="Search name or email"/></label><select aria-label="Filter by role" value={role} onChange={event => reset(setRole, event.target.value)}><option value="">All roles</option>{(actor === 'SUPER_ADMIN' ? ['SUPER_ADMIN','ADMIN','MANAGER','STAFF','VIEWER'] : ['MANAGER','STAFF','VIEWER'] as Role[]).map(value => <option key={value}>{value}</option>)}</select><select aria-label="Filter by status" value={status} onChange={event => reset(setStatus, event.target.value)}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="PENDING">Pending invite</option><option value="DISABLED">Disabled</option></select></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {data?.items.length ? <div className="table-scroll"><table className="users-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Projects</th><th>Mailbox access</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>{data.items.map(user => <tr key={user.id}><td><strong>{user.name}</strong></td><td>{user.email}</td><td>{user.role.replace('_', ' ')}</td><td>{user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' ? 'All' : user.projectMemberships.length}</td><td>{user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' ? 'All' : user.role === 'MANAGER' ? 'Assigned projects' : user.mailboxGrants.length}</td><td><StatusBadge status={userStatus(user)}/></td><td><DateTime value={user.lastLoginAt}/></td><td><Link href={`/users/${user.id}`}>View</Link></td></tr>)}</tbody></table></div> : data ? <EmptyState title="No users match your filters" description="Try another search or filter."/> : <p role="status">Loading users…</p>}
      {data && <div className="users-pagination"><span>Showing {data.pagination.totalItems ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, data.pagination.totalItems)} of {data.pagination.totalItems}</span><label>Rows per page <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>{[10,20,50,100].map(size => <option key={size}>{size}</option>)}</select></label><button className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">Previous</button><span aria-current="page">{page} / {Math.max(data.pagination.totalPages, 1)}</span><button className="secondary-button" disabled={page >= data.pagination.totalPages} onClick={() => setPage(page + 1)} aria-label="Next page">Next</button></div>}
    </section>
    <UserEditor key={open ? 'create-open' : 'create-closed'} open={open} actor={actor} projects={projects} mailboxes={mailboxes} onClose={() => setOpen(false)} onSaved={async url => { setInviteUrl(url ?? ''); setOpen(false); await load(); }}/>
    <Dialog open={!!inviteUrl} title="Invitation ready" description="Copy this link once and share it securely. It expires in 48 hours." onClose={() => setInviteUrl('')} footer={<button className="primary-button" onClick={() => { void navigator.clipboard.writeText(inviteUrl); }}>Copy invitation link</button>}><p className="users-invite-link">{inviteUrl}</p></Dialog>
  </>;
}

export function UserEditor({ open, actor, projects, mailboxes, user, onClose, onSaved }: { open: boolean; actor: Role; projects: Project[]; mailboxes: Mailbox[]; user?: UserRow; onClose: () => void; onSaved: (url?: string) => void }) {
  const [name, setName] = useState(user?.name ?? ''); const [email, setEmail] = useState(user?.email ?? ''); const [role, setRole] = useState<Role>(user?.role ?? 'STAFF');
  const [projectIds, setProjectIds] = useState<string[]>(user?.projectMemberships.map(value => value.project.id) ?? []);
  const [mailboxIds, setMailboxIds] = useState<string[]>(user?.mailboxGrants.map(value => value.mailbox.id) ?? []);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  function toggle(value: string, current: string[], setter: (value: string[]) => void) { setter(current.includes(value) ? current.filter(item => item !== value) : [...current, value]); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const data = { name, email, role, projectIds: ['MANAGER','STAFF','VIEWER'].includes(role) ? projectIds : [], mailboxIds: role === 'STAFF' || role === 'VIEWER' ? mailboxIds.filter(mailboxId => mailboxes.some(box => box.id === mailboxId && projectIds.includes(box.projectId))) : [] };
      const result = await api<{ invitation?: { url: string } }>(user ? `users/${user.id}` : 'users', { method: user ? 'PATCH' : 'POST', body: JSON.stringify(data) });
      onSaved(result.invitation?.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save user'); } finally { setBusy(false); }
  }
  const roles: Role[] = actor === 'SUPER_ADMIN' ? ['ADMIN','MANAGER','STAFF','VIEWER'] : ['MANAGER','STAFF','VIEWER'];
  return <Dialog open={open} title={user ? 'Edit user' : 'Add user'} description="Assign only the projects and mailboxes this person needs." onClose={onClose} size="wide" footer={<><button className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" type="submit" form="user-editor" disabled={busy}>{busy ? 'Saving…' : user ? 'Save changes' : 'Create & Invite'}</button></>}><form id="user-editor" onSubmit={event => void submit(event)} className="users-form"><label>Name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label><label>Email<input required type="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)}/></label><label>Role<select value={role} onChange={event => { setRole(event.target.value as Role); setProjectIds([]); setMailboxIds([]); }} disabled={user?.role === 'SUPER_ADMIN'}>{user?.role === 'SUPER_ADMIN' && <option value="SUPER_ADMIN">SUPER ADMIN</option>}{roles.map(value => <option key={value}>{value}</option>)}</select></label>
    {['MANAGER','STAFF','VIEWER'].includes(role) && <fieldset><legend>Assigned projects</legend><div className="users-checks">{projects.map(project => <label key={project.id}><input type="checkbox" checked={projectIds.includes(project.id)} onChange={() => toggle(project.id, projectIds, setProjectIds)}/>{project.name}</label>)}</div></fieldset>}
    {(role === 'STAFF' || role === 'VIEWER') && <fieldset><legend>Mailbox access</legend><p>Access is limited to checked mailboxes inside assigned projects.</p><div className="users-checks">{mailboxes.filter(box => projectIds.includes(box.projectId)).map(box => <label key={box.id}><input type="checkbox" checked={mailboxIds.includes(box.id)} onChange={() => toggle(box.id, mailboxIds, setMailboxIds)}/>{box.email}</label>)}</div></fieldset>}
    {error && <p className="form-error" role="alert">{error}</p>}</form></Dialog>;
}

export function UserDetail({ id, actor }: { id: string; actor: Role }) {
  const [user, setUser] = useState<Detail | null>(null); const [projects, setProjects] = useState<Project[]>([]); const [mailboxes, setMailboxes] = useState<Mailbox[]>([]); const [error, setError] = useState(''); const [editing, setEditing] = useState(false); const [inviteUrl, setInviteUrl] = useState('');
  const load = useCallback(async () => { try { setUser(await api<Detail>(`users/${id}`)); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load user'); } }, [id]);
  useEffect(() => { void Promise.resolve().then(load); void Promise.all([api<Project[]>('projects'), api<Mailbox[]>('mailboxes')]).then(([p,m]) => { setProjects(p); setMailboxes(m); }).catch(() => undefined); }, [load]);
  async function action(path: string) { try { await api(`users/${id}/${path}`, { method: 'POST' }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Action failed'); } }
  async function reinvite() { try { const result = await api<{ invitation: { url: string } }>(`users/${id}/reinvite`, { method: 'POST' }); setInviteUrl(result.invitation.url); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not renew invitation'); } }
  if (!user) return <p role="status">{error || 'Loading user…'}</p>;
  return <><PageHeader eyebrow="ACCESS CONTROL" title={user.name} description={user.email} actions={<Link className="secondary-button" href="/users">Back to users</Link>}/>{error && <p className="form-error" role="alert">{error}</p>}
    <div className="users-detail"><section className="panel"><h2>Profile</h2><dl><dt>Role</dt><dd>{user.role.replace('_',' ')}</dd><dt>Status</dt><dd><StatusBadge status={userStatus(user)}/></dd><dt>Created</dt><dd><DateTime value={user.createdAt}/></dd><dt>Last login</dt><dd><DateTime value={user.lastLoginAt}/></dd></dl><div className="users-actions"><button className="secondary-button" onClick={() => setEditing(true)}>Edit access</button><button className="secondary-button" onClick={() => void action('revoke-sessions')}>Revoke all sessions</button>{user.invitations.length > 0 && <button className="secondary-button" onClick={() => void reinvite()}>Renew invitation</button>}{user.role !== 'SUPER_ADMIN' && <button className="secondary-button" onClick={() => void action(user.isActive ? 'disable' : 'enable')} disabled={!user.isActive && !!user.invitations.length}>{user.isActive ? 'Disable user' : 'Enable user'}</button>}</div></section>
    <section className="panel"><h2>Access</h2><p><strong>Projects:</strong> {user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' ? 'All' : user.projectMemberships.map(row => row.project.name).join(', ') || 'None'}</p><p><strong>Mailboxes:</strong> {user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' ? 'All' : user.role === 'MANAGER' ? 'All in assigned projects' : user.mailboxGrants.map(row => row.mailbox.email).join(', ') || 'None'}</p></section>
    <section className="panel"><h2>Security</h2><p><strong>Sign-in:</strong> Password authentication</p><p>Use the Sessions section to revoke active sessions.</p></section>
    <section className="panel"><h2>Sessions</h2>{user.sessions.length ? <ul>{user.sessions.map(session => <li key={session.id}>{session.userAgent || 'Unknown device'} · last used <DateTime value={session.lastUsedAt}/> · {session.ipAddress || 'Unknown address'}</li>)}</ul> : <p>No active sessions.</p>}</section>
    <section className="panel"><h2>Activity</h2>{user.activity.length ? <ul>{user.activity.map(entry => <li key={entry.id}>{entry.action.replaceAll('_',' ')} · <DateTime value={entry.createdAt}/></li>)}</ul> : <p>No recent activity.</p>}</section></div>
    <UserEditor key={editing ? 'edit-open' : 'edit-closed'} open={editing} actor={actor} projects={projects} mailboxes={mailboxes} user={user} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); }}/>
    <Dialog open={!!inviteUrl} title="Invitation renewed" description="The old link has been revoked. Share this new link securely within 48 hours." onClose={() => setInviteUrl('')} footer={<button className="primary-button" onClick={() => { void navigator.clipboard.writeText(inviteUrl); }}>Copy invitation link</button>}><p className="users-invite-link">{inviteUrl}</p></Dialog>
  </>;
}
