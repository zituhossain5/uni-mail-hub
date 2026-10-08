'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { DateTime, PageHeader, SectionCard, StatusBadge } from './ui';

type Result = { id: string; checkType: string; status: string; summary: string; details: Record<string, unknown> | null; checkedAt: string; errorCode: string | null };
type Data = { domain: { id: string; domain: string; status: string; dkimSelectors: string[] }; results: Result[] };

export function DomainHealth({ id }: { id: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectors, setSelectors] = useState('');
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/monitoring/domains/${id}`);
      const value = await response.json() as Data & { message?: string };
      if (!response.ok) throw new Error(value.message ?? 'Unable to load domain health.');
      setData(value); setSelectors(value.domain.dkimSelectors.join(', ')); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load domain health.'); }
  }, [id]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const response = await fetch(`/api/v1/monitoring/domains/${id}/dkim-selectors`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selectors: selectors.split(',').map(value => value.trim()).filter(Boolean) }) });
      const value = await response.json() as { message?: string };
      if (!response.ok) throw new Error(value.message ?? 'Unable to save DKIM selectors.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save DKIM selectors.'); }
    finally { setSaving(false); }
  }
  if (!data) return error ? <div className="error-panel" role="alert"><strong>Domain health is unavailable</strong><p>{error}</p><button className="secondary-button" onClick={() => void load()}>Retry</button></div> : <div className="loading-state" role="status">Loading domain health…</div>;
  return <><PageHeader eyebrow={<><Link href="/domains">DOMAINS</Link> / DELIVERABILITY</>} title={data.domain.domain} description="DNS evidence for this managed domain." status={<StatusBadge status={data.results.find(item => item.checkType === 'OVERALL')?.status ?? 'UNKNOWN'}/>} actions={<Link href="/monitoring" className="secondary-button">Monitoring</Link>}/>
    {error && <p className="form-error" role="alert">{error}</p>}
    <SectionCard title="Deliverability checks" description="Results come from the most recent monitoring run for this domain."><div className="monitor-list">{data.results.length ? data.results.map(item => <div className="monitor-row" key={item.id}><div><strong>{item.checkType.replaceAll('_', ' ')}</strong><small>{item.summary} · Checked <DateTime value={item.checkedAt} mode="full"/></small>{item.details && <small>{'records' in item.details ? JSON.stringify(item.details.records) : 'record' in item.details ? String(item.details.record) : 'policy' in item.details ? `Policy: ${item.details.policy}` : ''}</small>}</div><StatusBadge status={item.status}/></div>) : <p className="monitor-empty">No results yet. Run monitoring to check this domain.</p>}</div></SectionCard>
    <SectionCard title="DKIM selectors" description="Only configured selectors are checked. Leave empty when the selector is unknown."><form className="monitor-selector" onSubmit={save}><label>Selectors, separated by commas<input value={selectors} onChange={event => setSelectors(event.target.value)} placeholder="default, selector1" aria-label="DKIM selectors"/></label><button className="primary-button" disabled={saving}>{saving ? 'Saving…' : 'Save selectors'}</button></form><p className="form-note">Saving selectors changes monitoring configuration only. Run checks again to refresh results.</p></SectionCard>
  </>;
}
