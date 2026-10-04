'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CirclePlus, FolderKanban, Globe2, Mail, Pencil, Search, Trash2, X } from 'lucide-react';

type Project = { id: string; name: string; slug: string; description: string | null; status: string; _count?: { domains: number; mailboxes: number } };
type Domain = { id: string; projectId: string; domain: string; status: string; project?: { name: string }; _count?: { mailboxes: number } };
type Mailbox = { id: string; projectId: string; domainId: string; email: string; displayName: string | null; status: string; isActive: boolean; project?: { name: string }; domain?: { domain: string } };
type Entity = Project | Domain | Mailbox;
type Kind = 'projects' | 'domains' | 'mailboxes';

const config = {
  projects: { title: 'Projects', singular: 'project', description: 'Organize your mail operations by product or business.', icon: FolderKanban, empty: 'No projects yet', emptyText: 'Create a project to group domains, mailboxes, and future API access.' },
  domains: { title: 'Domains', singular: 'domain', description: 'Manage the domains connected to your projects.', icon: Globe2, empty: 'No domains registered', emptyText: 'Add a domain to a project to prepare mailbox registration.' },
  mailboxes: { title: 'Mailboxes', singular: 'mailbox', description: 'Keep a central registry of the mailboxes you manage.', icon: Mail, empty: 'No mailboxes registered', emptyText: 'Register a mailbox after adding its project and domain.' },
} as const;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? 'Request failed');
  return data as T;
}

function Badge({ status }: { status: string }) { return <span className={`badge badge-${status.toLowerCase()}`}>{status.toLowerCase().replace('_', ' ')}</span>; }
function entityName(kind: Kind, item: Entity) { return kind === 'projects' ? (item as Project).name : kind === 'domains' ? (item as Domain).domain : (item as Mailbox).email; }

