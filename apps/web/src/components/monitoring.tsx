'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight, CircleAlert, RefreshCw } from 'lucide-react';
import { DateTime, EmptyState, PageHeader, StatusBadge } from './ui';

type Health = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
type Result = { id: string; targetType: string; targetId: string; targetName: string; checkType: string; status: Health; summary: string; details: Record<string, unknown> | null; checkedAt: string; errorCode: string | null };
type Issue = { id: string; targetType: string; targetId: string; targetName: string; checkType: string; status: 'OPEN' | 'RESOLVED'; severity: Health; summary: string; firstDetectedAt: string; lastDetectedAt: string; resolvedAt: string | null; lastHealthyAt: string | null };
type Run = { id: string; trigger: string; status: string; createdAt: string; completedAt: string | null; resultCount: number; issueCount: number; errorCode: string | null };
type Summary = { lastRun: Run | null; lastResultRun: Run | null; runs: Run[]; issues: Issue[]; results: Result[]; live: { redis: Health; worker: Health } };
type IssuesPage = { items: Issue[]; nextCursor: string | null; total: number };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? 'Monitoring request failed.');
  return data as T;
}

function targetHref(type: string, id: string) {
  if (type === 'MAILBOX') return `/mailboxes/${id}`;
  if (type === 'DOMAIN') return `/domains/${id}`;
  if (type === 'MAIL_SERVER') return `/mail-servers/${id}`;
  return '/monitoring';
}

function ResultSection({ title, description, results }: { title: string; description: string; results: Result[] }) {
  return <section className="panel monitor-section"><div className="panel-title"><div><h2>{title}</h2><p>{description}</p></div><span>{results.length}</span></div>
    {results.length ? <div className="monitor-list">{results.map(item => <div className="monitor-row" key={item.id}><div><Link href={targetHref(item.targetType, item.targetId)}>{item.targetName}</Link><small>{item.checkType.replaceAll('_', ' ')} · {item.summary}</small></div><StatusBadge status={item.status}/></div>)}</div> : <EmptyState icon={Activity} title="No checks yet" description="Run monitoring to collect evidence."/>}
  </section>;
}

