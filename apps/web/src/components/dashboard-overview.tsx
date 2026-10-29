'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type CSSProperties, type ReactNode } from 'react';
import { Activity, ArrowRight, CalendarDays, ChartNoAxesColumnIncreasing, Check, CheckCircle2, CircleAlert, CircleX, Clock3, Database, FolderKanban, Globe2, Hourglass, Inbox, Mail, Plus, RefreshCw, Send, Server, ShieldCheck, TriangleAlert } from 'lucide-react';
import { chartGeometry, type DashboardActivity, type DashboardSummary, type InfrastructureHealth } from '@/lib/dashboard';
import { useWorkspaceRole } from './access-context';
import { EmptyState, StatusBadge } from './ui';

function DashboardTimestamp({ value }: { value: string }) {
  const label = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(value));
  return <time dateTime={value} title={`${label} UTC`}>{label}</time>;
}

const number = (value: number) => value.toLocaleString('en-US');
const dayLabel = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));

function DashboardPanel({ title, icon, action, children, className = '' }: { title: string; icon: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`dashboard-card ${className}`}><header className="dashboard-card-heading"><h2>{icon}{title}</h2>{action}</header>{children}</section>;
}

function MailVolume({ activity, days, onDaysChange }: { activity: DashboardActivity | null; days: number; onDaysChange: (days: number) => void }) {
  const gradientId = useId().replaceAll(':', '');
  const titleId = `${gradientId}-title`;
  const [hovered, setHovered] = useState<number | null>(null);
  const daily = activity?.daily.slice(-days) ?? [];
  const { points, line, area, ceiling } = chartGeometry(daily);
  const total = daily.reduce((sum, day) => sum + day.count, 0);
  const selected = hovered === null ? null : points[hovered];
  return <DashboardPanel title="Mail volume" icon={<ChartNoAxesColumnIncreasing size={19} aria-hidden="true"/>} className="volume-card" action={<div className="chart-heading-actions">{activity && <span className="chart-total">Total <strong>{number(total)}</strong></span>}<label className="chart-range"><span className="sr-only">Mail volume date range</span><select value={days} onChange={event => { setHovered(null); onDaysChange(Number(event.target.value)); }}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option></select></label></div>}>
    <p className="chart-description">Outgoing messages submitted <span>· UTC</span></p>
    {!activity ? <EmptyState icon={ChartNoAxesColumnIncreasing} title="Mail volume unavailable" description="Refresh to try loading the recorded message history again."/> : <>
      <div className="volume-chart" key={days} onMouseLeave={() => setHovered(null)}>
        <svg viewBox="0 0 640 224" role="group" aria-labelledby={titleId}>
          <title id={titleId}>{`Outgoing messages submitted over the last ${days} days. ${number(total)} messages in total.`}</title>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".25"/><stop offset="100%" stopColor="var(--accent)" stopOpacity=".025"/></linearGradient></defs>
          <g aria-hidden="true">{Array.from({ length: 5 }, (_, index) => { const value = ceiling / 4 * index; const y = 190 - index * 41.5; return <g key={index}><line x1="44" x2="610" y1={y} y2={y} className="chart-grid-line"/><text x="34" y={y + 4} textAnchor="end" className="chart-axis-label">{value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : Number(value.toFixed(1))}</text></g>; })}
            {points.map((point, index) => { const show = daily.length <= 7 || index % Math.ceil((daily.length - 1) / 6) === 0 || index === daily.length - 1; return show && <g key={point.date}><line x1={point.x} x2={point.x} y1="24" y2="190" className="chart-vertical-line"/><text x={point.x} y="214" textAnchor="middle" className="chart-axis-label">{dayLabel(point.date)}</text></g>; })}
            <path d={area} fill={`url(#${gradientId})`} className="chart-area"/>
            <path d={line} pathLength="1" className="chart-line"/>
          </g>
          {points.map((point, index) => <g key={point.date} className="chart-point" role="img" aria-label={`${dayLabel(point.date)}: ${number(point.count)} messages`} tabIndex={0} onMouseEnter={() => setHovered(index)} onFocus={() => setHovered(index)} onBlur={() => setHovered(null)}>
            <rect x={point.x - 8} y="12" width="16" height="185" fill="transparent"/>
            <circle cx={point.x} cy={point.y} r={hovered === index ? 6 : daily.length <= 14 ? 4 : 2.5} className="chart-point-circle"/>
          </g>)}
        </svg>
        {selected && <div className="chart-tooltip" aria-hidden="true" style={{ left: `${Math.max(15, Math.min(85, selected.x / 640 * 100))}%`, top: `${Math.max(9, selected.y / 224 * 100 - 22)}%` }}><span>{dayLabel(selected.date)}</span><strong>{number(selected.count)} messages</strong></div>}
        {total === 0 && <div className="chart-zero-note"><Mail size={15} aria-hidden="true"/>No messages submitted in this period</div>}
      </div>
      <details className="chart-data"><summary>View daily counts</summary><div className="table-scroll"><table><caption className="sr-only">Daily outgoing submissions in UTC</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Messages</th></tr></thead><tbody>{daily.map(day => <tr key={day.date}><td>{dayLabel(day.date)}</td><td>{number(day.count)}</td></tr>)}</tbody></table></div></details>
    </>}
  </DashboardPanel>;
}

