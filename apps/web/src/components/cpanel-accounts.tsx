'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Download, Plus, RefreshCw, ServerCog } from 'lucide-react';
import { ConfirmDialog, Dialog } from './dialog';
import { DateTime, EmptyState, PageHeader, StatusBadge } from './ui';

type Account = { id: string; name: string; host: string; port: number; username: string; status: 'ACTIVE' | 'DISABLED'; connectionStatus: string; lastConnectedAt: string | null; lastDiscoveryAt: string | null; lastError: string | null; _count: { domains: number; mailboxes: number; forwarders: number } };
type DiscoveredMailbox = { id: string; email: string; domain: string; state: 'DISCOVERED' | 'MANAGED' | 'IGNORED' | 'MISSING'; usedBytes: string | null; quotaBytes: string | null; unlimitedQuota: boolean; usagePercent: number | null; suspended: boolean | null; lastSeenAt: string; managedMailbox: { id: string; email: string; credentialConfigured: boolean } | null };
type Discovery = { domains: { id: string; domain: string; state: string; lastSeenAt: string; managedDomainId: string | null }[]; mailboxes: DiscoveredMailbox[]; forwarders: { id: string; domain: string; source: string; destination: string }[]; runs: { id: string; status: string; createdAt: string; completedAt: string | null; domainsFound: number; mailboxesFound: number; forwardersFound: number; newItems: number; missingItems: number; errorCode: string | null; errorMessage: string | null }[] };
type Project = { id: string; name: string };
type Server = { id: string; name: string; status: string };
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { ...init, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? 'Request failed.');
  return data as T;
}
function formatBytes(value: string | null) {
  if (value === null) return 'Unknown';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Unknown';
  if (amount < 1024) return `${amount} B`;
  const unit = Math.min(4, Math.floor(Math.log(amount) / Math.log(1024)));
  return `${(amount / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}

export function CpanelAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [tokenTarget, setTokenTarget] = useState<Account | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [importTarget, setImportTarget] = useState<DiscoveredMailbox | null>(null);
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [projectChoice, setProjectChoice] = useState('');
  const [serverChoice, setServerChoice] = useState('');
  const [mailHost, setMailHost] = useState('');
  const selected = accounts.find(item => item.id === selectedId) ?? null;
  const loadAccounts = useCallback(async () => {
    const items = await api<Account[]>('cpanel-accounts');
    setAccounts(items);
    if (!items.length) setDiscovery(null);
    setSelectedId(current => current && items.some(item => item.id === current) ? current : items[0]?.id ?? null);
    setLoading(false);
  }, []);
  const loadDiscovery = useCallback(async (accountId: string) => { setDiscovery(await api<Discovery>(`cpanel-accounts/${accountId}/discovery`)); }, []);
  useEffect(() => { void Promise.resolve().then(loadAccounts).catch(err => { setError(String(err)); setLoading(false); }); }, [loadAccounts]);
  useEffect(() => { if (!selectedId) return; void Promise.resolve().then(() => loadDiscovery(selectedId)).catch(err => setError(String(err))); }, [selectedId, loadDiscovery]);
  useEffect(() => {
    if (!selectedId || !discovery?.runs.some(run => run.status === 'QUEUED' || run.status === 'RUNNING')) return;
    const timer = window.setInterval(() => { void Promise.all([loadAccounts(), loadDiscovery(selectedId)]).catch(err => setError(String(err))); }, 3000);
    return () => window.clearInterval(timer);
  }, [selectedId, discovery?.runs, loadAccounts, loadDiscovery]);
  async function refresh() { if (!selectedId) return; await Promise.all([loadAccounts(), loadDiscovery(selectedId)]); }
  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(success); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Request failed.'); }
    finally { setBusy(false); }
  }
  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const body = { name: String(values.name), host: String(values.host), port: 2083, username: String(values.username), status: String(values.status), ...(!editing ? { apiToken: String(values.apiToken) } : {}) };
    setBusy(true); setError('');
    try {
      const result = await api<Account>(`cpanel-accounts${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setFormOpen(false); setEditing(null); setNotice(editing ? 'Account updated.' : 'Account added.'); await loadAccounts(); setSelectedId(result.id);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save account.'); }
    finally { setBusy(false); }
  }
  async function replaceToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!tokenTarget) return;
    const token = String(new FormData(event.currentTarget).get('apiToken') ?? '');
    await perform(() => api(`cpanel-accounts/${tokenTarget.id}/token`, { method: 'POST', body: JSON.stringify({ apiToken: token }) }), 'API token replaced.');
    setTokenTarget(null);
  }
  async function beginImport(item: DiscoveredMailbox) {
    setImportTarget(item); setProjectChoice(''); setServerChoice(''); setMailHost(selected?.host ?? ''); setError('');
    try { const [p, s] = await Promise.all([api<Project[]>('projects'), api<Server[]>('mail-servers')]); setProjects(p); setServers(s); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load mappings.'); }
  }
  async function importMailbox(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !importTarget) return;
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const body = { ...(projectChoice === 'new' ? { newProject: { name: String(values.projectName), slug: String(values.projectSlug) } } : { projectId: projectChoice }), ...(serverChoice === 'new' ? { createMailServer: true, mailHost } : { mailServerId: serverChoice }) };
    setBusy(true); setError('');
    try { await api(`cpanel-accounts/${selected.id}/mailboxes/${importTarget.id}/import`, { method: 'POST', body: JSON.stringify(body) }); setImportTarget(null); setNotice(`${importTarget.email} imported. Credentials are not configured.`); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Import failed.'); }
    finally { setBusy(false); }
  }
  const filtered = (discovery?.mailboxes ?? []).filter(item => (filter === 'ALL' || filter === 'NEW' && item.state === 'DISCOVERED' || filter === item.state) && item.email.includes(search.trim().toLowerCase()));
  const latest = discovery?.runs[0];
  return <>
    <PageHeader eyebrow="SYSTEM / INTEGRATIONS" title="cPanel Accounts" description="Discover domains, mailboxes, quotas, and forwarders. Import only the mailboxes you choose." actions={<button type="button" className="primary-button" onClick={() => { setEditing(null); setError(''); setFormOpen(true); }}><Plus size={16} aria-hidden="true"/>Add cPanel account</button>}/>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="notice-success" role="status">{notice}</p>}
    <div className="cpanel-layout"><section className="registry-panel"><div className="registry-toolbar"><div><h2>Accounts</h2><p>{accounts.length} configured</p></div></div>{loading ? <div className="loading-state">Loading accounts…</div> : accounts.length === 0 ? <EmptyState icon={ServerCog} title="No cPanel accounts" description="Add a cPanel host and API token to start discovery."/> : <div className="cpanel-account-list">{accounts.map(item => <button type="button" key={item.id} className={`cpanel-account-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => { setDiscovery(null); setSelectedId(item.id); }}><span><strong>{item.name}</strong><small>{item.host} · {item.username}</small></span><StatusBadge status={item.status}/><span className="cpanel-account-stats">{item._count.domains} domains · {item._count.mailboxes} mailboxes</span></button>)}</div>}</section>
      <section className="registry-panel cpanel-detail"><div className="registry-toolbar"><div><h2>{selected?.name ?? 'Discovery'}</h2><p>{selected ? `${selected.host}:2083 · last discovery ${selected.lastDiscoveryAt ? new Date(selected.lastDiscoveryAt).toLocaleString() : 'never'}` : 'Select an account'}</p></div>{selected && <StatusBadge status={selected.connectionStatus}/>}</div>{selected ? <div className="cpanel-detail-body"><div className="button-row cpanel-actions"><button type="button" className="primary-button" disabled={busy || selected.status !== 'ACTIVE' || latest?.status === 'QUEUED' || latest?.status === 'RUNNING'} onClick={() => void perform(() => api(`cpanel-accounts/${selected.id}/discover`, { method: 'POST' }), 'Discovery queued. Results will refresh automatically.')}><RefreshCw size={15} aria-hidden="true"/>Discover now</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(() => api(`cpanel-accounts/${selected.id}/test-connection`, { method: 'POST' }), 'Connection test completed.')}>Test connection</button><button type="button" className="ghost-button" onClick={() => { setEditing(selected); setFormOpen(true); }}>Edit</button><button type="button" className="ghost-button" onClick={() => setTokenTarget(selected)}>Replace token</button><button type="button" className="ghost-button danger-text" onClick={() => setDeleteTarget(selected)}>Remove</button></div>{selected.lastError && <p className="form-error" role="status">{selected.lastError}</p>}
      <div className="cpanel-summary"><span><strong>{discovery?.domains.length ?? 0}</strong> domains</span><span><strong>{discovery?.mailboxes.length ?? 0}</strong> mailboxes</span><span><strong>{discovery?.forwarders.length ?? 0}</strong> forwarders</span><span><strong>{(discovery?.mailboxes ?? []).filter(item => item.state === 'MISSING').length}</strong> missing</span></div>
      {latest && <p className="detail-caption">Latest run: <StatusBadge status={latest.status}/> · {latest.mailboxesFound} mailboxes found · {latest.newItems} new · {latest.missingItems} missing <DateTime value={latest.completedAt} mode="full"/>{latest.errorMessage ? ` · ${latest.errorMessage}` : ''}</p>}
      <div className="cpanel-section-head"><h3>Discovered mailboxes</h3><div><label className="sr-only" htmlFor="cpanel-mailbox-filter">Filter status</label><select id="cpanel-mailbox-filter" value={filter} onChange={event => setFilter(event.target.value)}><option value="ALL">All</option><option value="NEW">New</option><option value="MANAGED">Managed</option><option value="MISSING">Missing</option><option value="IGNORED">Ignored</option></select><label className="sr-only" htmlFor="cpanel-mailbox-search">Search mailboxes</label><input id="cpanel-mailbox-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search mailboxes"/></div></div>
      {filtered.length ? <div className="table-scroll"><table><thead><tr><th>MAILBOX</th><th>STATUS</th><th>QUOTA</th><th>USAGE</th><th>LAST SEEN</th><th>ACTIONS</th></tr></thead><tbody>{filtered.map(item => <tr key={item.id}><td><strong className="cell-main">{item.email}</strong><span className="cell-secondary">{item.domain}{item.suspended ? ' · suspended' : ''}</span></td><td><StatusBadge status={item.state === 'DISCOVERED' ? 'NEW' : item.state}/>{item.state === 'MISSING' && <span className="cell-secondary">Managed record retained</span>}</td><td>{item.unlimitedQuota ? 'Unlimited' : formatBytes(item.quotaBytes)}</td><td><span className={item.usagePercent !== null && item.usagePercent >= 100 ? 'cpanel-danger' : item.usagePercent !== null && item.usagePercent >= 90 ? 'cpanel-critical' : item.usagePercent !== null && item.usagePercent >= 80 ? 'cpanel-warning' : ''}>{formatBytes(item.usedBytes)}{item.usagePercent !== null ? ` · ${item.usagePercent}%` : ''}</span></td><td><DateTime value={item.lastSeenAt}/></td><td><div className="button-row table-actions">{item.state === 'DISCOVERED' && <><button type="button" className="ghost-button" onClick={() => void beginImport(item)}><Download size={14} aria-hidden="true"/>Import</button><button type="button" className="ghost-button" onClick={() => void perform(() => api(`cpanel-accounts/${selected.id}/mailboxes/${item.id}/ignore`, { method: 'POST' }), 'Mailbox ignored.')}>Ignore</button></>}{item.state === 'IGNORED' && <button type="button" className="ghost-button" onClick={() => void perform(() => api(`cpanel-accounts/${selected.id}/mailboxes/${item.id}/restore`, { method: 'POST' }), 'Mailbox restored.')}>Restore</button>}{item.managedMailbox && <Link className="ghost-button" href={`/mailboxes/${item.managedMailbox.id}`}>Open managed</Link>}</div></td></tr>)}</tbody></table></div> : <EmptyState title="No mailboxes in this view" description="Run discovery or change the filter."/>}
      <div className="cpanel-lower"><div><h3>Domains</h3>{discovery?.domains.length ? <ul>{discovery.domains.map(item => <li key={item.id}><span>{item.domain}</span><StatusBadge status={item.state}/></li>)}</ul> : <p className="detail-caption">No domains discovered.</p>}</div><div><h3>Forwarders · read only</h3>{discovery?.forwarders.length ? <ul>{discovery.forwarders.map(item => <li key={item.id}><span>{item.source} → {item.destination}</span></li>)}</ul> : <p className="detail-caption">No forwarders found or this cPanel feature is unavailable.</p>}</div></div>
      <div className="cpanel-run-history"><h3>Discovery history</h3>{discovery?.runs.length ? <div className="table-scroll"><table><thead><tr><th>RUN</th><th>STATUS</th><th>DOMAINS</th><th>MAILBOXES</th><th>FORWARDERS</th><th>RESULT</th></tr></thead><tbody>{discovery.runs.map(run => <tr key={run.id}><td><DateTime value={run.createdAt} mode="full"/></td><td><StatusBadge status={run.status}/></td><td>{run.domainsFound}</td><td>{run.mailboxesFound}</td><td>{run.forwardersFound}</td><td>{run.errorCode ?? `${run.newItems} new · ${run.missingItems} missing`}</td></tr>)}</tbody></table></div> : <p className="detail-caption">No discovery runs yet.</p>}</div>
      </div> : <EmptyState title="Select a cPanel account" description="Connection and discovery details appear here."/>}</section></div>
    <Dialog open={formOpen} title={editing ? 'Edit cPanel account' : 'Add cPanel account'} description="Use a cPanel API token. The token is encrypted and will not be shown again." onClose={() => { if (!busy) setFormOpen(false); }} size="wide" footer={<><button type="button" className="secondary-button" onClick={() => setFormOpen(false)} disabled={busy}>Cancel</button><button type="submit" form="cpanel-account-form" className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save account'}</button></>}><form id="cpanel-account-form" className="entity-form" key={editing?.id ?? 'new'} onSubmit={saveAccount}><label>Name<input name="name" defaultValue={editing?.name ?? ''} required maxLength={120}/></label><div className="form-row"><label>cPanel host<input name="host" defaultValue={editing?.host ?? ''} placeholder="cpanel.example.com" required/></label><label>Port<input value="2083" disabled readOnly/></label></div><div className="form-row"><label>Username<input name="username" defaultValue={editing?.username ?? ''} required/></label><label>Status<select name="status" defaultValue={editing?.status ?? 'ACTIVE'}><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option></select></label></div>{!editing && <label>API token<input name="apiToken" type="password" autoComplete="off" required/></label>}<p className="form-note">HTTPS and certificate verification are required. Removing this account removes its discovery history but never deletes managed mailboxes.</p>{formOpen && error && <p className="form-error" role="alert">{error}</p>}</form></Dialog>
    <Dialog open={!!tokenTarget} title="Replace API token" description="The stored token cannot be viewed. Replacing it resets the connection status." onClose={() => setTokenTarget(null)} footer={<><button type="button" className="secondary-button" onClick={() => setTokenTarget(null)}>Cancel</button><button type="submit" form="cpanel-token-form" className="primary-button" disabled={busy}>Replace token</button></>}><form id="cpanel-token-form" className="entity-form" onSubmit={replaceToken}><label>New API token<input name="apiToken" type="password" autoComplete="off" required/></label></form></Dialog>
    <ConfirmDialog open={!!deleteTarget} title={`Remove ${deleteTarget?.name ?? 'cPanel account'}?`} description="The encrypted token and discovery history will be removed. Managed projects, domains, mail servers, and mailboxes will remain." confirmLabel="Remove account" busy={busy} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (!deleteTarget) return; setBusy(true); setError(''); void api(`cpanel-accounts/${deleteTarget.id}`, { method: 'DELETE' }).then(async () => { setDeleteTarget(null); setDiscovery(null); setNotice('cPanel account removed.'); await loadAccounts(); }).catch(err => setError(err instanceof Error ? err.message : 'Removal failed.')).finally(() => setBusy(false)); }}/>
    <Dialog open={!!importTarget} title={`Import ${importTarget?.email ?? 'mailbox'}`} description="Map this discovered mailbox to a project and shared mail server. No mailbox password is imported." onClose={() => setImportTarget(null)} size="wide" footer={<><button type="button" className="secondary-button" onClick={() => setImportTarget(null)} disabled={busy}>Cancel</button><button type="submit" form="cpanel-import-form" className="primary-button" disabled={busy || !projectChoice || !serverChoice}>Import mailbox</button></>}><form id="cpanel-import-form" className="entity-form" onSubmit={importMailbox}><label>Project<select value={projectChoice} onChange={event => setProjectChoice(event.target.value)} required><option value="">Select project</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="new">Create new project</option></select></label>{projectChoice === 'new' && <div className="form-row"><label>Project name<input name="projectName" required/></label><label>Project slug<input name="projectSlug" pattern="[a-z0-9]+(-[a-z0-9]+)*" required/></label></div>}<label>Mail server<select value={serverChoice} onChange={event => setServerChoice(event.target.value)} required><option value="">Select mail server</option>{servers.filter(item => item.status === 'ACTIVE').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="new">Create shared cPanel mail server</option></select></label>{serverChoice === 'new' && <label>Mail host<input value={mailHost} onChange={event => setMailHost(event.target.value)} required/><small>Confirm this host provides IMAP 993 and SMTP 465 with TLS. The cPanel web host may differ from the mail host.</small></label>}<p className="form-note">If the domain already exists, it must belong to the chosen project. The imported mailbox will show “Not configured” until you add its IMAP/SMTP credentials.</p>{importTarget && error && <p className="form-error" role="alert">{error}</p>}</form></Dialog>
  </>;
}
