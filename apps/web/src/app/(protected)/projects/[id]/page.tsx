import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Globe2, Mail } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { ProjectWebhooks } from '@/components/project-webhooks';
import { ProjectSuppressions } from '@/components/project-suppressions';
import { ProjectIntegration } from '@/components/project-integration';

type Project = { id: string; name: string; slug: string; description: string | null; status: string; domains: { id: string; domain: string; status: string }[]; mailboxes: { id: string; email: string; status: string }[] };
const tabs = ['Overview', 'Integration', 'Inbox', 'Sent', 'Mailboxes', 'Domains', 'API', 'Webhooks', 'Suppressions', 'Activity', 'Settings'];

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab = 'Overview' } = await searchParams;
  const project = await apiGet<Project>(`projects/${id}`);
  if (!project) notFound();
  const active = tabs.includes(tab) ? tab : 'Overview';
  return <div className="detail-page">
    <PageHeader eyebrow={<><Link href="/projects">PROJECTS</Link> / OVERVIEW</>} title={project.name} description={<>{project.description || 'No description added'} <span className="muted">· {project.slug}</span></>} status={<StatusBadge status={project.status}/>} actions={<Link href="/projects" className="secondary-button">All projects</Link>}/>
    <nav className="tabs" aria-label="Project sections">{tabs.map(name => <Link key={name} aria-current={active === name ? 'page' : undefined} className={active === name ? 'selected' : ''} href={`/projects/${id}?tab=${name}`}>{name}</Link>)}</nav>
    {active === 'Integration' ? <ProjectIntegration projectId={id} publicBaseUrl={(process.env.UNI_MAIL_HUB_PUBLIC_URL ?? (process.env.NODE_ENV === 'production' ? '' : process.env.API_URL ?? '')).replace(/\/$/, '')} environment={process.env.NODE_ENV === 'production' ? 'Production' : 'Local development'}/> : active === 'Webhooks' ? <ProjectWebhooks projectId={id}/> : active === 'Suppressions' ? <ProjectSuppressions projectId={id}/> : active === 'Overview' ? <>
      <div className="project-overview-grid"><div className="project-metric"><Globe2 size={20}/><span>Domains</span><strong>{project.domains.length}</strong></div><div className="project-metric"><Mail size={20}/><span>Mailboxes</span><strong>{project.mailboxes.length}</strong></div></div>
      <div className="dashboard-panels"><section className="panel project-list"><div className="panel-title"><div><h2>Domains</h2><p>Domains assigned to this project</p></div><Link href="/domains">Manage <ArrowRight size={14}/></Link></div>{project.domains.length ? project.domains.map(domain => <div className="project-list-row" key={domain.id}><Globe2 size={17}/><span>{domain.domain}</span><StatusBadge status={domain.status}/></div>) : <EmptyState icon={Globe2} title="No domains yet" description="Add a domain to prepare mailbox registration." action={<Link href="/domains" className="secondary-button">Manage domains</Link>}/>}</section>
        <section className="panel project-list"><div className="panel-title"><div><h2>Mailboxes</h2><p>Mailboxes assigned to this project</p></div><Link href="/mailboxes">Manage <ArrowRight size={14}/></Link></div>{project.mailboxes.length ? project.mailboxes.map(mailbox => <div className="project-list-row" key={mailbox.id}><Mail size={17}/><Link href={`/mailboxes/${mailbox.id}`}>{mailbox.email}</Link><StatusBadge status={mailbox.status}/></div>) : <EmptyState icon={Mail} title="No mailboxes yet" description="Register a mailbox after adding a domain." action={<Link href="/mailboxes" className="secondary-button">Manage mailboxes</Link>}/>}</section></div>
    </> : <div className="coming-panel compact"><span className="coming-kicker">COMING SOON</span><h2>{active} for {project.name}</h2><p>This project section is planned for a future development phase.</p></div>}
  </div>;
}