function MailboxHealth({ summary, canManage }: { summary: DashboardSummary; canManage: boolean }) {
  const total = summary.mailboxes;
  const healthy = summary.healthyMailboxes;
  const warning = summary.warningMailboxes;
  const errors = summary.errorMailboxes;
  const other = Math.max(0, total - healthy - warning - errors);
  const segments = [
    { label: 'Healthy', count: healthy, color: 'var(--health-green)' },
    { label: 'Warning', count: warning, color: 'var(--health-amber)' },
    { label: 'Error', count: errors, color: 'var(--health-red)' },
    ...(other ? [{ label: 'Unknown / disabled', count: other, color: 'var(--health-gray)' }] : []),
  ];
  let offset = 0;
  return <DashboardPanel title="Mailbox health" icon={<ShieldCheck size={19} aria-hidden="true"/>} className="mailbox-health-card" action={<Link href={canManage ? '/mailboxes' : '/inbox'} className="dashboard-text-link">View all</Link>}>
    <div className="mailbox-health-content"><div className="health-ring-wrap"><svg className="health-ring" viewBox="0 0 180 180" role="img" aria-label={`${healthy} healthy, ${warning} warning, ${errors} error and ${other} unknown or disabled mailboxes`}><circle cx="90" cy="90" r="69" fill="none" stroke="var(--line)" strokeWidth="22"/>{segments.map(segment => { const fraction = total ? segment.count / total : 0; const previous = offset; offset += fraction; return fraction > 0 && <circle key={segment.label} className="health-ring-segment" cx="90" cy="90" r="69" fill="none" stroke={segment.color} strokeWidth="22" pathLength="100" strokeDasharray={`${fraction * 100} ${100 - fraction * 100}`} strokeDashoffset={-previous * 100} transform="rotate(-90 90 90)"/>; })}</svg><div className="health-ring-label"><strong>{number(total)}</strong><span>Mailboxes</span></div></div>
      <div className="health-legend">{segments.map(segment => <div key={segment.label}><i style={{ background: segment.color }} aria-hidden="true"/><span>{segment.label}</span><strong>{number(segment.count)}<small>{total ? Math.round(segment.count / total * 100) : 0}%</small></strong></div>)}</div>
    </div>
    <div className="health-card-foot">{total ? <><span className={summary.issueMailboxes ? 'health-needs-attention' : 'health-good'}>{summary.issueMailboxes ? <TriangleAlert size={13} aria-hidden="true"/> : <CheckCircle2 size={13} aria-hidden="true"/>}{summary.issueMailboxes ? `${number(summary.issueMailboxes)} need attention` : healthy === total ? 'All mailboxes healthy' : 'Connection checks available'}</span><Link href="/monitoring">Open monitoring <ArrowRight size={12} aria-hidden="true"/></Link></> : <span>Register a mailbox to see its connection health.</span>}</div>
  </DashboardPanel>;
}

