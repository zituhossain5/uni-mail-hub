import Link from 'next/link';
import { Activity, ArrowRight, CheckCircle2, CircleAlert, Clock3, FolderKanban, Globe2, Inbox, Mail, Send, Server, ShieldCheck } from 'lucide-react';
import { apiGet } from '@/lib/api';

type Summary = { projects: number; domains: number; mailboxes: number; healthyMailboxes: number; issueMailboxes: number; recentActivity: { id: string; action: string; entityType: string; createdAt: string; user: { name: string } | null }[] };
type Health = { status: string; database: string; redis: string };
export default async function Dashboard() {
  const summary = await apiGet<Summary>('dashboard');
  const health = await apiGet<Health>('health');
  if (!summary) return <div className="error-panel">Dashboard data is unavailable. Check the API and database connection.</div>;
  const cards = [
    { label: 'Projects', value: summary.projects, icon: FolderKanban, tone: 'blue' },
    { label: 'Domains', value: summary.domains, icon: Globe2, tone: 'indigo' },
    { label: 'Mailboxes', value: summary.mailboxes, icon: Mail, tone: 'cyan' },
    { label: 'Healthy mailboxes', value: summary.healthyMailboxes, icon: CheckCircle2, tone: 'green' },
    { label: 'With issues', value: summary.issueMailboxes, icon: CircleAlert, tone: 'amber' },
  ];
  return <><div className="page-heading"><div><div className="eyebrow">WORKSPACE OVERVIEW</div><h1>Dashboard</h1><p>Keep every project and mailbox in view.</p></div><Link href="/projects" className="primary-button">Manage projects <ArrowRight size={17}/></Link></div>
    <div className="dashboard-intro"><div className="intro-icon"><Activity size={22}/></div><div><strong>Your mail operations, at a glance</strong><p>Connect projects and register domains to start building your workspace.</p></div><Link href="/projects">Get started <ArrowRight size={15}/></Link></div>
    <div className="section-heading"><h2>Overview</h2><span>Live registry counts</span></div><div className="stats-grid">{cards.map((card) => <div className="stat-card" key={card.label}><div className={`stat-icon ${card.tone}`}><card.icon size={20}/></div><span>{card.label}</span><strong>{card.value}</strong></div>)}</div>
    <div className="section-heading operations-heading"><h2>Message activity</h2><span>Available when sending and sync are enabled</span></div><div className="activity-stats"><div><Send size={18}/><span>Sent today</span><strong>—</strong></div><div><Inbox size={18}/><span>Received today</span><strong>—</strong></div><div><Clock3 size={18}/><span>Queued</span><strong>—</strong></div><div><CircleAlert size={18}/><span>Failed</span><strong>—</strong></div></div>
    <div className="dashboard-panels"><section className="panel"><div className="panel-title"><div><h2>Mailbox health</h2><p>Connection status across registered mailboxes</p></div><ShieldCheck size={19}/></div>{summary.mailboxes === 0 ? <div className="empty-mini"><div className="empty-icon"><Mail size={22}/></div><strong>No mailboxes registered</strong><p>Register a mailbox to see its health here.</p><Link href="/mailboxes">View mailboxes <ArrowRight size={14}/></Link></div> : <div className="health-breakdown"><span><i className="dot green"/> Healthy <strong>{summary.healthyMailboxes}</strong></span><span><i className="dot amber"/> Issues <strong>{summary.issueMailboxes}</strong></span><span><i className="dot gray"/> Unknown or disabled <strong>{summary.mailboxes - summary.healthyMailboxes - summary.issueMailboxes}</strong></span></div>}</section><section className="panel"><div className="panel-title"><div><h2>Recent activity</h2><p>Changes made in your workspace</p></div><Activity size={19}/></div>{summary.recentActivity.length === 0 ? <div className="empty-mini"><div className="empty-icon"><Activity size={22}/></div><strong>No activity yet</strong><p>Updates to your workspace will appear here.</p></div> : <div className="timeline">{summary.recentActivity.map((item) => <div key={item.id}><span className="timeline-dot"/><p><strong>{item.user?.name ?? 'System'}</strong> {item.action.replace('.', ' ')}<small>{new Date(item.createdAt).toLocaleString()}</small></p></div>)}</div>}</section></div>
    <section className="panel system-panel"><div className="panel-title"><div><h2>System status</h2><p>Current infrastructure connectivity</p></div><Server size={19}/></div><div className="system-items"><div><span className={`status-indicator ${health?.database === 'connected' ? 'online' : 'offline'}`}/><span>PostgreSQL</span><strong>{health?.database ?? 'Unavailable'}</strong></div><div><span className={`status-indicator ${health?.redis === 'connected' ? 'online' : 'offline'}`}/><span>Redis</span><strong>{health?.redis ?? 'Unavailable'}</strong></div><div><span className="status-indicator pending"/><span>Mail processing</span><strong>Not configured</strong></div></div></section>
  </>;
}
