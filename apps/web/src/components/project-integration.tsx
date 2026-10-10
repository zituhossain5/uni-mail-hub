'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Copy, KeyRound, MailPlus, RefreshCw } from 'lucide-react';
import { Dialog } from './dialog';
import { StatusBadge } from './ui';
import { integrationExamples } from '@/lib/integration-examples';

type Domain = { id: string; domain: string };
type Mailbox = { id: string; email: string; status: string };
type Project = { id: string; name: string; domains: Domain[]; mailboxes: Mailbox[] };
type Account = { id: string; name: string; status: string; connectionStatus: string };
type Server = { id: string; name: string; status: string; providerType: string };
type Key = { id: string; projectId: string; name: string; keyPrefix: string; isActive: boolean; revokedAt: string | null; grants: { mailbox: { id: string; email: string } }[] };
type Discovery = { domains: { domain: string }[]; mailboxes: { email: string; state: string; managedMailbox: { id: string } | null; usedBytes: string | null; quotaBytes: string | null; usagePercent: number | null; unlimitedQuota: boolean; suspended: boolean | null }[] };
type Change = { id: string; projectId: string | null; email: string; action: string; status: string; errorCode: string | null };
type Webhook = { id: string; name: string; status: string; url: string };
type Confirm = { kind: 'rotate' | 'delete' | 'suspend' | 'unsuspend' | 'recover' | 'abandon' | 'revoke'; email: string; changeId?: string; keyId?: string };
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { ...init, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? 'Request failed.');
  return data as T;
}
function size(bytes: string | null) {
  if (bytes === null) return 'Unknown';
  const value = Number(bytes);
  return Number.isFinite(value) ? `${(value / 1048576).toFixed(1)} MB` : 'Unknown';
}
export function ProjectIntegration({ projectId, publicBaseUrl, environment }: { projectId: string; publicBaseUrl: string; environment: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [accountId, setAccountId] = useState('');
  const [domainId, setDomainId] = useState('');
  const [senderId, setSenderId] = useState('');
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const [selectedGrants, setSelectedGrants] = useState<string[]>([]);
  const [rawKey, setRawKey] = useState('');
  const [rawKeyId, setRawKeyId] = useState('');
  const [replacementOf, setReplacementOf] = useState('');
  const [quotaMode, setQuotaMode] = useState<'FINITE' | 'UNLIMITED'>('FINITE');
  const [quotaMb, setQuotaMb] = useState('2048');
  const [mailServerId, setMailServerId] = useState('');
  const [mailHost, setMailHost] = useState('');
  const [localPart, setLocalPart] = useState('');
  const [example, setExample] = useState('Node.js');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [typedEmail, setTypedEmail] = useState('');
  const [reviewedRemote, setReviewedRemote] = useState(false);
  const load = useCallback(async () => {
    const [p, a, s, k, w] = await Promise.all([
      api<Project>(`projects/${projectId}`), api<Account[]>('cpanel-accounts'),
      api<Server[]>('mail-servers'), api<Key[]>('api-keys'), api<{ endpoints: Webhook[] }>(`admin/projects/${projectId}/webhooks`),
    ]);
    setProject(p); setAccounts(a); setServers(s); setKeys(k.filter(item => item.projectId === projectId)); setWebhooks(w.endpoints);
    setAccountId(current => current && a.some(item => item.id === current && item.status === 'ACTIVE') ? current : a.find(item => item.status === 'ACTIVE')?.id ?? '');
    setDomainId(current => current && p.domains.some(item => item.id === current) ? current : p.domains[0]?.id ?? '');
    setSenderId(current => current && p.mailboxes.some(item => item.id === current) ? current : p.mailboxes[0]?.id ?? '');
  }, [projectId]);
  const loadDiscovery = useCallback(async (current: string) => {
    const [data, pending] = await Promise.all([
      api<Discovery>(`cpanel-accounts/${current}/discovery`),
      api<Change[]>(`cpanel-accounts/${current}/mailboxes/changes`),
    ]);
    setDiscovery(data); setChanges(pending);
  }, []);
  useEffect(() => { void Promise.resolve().then(load).catch(err => setError(err instanceof Error ? err.message : 'Unable to load integration.')); }, [load]);
  useEffect(() => { if (accountId) void Promise.resolve().then(() => loadDiscovery(accountId)).catch(err => setError(err instanceof Error ? err.message : 'Unable to load cPanel data.')); }, [accountId, loadDiscovery]);
  const activeKeys = keys.filter(item => item.isActive && !item.revokedAt);
  const selectedKey = keys.find(item => item.id === selectedKeyId) ?? null;
  const sender = project?.mailboxes.find(item => item.id === senderId) ?? null;
  const selectedDomain = project?.domains.find(item => item.id === domainId) ?? null;
  const mapped = discovery?.mailboxes.find(item => item.state === 'MANAGED' && item.managedMailbox?.id === senderId) ?? null;
  const unresolved = changes.filter(item => item.projectId === projectId && item.status !== 'COMPLETED');
  const rawAvailable = rawKey && rawKeyId === selectedKeyId;
  const snippet = `UNI_MAIL_HUB_URL=${publicBaseUrl || 'CONFIGURE_PUBLIC_BASE_URL'}\nUNI_MAIL_HUB_API_KEY=${rawAvailable ? rawKey : 'PASTE_API_KEY'}\nUNI_MAIL_HUB_MAILBOX_ID=${sender?.id ?? 'SELECT_SENDER_MAILBOX'}`;
  const keyGrantsSender = !!selectedKey?.grants.some(item => item.mailbox.id === senderId);
  async function run(action: string, task: () => Promise<void>) {
    setBusy(action); setError(''); setNotice('');
    try {
      await task();
      try { await load(); if (accountId) await loadDiscovery(accountId); }
      catch { setError('The operation completed, but this view could not refresh. Reload the page to see its current state.'); }
    } catch (err) { setError(err instanceof Error ? err.message : 'Operation failed.'); }
    finally { setBusy(''); }
  }
  async function createDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const domain = String(new FormData(form).get('domain') ?? '').trim().toLowerCase();
    await run('domain', async () => { const created = await api<Domain>('domains', { method: 'POST', body: JSON.stringify({ projectId, domain }) }); setDomainId(created.id); form.reset(); setNotice('Domain added. Select its cPanel account to create a mailbox.'); });
  }
  async function provision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDomain || !accountId) return;
    const email = `${localPart.trim().toLowerCase()}@${selectedDomain.domain}`;
    await run('provision', async () => {
      const created = await api<{ id: string; checks: { imap: { status: string } | null; smtp: { status: string } | null } | null }>(`cpanel-accounts/${accountId}/mailboxes/provision`, { method: 'POST', body: JSON.stringify({ projectId, domainId, email, quotaMb: quotaMode === 'UNLIMITED' ? null : Number(quotaMb), ...(mailServerId === 'new' ? { mailHost } : { mailServerId }) }) });
      setSenderId(created.id); setLocalPart('');
      setNotice(`Mailbox created and password encrypted. IMAP: ${created.checks?.imap?.status ?? 'not tested'}; SMTP: ${created.checks?.smtp?.status ?? 'not tested'}.`);
    });
  }
  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    await run('key', async () => {
      const created = await api<Key & { rawKey: string }>('api-keys', { method: 'POST', body: JSON.stringify({ projectId, name, mailboxIds: selectedGrants, scopes: ['MAIL_SEND'], integration: true }) });
      if (selectedKeyId) setReplacementOf(selectedKeyId);
      setRawKey(created.rawKey); setRawKeyId(created.id); setSelectedKeyId(created.id);
      setNotice('Application credential created. Copy the key and configuration now; the key cannot be retrieved later.');
    });
  }
  async function copy(value: string, audit = false) {
    try { await navigator.clipboard.writeText(value); }
    catch { setError('Copy failed. Select and copy the text manually.'); return; }
    setNotice('Copied to clipboard.');
    if (audit && selectedKeyId && senderId) {
      try { await api(`projects/${projectId}/integration/config-generated`, { method: 'POST', body: JSON.stringify({ apiKeyId: selectedKeyId, mailboxId: senderId }) }); }
      catch { setError('Configuration copied, but the audit event could not be recorded.'); }
    }
  }
  function openConfirm(next: Confirm) { setTypedEmail(''); setReviewedRemote(false); setConfirm(next); setError(''); }
  async function confirmedAction() {
    if (!confirm || typedEmail !== confirm.email || !accountId) return;
    const target = confirm;
    await run(target.kind, async () => {
      if (target.kind === 'revoke' && target.keyId) {
        await api(`api-keys/${target.keyId}/revoke`, { method: 'POST' });
        setReplacementOf('');
        setNotice('Old API key revoked.');
      } else if (target.changeId && (target.kind === 'recover' || target.kind === 'abandon')) {
        await api(`cpanel-accounts/${accountId}/mailboxes/changes/${target.changeId}/${target.kind}`, { method: 'POST', body: JSON.stringify({ confirmEmail: typedEmail, ...(target.kind === 'recover' ? { confirmRemoteExists: reviewedRemote } : {}) }) });
        setNotice(target.kind === 'recover' ? 'Credential recovery completed.' : 'Unconfirmed change abandoned after verifying the mailbox is absent.');
      } else if (senderId) {
        const operation = target.kind === 'rotate' ? 'rotate' : target.kind === 'delete' ? 'delete-from-cpanel' : 'suspension';
        await api(`cpanel-accounts/${accountId}/mailboxes/${senderId}/${operation}`, { method: 'POST', body: JSON.stringify(target.kind === 'suspend' || target.kind === 'unsuspend' ? { confirmEmail: typedEmail, suspended: target.kind === 'suspend' } : { confirmEmail: typedEmail }) });
        setNotice(target.kind === 'delete' ? 'Deleted from cPanel. Managed history remains disabled.' : 'cPanel operation completed. Connection status may need a new test.');
      }
      setConfirm(null);
    });
  }
  async function changeQuota(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId || !senderId) return;
    await run('quota', async () => {
      await api(`cpanel-accounts/${accountId}/mailboxes/${senderId}/quota`, { method: 'POST', body: JSON.stringify({ quotaMb: quotaMode === 'UNLIMITED' ? null : Number(quotaMb) }) });
      setNotice('Mailbox quota changed in cPanel.');
    });
  }
  if (!project) return <div role="status" className="loading-state">{error || 'Loading integration…'}</div>;
  return <div className="integration-page">
    <div className="integration-intro"><div><span className="eyebrow">DEVELOPER ONBOARDING</span><h2>Connect {project.name} to Uni Mail Hub</h2><p>Create a sender and project credential, then copy the HTTP integration settings into your application.</p></div><span className="integration-env">{environment}</span></div>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="notice-success" role="status">{notice}</p>}
    <div className="integration-steps">
      <section className="panel integration-card"><div className="integration-step"><span>1</span><div><h3>Project and domain</h3><p>{project.name} · Choose a domain owned by this project.</p></div></div>
        <div className="entity-form"><label>Domain<select value={domainId} onChange={event => setDomainId(event.target.value)}><option value="">Select domain</option>{project.domains.map(item => <option key={item.id} value={item.id}>{item.domain}</option>)}</select></label></div>
        <form className="entity-form integration-inline" onSubmit={event => void createDomain(event)}><label>Add a domain<input name="domain" type="text" placeholder="example.com" required/></label><button className="secondary-button" disabled={!!busy}>Add domain</button></form>
      </section>
      <section className="panel integration-card"><div className="integration-step"><span>2</span><div><h3>cPanel mailbox</h3><p>Select the account that actually manages the domain. Uni Mail Hub generates and encrypts the mailbox password.</p></div></div>
        <div className="entity-form"><label>cPanel account<select value={accountId} onChange={event => setAccountId(event.target.value)}><option value="">Select account</option>{accounts.filter(item => item.status === 'ACTIVE').map(item => <option key={item.id} value={item.id}>{item.name} · {item.connectionStatus}</option>)}</select></label></div>
        {selectedDomain && discovery && !discovery.domains.some(item => item.domain === selectedDomain.domain) && <p className="form-note">This domain is not in the selected account’s latest discovery. Provisioning verifies ownership live before creating the mailbox.</p>}
        <form className="entity-form integration-form" onSubmit={event => void provision(event)}>
          <label>New mailbox name<div className="integration-email"><input value={localPart} onChange={event => setLocalPart(event.target.value)} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" maxLength={64} placeholder="contact" required/><span>@{selectedDomain?.domain ?? 'select-domain'}</span></div></label>
          <label>Mail server<select value={mailServerId} onChange={event => setMailServerId(event.target.value)} required><option value="">Select</option>{servers.filter(item => item.status === 'ACTIVE' && item.providerType === 'CPANEL').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="new">Create shared cPanel mail server</option></select></label>
          {mailServerId === 'new' && <label>IMAP/SMTP mail host<input value={mailHost} onChange={event => setMailHost(event.target.value)} placeholder="mail.example.com" required/><small>Verified TLS on IMAP 993 and SMTP 465. The mail host can differ from the cPanel web host.</small></label>}
          <div className="integration-inline"><label>Quota<select value={quotaMode} onChange={event => setQuotaMode(event.target.value as 'FINITE' | 'UNLIMITED')}><option value="FINITE">Finite (MB)</option><option value="UNLIMITED">Unlimited</option></select></label>{quotaMode === 'FINITE' && <label>MB<input type="number" min="1" max="1048576" value={quotaMb} onChange={event => setQuotaMb(event.target.value)} required/></label>}</div>
          <button className="primary-button" disabled={!!busy || !accountId || !domainId || !mailServerId}><MailPlus size={16}/> {busy === 'provision' ? 'Creating…' : 'Create mailbox in cPanel'}</button>
        </form>
        <p className="form-note">Existing mailbox? <Link href="/cpanel-accounts">Import it from cPanel discovery</Link>, then <Link href={sender ? `/mailboxes/${sender.id}` : '/mailboxes'}>enter the known password</Link> or explicitly rotate it below.</p>
      </section>
      <section className="panel integration-card"><div className="integration-step"><span>3</span><div><h3>Sender and application credential</h3><p>Select one or more permitted sender mailboxes. The raw API key appears only once.</p></div></div>
        <div className="entity-form"><label>Default sender for examples<select value={senderId} onChange={event => setSenderId(event.target.value)}><option value="">Select sender</option>{project.mailboxes.map(item => <option key={item.id} value={item.id}>{item.email} · {item.status}</option>)}</select></label>
          <fieldset><legend>Allowed sender mailboxes</legend>{project.mailboxes.map(item => <label key={item.id}><input type="checkbox" checked={selectedGrants.includes(item.id)} onChange={event => setSelectedGrants(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/>{item.email}</label>)}{!project.mailboxes.length && <p className="form-note">Create or import a mailbox first.</p>}</fieldset>
        </div>
        <form className="entity-form integration-inline" onSubmit={event => void createKey(event)}><label>Credential name<input name="name" required placeholder="Website production" maxLength={120}/></label><button className="primary-button" disabled={!!busy || !selectedGrants.length}><KeyRound size={16}/>{selectedKeyId ? 'Create replacement credential' : 'Create application credential'}</button></form>
        <div className="entity-form"><label>API key status<select value={selectedKeyId} onChange={event => { setSelectedKeyId(event.target.value); setRawKey(''); setRawKeyId(''); }}><option value="">No key selected</option>{activeKeys.map(item => <option key={item.id} value={item.id}>{item.name} · {item.keyPrefix}…</option>)}</select></label>{selectedKey && <p className="form-note">{selectedKey.grants.length} sender grant(s). {keyGrantsSender ? 'Selected sender is permitted.' : 'Select a permitted sender or create a new key.'}</p>}</div>
        {replacementOf && rawAvailable && <button type="button" className="ghost-button danger-text" onClick={() => openConfirm({ kind: 'revoke', email: sender?.email ?? '', keyId: replacementOf })}>Revoke old key after your application uses the replacement</button>}
      </section>
      <section className="panel integration-card"><div className="integration-step"><span>4</span><div><h3>Application configuration</h3><p>API endpoint: <code>{publicBaseUrl ? `${publicBaseUrl}/api/v1/messages` : 'Configure UNI_MAIL_HUB_PUBLIC_URL'}</code></p></div></div>
        {!rawAvailable && <p className="form-note">Create a new API key to generate a complete environment snippet. Existing raw keys cannot be retrieved.</p>}
        {!publicBaseUrl && <p className="form-error">Set UNI_MAIL_HUB_PUBLIC_URL on the web server before copying production configuration.</p>}
        <div className="integration-code"><pre>{snippet}</pre><button type="button" className="secondary-button" disabled={!rawAvailable || !sender || !keyGrantsSender || !publicBaseUrl} onClick={() => void copy(snippet, true)}><Copy size={15}/>Copy environment</button></div>
        {rawAvailable && <button type="button" className="ghost-button" onClick={() => { setRawKey(''); setRawKeyId(''); }}>Clear one-time key from page</button>}
        <p className="form-note">Store these values only in your application’s server environment. Your application no longer needs SMTP_HOST, SMTP_PORT, SMTP_USERNAME, or SMTP_PASSWORD.</p>
        <p className="form-note">Webhooks: {webhooks.length ? webhooks.map(item => `${item.name} (${item.status})`).join(', ') : 'None configured'}. <Link href={`/projects/${projectId}?tab=Webhooks`}>Manage webhooks</Link>.</p>
      </section>
      <section className="panel integration-card"><div className="integration-step"><span>5</span><div><h3>Integration examples</h3><p>All examples send through POST /api/v1/messages with Bearer authentication, an idempotency key, and JSON.</p></div></div>
        <div className="integration-inline"><label>Platform<select value={example} onChange={event => setExample(event.target.value)}>{Object.keys(integrationExamples).map(name => <option key={name}>{name}</option>)}</select></label><button type="button" className="secondary-button" onClick={() => void copy(integrationExamples[example] ?? '')}><Copy size={15}/>Copy example</button></div>
        <div className="integration-code"><pre>{integrationExamples[example]}</pre></div>
      </section>
    </div>
    {sender && <section className="panel integration-card"><div className="integration-step"><span><RefreshCw size={16}/></span><div><h3>Manage {sender.email}</h3><p>Mailbox ID: <code>{sender.id}</code> · <StatusBadge status={sender.status}/></p></div></div>
      <div className="button-row"><Link className="secondary-button" href={`/mailboxes/${sender.id}`}>Connection tests and sync</Link>{mapped && <><button className="secondary-button" onClick={() => openConfirm({ kind: 'rotate', email: sender.email })}>Rotate password and connect</button><button className="secondary-button" onClick={() => openConfirm({ kind: mapped.suspended ? 'unsuspend' : 'suspend', email: sender.email })}>{mapped.suspended ? 'Unsuspend' : 'Suspend'}</button><button className="ghost-button danger-text" onClick={() => openConfirm({ kind: 'delete', email: sender.email })}>Delete from cPanel</button></>}</div>
      {mapped && <><p className="form-note">Used: {size(mapped.usedBytes)} · Quota: {mapped.unlimitedQuota ? 'Unlimited' : size(mapped.quotaBytes)} · Usage: {mapped.usagePercent === null ? 'Unknown' : `${mapped.usagePercent}%`}</p>
        <form className="entity-form integration-inline" onSubmit={event => void changeQuota(event)}><label>Change quota<select value={quotaMode} onChange={event => setQuotaMode(event.target.value as 'FINITE' | 'UNLIMITED')}><option value="FINITE">Finite (MB)</option><option value="UNLIMITED">Unlimited</option></select></label>{quotaMode === 'FINITE' && <label>MB<input type="number" min="1" max="1048576" value={quotaMb} onChange={event => setQuotaMb(event.target.value)} required/></label>}<button className="secondary-button" disabled={!!busy}>Save quota</button></form></>}
    </section>}
    {unresolved.length > 0 && <section className="panel integration-card"><h3>Credential recovery required</h3><p className="form-error">A cPanel change is unresolved. Do not retry provisioning or rotation until it is reconciled.</p>{unresolved.map(item => <div className="integration-recovery" key={item.id}><strong>{item.email}</strong><span>{item.action} · {item.status} · {item.errorCode ?? 'Outcome uncertain'}</span><button className="secondary-button" onClick={() => openConfirm({ kind: 'recover', email: item.email, changeId: item.id })}>Recover</button>{item.action === 'CREATE' && item.errorCode !== 'CPANEL_VAULT_UPDATE_FAILED' && <button className="ghost-button" onClick={() => openConfirm({ kind: 'abandon', email: item.email, changeId: item.id })}>Abandon if absent</button>}</div>)}</section>}
    <section className="panel integration-card"><h3>Moving an existing application</h3><ol className="integration-checklist"><li>Import or discover its mailbox.</li><li>Enter the known password or explicitly rotate it. Rotation may break mail clients, phones, Outlook, Thunderbird, and websites still using the old password.</li><li>Test IMAP and SMTP, then sync.</li><li>Create a project credential and grant only the required senders.</li><li>Replace SMTP settings in your application with the three Uni Mail Hub environment values above.</li><li>Test a send, then remove old SMTP secrets from the application.</li></ol><p className="form-note">Webhooks can be configured on the <Link href={`/projects/${projectId}?tab=Webhooks`}>Webhooks tab</Link>. No webhook secret is included in this snippet.</p></section>
    <Dialog open={!!confirm} title={confirm?.kind === 'delete' ? 'Delete mailbox from cPanel?' : confirm?.kind === 'rotate' ? 'Rotate mailbox password?' : confirm?.kind === 'revoke' ? 'Revoke old API key?' : confirm?.kind === 'recover' ? 'Recover credential?' : confirm?.kind === 'abandon' ? 'Abandon unconfirmed change?' : 'Change mailbox suspension?'} description={confirm?.kind === 'delete' ? 'cPanel mailbox data may be permanently lost. Uni Mail Hub historical records will remain disabled.' : confirm?.kind === 'rotate' ? 'Changing this password may break existing applications, mail clients, phones, Outlook, Thunderbird, and websites using the old password.' : confirm?.kind === 'recover' ? 'This may reapply the escrowed password in cPanel and update the local encrypted vault.' : 'Confirm this sensitive action.'} onClose={() => setConfirm(null)} footer={<><button className="secondary-button" onClick={() => setConfirm(null)} disabled={!!busy}>Cancel</button><button className={confirm?.kind === 'delete' || confirm?.kind === 'revoke' ? 'danger-button' : 'primary-button'} disabled={!!busy || typedEmail !== confirm?.email || (confirm?.kind === 'recover' && !reviewedRemote)} onClick={() => void confirmedAction()}>Confirm {confirm?.kind}</button></>}><label className="integration-confirm">Type <strong>{confirm?.email}</strong> to confirm<input value={typedEmail} onChange={event => setTypedEmail(event.target.value)} autoComplete="off"/></label>{confirm?.kind === 'recover' && <label className="integration-remote-confirm"><input type="checkbox" checked={reviewedRemote} onChange={event => setReviewedRemote(event.target.checked)}/>I inspected cPanel and confirmed this exact mailbox belongs to the selected account.</label>}{error && <p className="form-error" role="alert">{error}</p>}</Dialog>
  </div>;
}