function Infrastructure({ health, summary }: { health: InfrastructureHealth | null; summary: DashboardSummary }) {
  const services = [
    { label: 'PostgreSQL', value: health?.database ?? 'Unavailable', good: health?.database === 'connected', unknown: !health, icon: Database },
    { label: 'Redis', value: health?.redis ?? 'Unavailable', good: health?.redis === 'connected', unknown: !health, icon: Server },
    { label: 'Mail worker', value: summary.monitoring.worker.toLowerCase(), good: summary.monitoring.worker === 'HEALTHY', unknown: summary.monitoring.worker === 'UNKNOWN', icon: Activity },
  ];
  return <DashboardPanel title="Infrastructure status" icon={<Server size={18} aria-hidden="true"/>} className="infrastructure-card" action={<Link href="/monitoring" className="dashboard-text-link">View all</Link>}><div className="infrastructure-services">{services.map(({ label, value, good, unknown, icon: Icon }) => <div className="infrastructure-service" key={label}><Icon size={17} aria-hidden="true"/><span>{label}</span><span className={`service-state ${good ? 'good' : unknown ? 'unknown' : 'issue'}`}><i className={good ? 'ambient-status-dot' : ''}/>{value}</span><span className={`signal-bars ${good ? 'signal-healthy' : ''}`} aria-hidden="true">{[1,2,3,4].map(bar => <i key={bar}/>)}</span></div>)}</div><p className="infrastructure-note">{summary.monitoring.lastCheckedAt ? <>Monitoring checked <DashboardTimestamp value={summary.monitoring.lastCheckedAt}/></> : <>Run monitoring to collect connection checks.</>}</p></DashboardPanel>;
}

