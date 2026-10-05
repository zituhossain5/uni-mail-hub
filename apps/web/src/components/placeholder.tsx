import Link from 'next/link';
import { ArrowRight, Construction, Mail } from 'lucide-react';
import { PageHeader } from './ui';

const names: Record<string, string> = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', 'api-keys': 'API Keys', templates: 'Templates', monitoring: 'Monitoring', logs: 'Logs', settings: 'Settings' };
export function Placeholder({ section }: { section: string }) {
  const title = names[section] ?? section;
  return <><PageHeader eyebrow="WORKSPACE" title={title} description="This area is planned for a future development phase."/><div className="coming-panel"><div className="coming-icon"><Construction size={29} aria-hidden="true"/></div><div className="coming-kicker">COMING SOON</div><h2>{title} is on the roadmap</h2><p>Project, mailbox, connectivity, and outgoing mail management are available now. This section will arrive in a later module.</p><Link href="/dashboard" className="secondary-button"><Mail size={16} aria-hidden="true"/> Back to dashboard <ArrowRight size={15} aria-hidden="true"/></Link></div></>;
}