export function Monitoring() {
  const [data, setData] = useState<Summary | null>(null);
  const [pages, setPages] = useState<Record<'OPEN' | 'RESOLVED', IssuesPage>>({ OPEN: { items: [], nextCursor: null, total: 0 }, RESOLVED: { items: [], nextCursor: null, total: 0 } });
  const [tab, setTab] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const load = useCallback(async () => {
    try {
      const [summary, open, resolved] = await Promise.all([request<Summary>('monitoring'), request<IssuesPage>('monitoring/issues?status=OPEN'), request<IssuesPage>('monitoring/issues?status=RESOLVED')]);
      setData(summary); setPages({ OPEN: open, RESOLVED: resolved }); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Monitoring is unavailable.'); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); const timer = setInterval(() => void load(), 15000); return () => clearInterval(timer); }, [load]);
  async function run() {
    setRunning(true); setError('');
    try { await request<Run>('monitoring/runs', { method: 'POST' }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start monitoring.'); }
    finally { setRunning(false); }
  }
  async function more() {
    const cursor = pages[tab].nextCursor;
    if (!cursor) return;
    try {
      const next = await request<IssuesPage>(`monitoring/issues?status=${tab}&cursor=${encodeURIComponent(cursor)}`);
      setPages(current => ({ ...current, [tab]: { items: [...current[tab].items, ...next.items], nextCursor: next.nextCursor, total: next.total } }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load issues.'); }
  }
  const current = data?.results ?? [];
  const overall = current.filter(item => item.checkType === 'OVERALL');
  const counts = { HEALTHY: overall.filter(item => item.status === 'HEALTHY').length, WARNING: overall.filter(item => item.status === 'WARNING').length, CRITICAL: overall.filter(item => item.status === 'CRITICAL').length, UNKNOWN: overall.filter(item => item.status === 'UNKNOWN').length };
  const overallStatus: Health = !data?.lastResultRun ? 'UNKNOWN' : data.live.redis === 'CRITICAL' || data.live.worker === 'CRITICAL' || counts.CRITICAL ? 'CRITICAL' : counts.WARNING ? 'WARNING' : counts.UNKNOWN || !counts.HEALTHY ? 'UNKNOWN' : 'HEALTHY';
  const visibleIssues = pages[tab].items;
  return <><PageHeader eyebrow="OPERATIONS" title="Monitoring" description="Evidence from connection tests, sync, sending, DNS, TLS, queues, and worker heartbeat." actions={<button className="primary-button" onClick={() => void run()} disabled={running || data?.lastRun?.status === 'RUNNING' || data?.lastRun?.status === 'QUEUED'}><RefreshCw size={16} aria-hidden="true"/>{running ? 'Starting…' : 'Run checks now'}</button>}/>
    {error && <div className="error-panel" role="alert"><strong>Monitoring unavailable</strong><p>{error}</p><button className="secondary-button" onClick={() => void load()}>Retry</button></div>}
    {!data ? <div className="loading-state" role="status">Loading monitoring…</div> : <>
      <div className="monitor-live"><strong>Overall health <StatusBadge status={overallStatus}/></strong><span>Latest completed checks <DateTime value={data.lastResultRun?.completedAt} mode="full"/></span></div>
      <div className="monitor-overview"><div><span>Healthy</span><strong>{counts.HEALTHY}</strong></div><div><span>Warning</span><strong>{counts.WARNING}</strong></div><div><span>Critical</span><strong>{counts.CRITICAL}</strong></div><div><span>Unknown</span><strong>{counts.UNKNOWN}</strong></div></div>
      <div className="monitor-live"><span>Redis <StatusBadge status={data.live.redis}/></span><span>Worker <StatusBadge status={data.live.worker}/></span><span>Last run <strong>{data.lastRun ? <><StatusBadge status={data.lastRun.status}/> <DateTime value={data.lastRun.completedAt ?? data.lastRun.createdAt} mode="full"/></> : 'Never'}</strong></span></div>
      <section className="panel monitor-section"><div className="panel-title"><div><h2>Alert center</h2><p>Persistent issues open once and resolve after a healthy check.</p></div><CircleAlert size={18} aria-hidden="true"/></div><div className="monitor-tabs"><button className={tab === 'OPEN' ? 'selected' : ''} onClick={() => setTab('OPEN')} aria-pressed={tab === 'OPEN'}>Open ({pages.OPEN.total})</button><button className={tab === 'RESOLVED' ? 'selected' : ''} onClick={() => setTab('RESOLVED')} aria-pressed={tab === 'RESOLVED'}>Resolved ({pages.RESOLVED.total})</button></div>
        {visibleIssues.length ? <div className="table-scroll"><table><thead><tr><th>SEVERITY</th><th>TARGET</th><th>ISSUE</th><th>FIRST DETECTED</th><th>LAST CHECKED</th><th>LAST HEALTHY</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{visibleIssues.map(issue => <tr key={issue.id}><td><StatusBadge status={issue.severity}/></td><td>{issue.targetName}</td><td>{issue.summary}<small className="monitor-note">{issue.checkType.replaceAll('_', ' ')}</small></td><td><DateTime value={issue.firstDetectedAt} mode="full"/></td><td><DateTime value={issue.lastDetectedAt} mode="full"/></td><td><DateTime value={issue.lastHealthyAt} mode="full"/></td><td><StatusBadge status={issue.status}/></td><td><Link href={targetHref(issue.targetType, issue.targetId)}>View <ArrowRight size={13} aria-hidden="true"/></Link></td></tr>)}</tbody></table></div> : <EmptyState icon={CircleAlert} title={tab === 'OPEN' ? 'No active issues' : 'No resolved issues'} description={tab === 'OPEN' ? 'A completed monitoring run will report issues here.' : 'Recovered issues will appear here.'}/>}
        {pages[tab].nextCursor && <div className="monitor-more"><button className="secondary-button" onClick={() => void more()}>Load more</button></div>}
      </section>
      <div className="monitor-grid"><ResultSection title="Mailboxes" description="Connections, sync freshness, and quota" results={overall.filter(item => item.targetType === 'MAILBOX')}/><ResultSection title="Mail servers" description="Certificate and TLS state" results={overall.filter(item => item.targetType === 'MAIL_SERVER')}/><ResultSection title="Domains / deliverability" description="MX, SPF, DKIM, and DMARC" results={overall.filter(item => item.targetType === 'DOMAIN')}/><ResultSection title="Queues & workers" description="Redis, job counts, heartbeat, and outgoing pipeline" results={current.filter(item => ['QUEUE', 'WORKER', 'SYSTEM'].includes(item.targetType))}/></div>
      <section className="panel monitor-section"><div className="panel-title"><div><h2>Recent monitoring runs</h2><p>Scheduled and manual checks</p></div></div><div className="monitor-list">{data.runs.map(item => <div className="monitor-row" key={item.id}><div><strong>{item.trigger.toLowerCase()} run</strong><small><DateTime value={item.createdAt} mode="full"/> · {item.resultCount} results · {item.issueCount} open issues{item.errorCode ? ` · ${item.errorCode}` : ''}</small></div><StatusBadge status={item.status}/></div>)}</div></section>
    </>}
  </>;
}