export function DashboardOverview({ summary, health, activity }: { summary: DashboardSummary; health: InfrastructureHealth | null; activity: DashboardActivity | null }) {
  const role = useWorkspaceRole();
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [days, setDays] = useState(7);
  const firstDay = activity?.daily.slice(-days)[0];
  const lastDay = activity?.daily[activity.daily.length - 1];
  const canManage = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(role);
  const healthyPercent = summary.mailboxes ? Math.round(summary.healthyMailboxes / summary.mailboxes * 100) : null;
  const cards = [
    { label: 'Projects', value: summary.projects, icon: FolderKanban, href: canManage ? '/projects' : '/inbox', note: 'In your workspace', tone: 'accent' },
    { label: 'Domains', value: summary.domains, icon: Globe2, href: canManage ? '/domains' : '/inbox', note: 'Connected to projects', tone: 'accent' },
    { label: 'Mailboxes', value: summary.mailboxes, icon: Mail, href: canManage ? '/mailboxes' : '/inbox', note: 'Across your projects', tone: 'accent' },
    { label: 'Healthy', value: summary.healthyMailboxes, icon: ShieldCheck, href: '/monitoring', note: healthyPercent === null ? 'No mailboxes yet' : `${healthyPercent}% of mailboxes`, tone: 'green' },
    { label: 'Need attention', value: summary.issueMailboxes, icon: TriangleAlert, href: '/monitoring', note: summary.issueMailboxes ? 'Review connection health' : 'No known issues', tone: 'amber' },
  ];
  const outgoing = [
    { label: 'Queued', value: summary.queuedMessages, description: 'Waiting to be sent', icon: Hourglass, tone: 'amber' },
    { label: 'Processing', value: summary.processingMessages, description: 'Currently sending', icon: RefreshCw, tone: 'accent' },
    { label: 'Retry scheduled', value: summary.retryScheduledMessages, description: 'Will retry automatically', icon: Clock3, tone: 'orange' },
    { label: 'SMTP accepted', value: summary.smtpAcceptedToday, description: 'Today · upstream accepted', icon: CheckCircle2, tone: 'green' },
    { label: 'Failed today', value: summary.failedToday, description: 'Review send attempts', icon: CircleX, tone: 'red' },
  ];
  const monitoringIssues = summary.monitoring.criticalIssues + summary.monitoring.domainWarnings + summary.monitoring.queueFailures;
  return <div className="lavender-dashboard">
    <header className="dashboard-page-heading"><div><div className="dashboard-title-row"><h1>Dashboard</h1><span className="workspace-snapshot"><i className="ambient-status-dot" aria-hidden="true"/>Workspace overview</span></div><p>A little clarity for everything in your mail workspace.</p></div><div className="dashboard-page-actions"><button type="button" className={`dashboard-refresh icon-button ${refreshing ? 'refreshing' : ''}`} disabled={refreshing} aria-label="Refresh dashboard" title="Refresh dashboard" onClick={() => startRefresh(() => router.refresh())}><RefreshCw size={17} aria-hidden="true"/></button>{firstDay && lastDay && <span className="dashboard-date"><CalendarDays size={14} aria-hidden="true"/>{dayLabel(firstDay.date)} – {dayLabel(lastDay.date)}</span>}{canManage && <Link href="/projects" className="primary-button"><Plus size={17} aria-hidden="true"/>Manage projects</Link>}</div></header>

    <section className="workspace-metrics" aria-label="Workspace counts">{cards.map(({ label, value, icon: Icon, href, note, tone }, index) => <Link className={`workspace-metric metric-${tone}`} href={href} key={label} style={{ '--enter-order': index } as CSSProperties}><Icon size={26} strokeWidth={1.7} aria-hidden="true"/><div><span className="workspace-metric-label">{label}</span><strong>{number(value)}</strong><small>{note}</small></div></Link>)}</section>

    <div className="dashboard-charts"><MailVolume activity={activity} days={days} onDaysChange={setDays}/><MailboxHealth summary={summary} canManage={canManage}/></div>

    <DashboardPanel title="Outgoing mail status" icon={<Send size={19} aria-hidden="true"/>} className="outgoing-status-card" action={<Link href="/outgoing-mail" className="dashboard-text-link">View messages <ArrowRight size={12} aria-hidden="true"/></Link>}><div className="outgoing-status-grid">{outgoing.map(({ label, value, description, icon: Icon, tone }) => <Link href="/outgoing-mail" className={`outgoing-status status-tile-${tone}`} key={label}><span className={`outgoing-status-icon ${label === 'Processing' && value > 0 ? 'processing-icon' : ''}`}><Icon size={20} strokeWidth={1.8} aria-hidden="true"/></span><div><span>{label}</span><strong>{number(value)}</strong><small>{description}</small></div></Link>)}</div></DashboardPanel>

    {monitoringIssues > 0 && <Link className="dashboard-monitoring-alert" href="/monitoring"><CircleAlert size={17} aria-hidden="true"/><span><strong>{number(monitoringIssues)} monitoring {monitoringIssues === 1 ? 'issue needs' : 'issues need'} a look</strong><small>{summary.monitoring.criticalIssues} critical · {summary.monitoring.domainWarnings} domain warnings · {summary.monitoring.queueFailures} queue issues</small></span><ArrowRight size={16} aria-hidden="true"/></Link>}

    <div className="dashboard-lower-grid">
      <DashboardPanel title="Recent outgoing messages" icon={<Inbox size={18} aria-hidden="true"/>} className="recent-messages-card" action={<Link href="/outgoing-mail" className="dashboard-text-link">View all</Link>}>
        {!activity ? <EmptyState icon={Mail} title="Message history unavailable" description="Refresh the dashboard to try again."/> : activity.recentMessages.length === 0 ? <EmptyState icon={Mail} title="Your outgoing mail starts here" description="Messages you send will appear here with their SMTP status." action={<Link className="dashboard-text-link" href="/outgoing-mail">Open outgoing mail <ArrowRight size={12}/></Link>}/> : <div className="dashboard-message-table table-scroll"><table><thead><tr><th scope="col">To / subject</th><th scope="col">Status</th><th scope="col">Created (UTC)</th></tr></thead><tbody>{activity.recentMessages.map(message => <tr key={message.id}><td><Link href={`/outgoing-mail/${message.id}`} title={message.subject}><span>{message.recipients[0]?.email ?? 'No To recipient'}</span><small>{message.subject}</small></Link></td><td><StatusBadge status={message.status}/></td><td><DashboardTimestamp value={message.createdAt}/></td></tr>)}</tbody></table></div>}
      </DashboardPanel>
      <DashboardPanel title="Recent activity" icon={<Activity size={18} aria-hidden="true"/>} className="recent-activity-card">
        {summary.recentActivity.length === 0 ? <EmptyState icon={Activity} title="A fresh start" description="Administrative workspace changes will appear here."/> : <ol className="dashboard-activity-list">{summary.recentActivity.slice(0, 5).map((item, index) => <li key={item.id}><span className={`activity-event-icon event-${index % 3}`} aria-hidden="true">{item.entityType.toLowerCase().includes('mail') ? <Mail size={15}/> : item.entityType.toLowerCase().includes('domain') ? <Globe2 size={15}/> : <Check size={15}/>}</span><div><p>{item.action.replaceAll('_', ' ').replaceAll('.', ' ')}</p><small>{item.user?.name ?? 'System'} · <DashboardTimestamp value={item.createdAt}/></small></div></li>)}</ol>}
      </DashboardPanel>
      <Infrastructure health={health} summary={summary}/>
    </div>
    <footer className="dashboard-footer"><span><Mail size={13} aria-hidden="true"/>Uni Mail Hub<span className="footer-divider">/</span>Your mail, beautifully connected.</span><span>Workspace data · Refresh for the latest</span></footer>
  </div>;
}
