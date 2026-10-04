import Link from 'next/link';
import { ArrowRight, Construction, Mail } from 'lucide-react';

const names: Record<string, string> = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', 'api-keys': 'API Keys', templates: 'Templates', monitoring: 'Monitoring', logs: 'Logs', settings: 'Settings' };
export function Placeholder({ section }: { section: string }) {
  const title = names[section] ?? section;
  return <><div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>{title}</h1><p>This area is prepared for the next development phase.</p></div></div><div className="coming-panel"><div className="coming-icon"><Construction size={29}/></div><div className="coming-kicker">COMING SOON</div><h2>{title} is on the roadmap</h2><p>Uni Mail Hub is starting with a secure registry for projects, domains, and mailboxes. This feature will be available as mail operations are added.</p><Link href="/dashboard" className="secondary-button"><Mail size={16}/> Back to dashboard <ArrowRight size={15}/></Link></div></>;
}