export function Registry({ kind }: { kind: Kind }) {
  const meta = config[kind];
  const [items, setItems] = useState<Entity[]>([]); const [projects, setProjects] = useState<Project[]>([]); const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Entity | null>(null); const [modal, setModal] = useState(false); const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const [records, projectRecords, domainRecords] = await Promise.all([request<Entity[]>(kind), kind === 'projects' ? Promise.resolve([]) : request<Project[]>('projects'), kind === 'mailboxes' ? request<Domain[]>('domains') : Promise.resolve([])]);
      setItems(records); setProjects(projectRecords); setDomains(domainRecords); setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load records'); }
    finally { setLoading(false); }
  }, [kind]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const filtered = items.filter((item) => entityName(kind, item).toLowerCase().includes(search.toLowerCase()));
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const body: Record<string, unknown> = { ...values };
    if (kind === 'mailboxes') body.isActive = values.isActive === 'true';
    if (kind === 'projects' && !values.description) body.description = null;
    if (kind === 'mailboxes' && !values.displayName) body.displayName = null;
    try {
      await request(`${kind}${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setModal(false); setEditing(null); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to save'); }
    finally { setSaving(false); }
  }
  async function remove(item: Entity) {
    if (!window.confirm(`Delete ${entityName(kind, item)}? This cannot be undone.`)) return;
    try { await request(`${kind}/${item.id}`, { method: 'DELETE' }); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to delete'); }
  }
  const selectedProject = editing && 'projectId' in editing ? editing.projectId : undefined;
  return <><div className="page-heading"><div><div className="eyebrow">REGISTRY</div><h1>{meta.title}</h1><p>{meta.description}</p></div><button className="primary-button" onClick={() => { setEditing(null); setError(''); setModal(true); }}><CirclePlus size={18}/> Add {meta.singular}</button></div>
    <div className="registry-panel"><div className="registry-toolbar"><div><h2>All {kind}</h2><p>{items.length} {items.length === 1 ? meta.singular : kind} in your workspace</p></div><label className="table-search"><Search size={17}/><input placeholder={`Search ${kind}`} value={search} onChange={(event) => setSearch(event.target.value)}/></label></div>
      {error && !modal && <p className="form-error list-error" role="alert">{error}</p>}
      {loading ? <div className="loading-state">Loading {kind}…</div> : filtered.length === 0 ? <div className="registry-empty"><div className="empty-icon large"><meta.icon size={27}/></div><h3>{search ? 'No matching results' : meta.empty}</h3><p>{search ? 'Try a different search term.' : meta.emptyText}</p>{!search && <button className="secondary-button" onClick={() => setModal(true)}>Add your first {meta.singular} <ArrowRight size={15}/></button>}</div> : <div className="table-scroll"><table><thead><tr><th>{kind === 'projects' ? 'PROJECT' : kind === 'domains' ? 'DOMAIN' : 'MAILBOX'}</th><th>{kind === 'projects' ? 'SLUG' : 'PROJECT'}</th><th>{kind === 'projects' ? 'DOMAINS' : kind === 'domains' ? 'MAILBOXES' : 'DOMAIN'}</th><th>STATUS</th><th>UPDATED</th><th className="actions-column">ACTIONS</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td><div className="record-main"><span className="record-icon"><meta.icon size={17}/></span><div>{kind === 'projects' ? <Link href={`/projects/${item.id}`}>{entityName(kind,item)}</Link> : <strong>{entityName(kind,item)}</strong>}{kind === 'projects' && <small>{(item as Project).description || 'No description'}</small>}{kind === 'mailboxes' && <small>{(item as Mailbox).displayName || 'No display name'}</small>}</div></div></td><td>{kind === 'projects' ? (item as Project).slug : (item as Domain | Mailbox).project?.name}</td><td>{kind === 'projects' ? (item as Project)._count?.domains : kind === 'domains' ? (item as Domain)._count?.mailboxes : (item as Mailbox).domain?.domain}</td><td><Badge status={item.status}/></td><td>{'updatedAt' in item && typeof item.updatedAt === 'string' ? new Date(item.updatedAt).toLocaleDateString() : '—'}</td><td className="row-actions"><button aria-label={`Edit ${entityName(kind,item)}`} onClick={() => { setEditing(item); setError(''); setModal(true); }}><Pencil size={16}/></button><button aria-label={`Delete ${entityName(kind,item)}`} onClick={() => void remove(item)}><Trash2 size={16}/></button></td></tr>)}</tbody></table></div>}
    </div>
    {modal && <div className="modal-backdrop" role="presentation" onMouseDown={() => { setModal(false); setError(''); }}><div className="modal" role="dialog" aria-modal="true" aria-label={`${editing ? 'Edit' : 'Add'} ${meta.singular}`} onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">{editing ? 'UPDATE RECORD' : 'NEW RECORD'}</p><h2>{editing ? 'Edit' : 'Add'} {meta.singular}</h2></div><button className="icon-button" onClick={() => { setModal(false); setError(''); }} aria-label="Close"><X size={19}/></button></div><form onSubmit={save} className="entity-form">
      {kind === 'projects' && <><label>Project name<input name="name" defaultValue={(editing as Project | null)?.name ?? ''} placeholder="e.g. UnicodeIT" required maxLength={120}/></label><label>Slug<input name="slug" defaultValue={(editing as Project | null)?.slug ?? ''} placeholder="e.g. unicodeit" pattern="[a-z0-9]+(-[a-z0-9]+)*" required/></label><label>Description<textarea name="description" defaultValue={(editing as Project | null)?.description ?? ''} placeholder="What is this project for?" rows={3}/></label><label>Status<select name="status" defaultValue={(editing as Project | null)?.status ?? 'ACTIVE'}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label></>}
      {kind === 'domains' && <><label>Project<select name="projectId" defaultValue={selectedProject ?? ''} required><option value="" disabled>Select a project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Domain<input name="domain" defaultValue={(editing as Domain | null)?.domain ?? ''} placeholder="example.com" required/></label><label>Status<select name="status" defaultValue={(editing as Domain | null)?.status ?? 'UNVERIFIED'}><option value="UNVERIFIED">Unverified</option><option value="DISABLED">Disabled</option></select><small>Verification and issue states require future DNS checks.</small></label></>}
      {kind === 'mailboxes' && <MailboxFields projects={projects} domains={domains} editing={editing as Mailbox | null}/>}
      {error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => { setModal(false); setError(''); }}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : `Add ${meta.singular}`}</button></div></form></div></div>}
  </>;
}

function MailboxFields({ projects, domains, editing }: { projects: Project[]; domains: Domain[]; editing: Mailbox | null }) {
  const [projectId, setProjectId] = useState(editing?.projectId ?? '');
  return <><label>Project<select name="projectId" value={projectId} onChange={(event) => setProjectId(event.target.value)} required><option value="" disabled>Select a project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Domain<select name="domainId" defaultValue={editing?.domainId ?? ''} required><option value="" disabled>Select a domain</option>{domains.filter((domain) => domain.projectId === projectId).map((domain) => <option key={domain.id} value={domain.id}>{domain.domain}</option>)}</select></label><label>Email address<input name="email" type="email" defaultValue={editing?.email ?? ''} placeholder="contact@example.com" required/></label><label>Display name<input name="displayName" defaultValue={editing?.displayName ?? ''} placeholder="Contact"/></label><div className="form-row"><label>Status<select name="status" defaultValue={editing?.status ?? 'UNKNOWN'}><option value="UNKNOWN">Unknown</option><option value="DISABLED">Disabled</option></select></label><label>Active<select name="isActive" defaultValue={String(editing?.isActive ?? true)}><option value="true">Yes</option><option value="false">No</option></select></label></div><p className="form-note">Health states require future connection checks. No credentials are stored here.</p></>;
}
