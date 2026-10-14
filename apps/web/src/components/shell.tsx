'use client';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Activity, ChevronDown, CodeXml, FileText, FolderKanban, Globe2, Inbox, LayoutDashboard, LogOut, Mail, MailSearch, Menu, MoreHorizontal, PanelLeftClose, Paperclip, Send, Settings2, ShieldCheck, SlidersHorizontal, Star, X, ServerCog, UsersRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { RoleProvider, type WorkspaceRole } from './access-context';

const primaryMail: [string, string, LucideIcon][] = [['Dashboard','/dashboard',LayoutDashboard],['Inbox','/inbox',Inbox],['Sent','/sent',Send],['Drafts','/drafts',FileText],['Outgoing Mail','/outgoing-mail',Send]];
const secondaryMail: [string, string, LucideIcon][] = [['Unified Inbox','/unified',Inbox],['Search','/search',MailSearch],['Unread','/unread',Mail],['Flagged','/flagged',Star],['Attachments','/attachments',Paperclip]];
const manage: [string, string, LucideIcon][] = [['Projects','/projects',FolderKanban],['Domains','/domains',Globe2],['Mailboxes','/mailboxes',Mail],['Users','/users',UsersRound],['API Keys','/api-keys',CodeXml],['Templates','/templates',SlidersHorizontal]];
const system: [string, string, LucideIcon][] = [['Mail Servers','/mail-servers',Settings2],['cPanel Accounts','/cpanel-accounts',ServerCog],['Monitoring','/monitoring',Activity],['Logs','/logs',ShieldCheck],['Settings','/settings',Settings2]];
const all = [...primaryMail, ...secondaryMail, ...manage, ...system];
function isActive(path: string, href: string) { return path === href || path.startsWith(`${href}/`); }
function NavGroup({ title, items, path, close }: { title: string; items: [string,string,LucideIcon][]; path: string; close: () => void }) {
  return <div className="nav-group"><div className="nav-caption">{title}</div>{items.map(([label, href, Icon]) => { const active = isActive(path, href); return <Link key={href} href={href} title={label} onClick={close} aria-current={active ? 'page' : undefined} className={`nav-link ${active ? 'active' : ''}`}><Icon size={18} strokeWidth={1.8} aria-hidden="true"/><span>{label}</span></Link>; })}</div>;
}
function MailNav({ path, close }: { path: string; close: () => void }) {
  const nestedActive = secondaryMail.some(([, href]) => isActive(path, href));
  const [moreOpen, setMoreOpen] = useState(nestedActive);
  return <div className="nav-group"><div className="nav-caption">MAIL</div>
    {primaryMail.map(([label, href, Icon]) => <Link key={href} href={href} title={label} onClick={close} aria-current={isActive(path, href) ? 'page' : undefined} className={`nav-link ${isActive(path, href) ? 'active' : ''}`}><Icon size={18} strokeWidth={1.8} aria-hidden="true"/><span>{label}</span></Link>)}
    <button type="button" className={`nav-link nav-more-trigger ${nestedActive ? 'active-parent' : ''}`} title="More mail views" aria-controls="mail-more-links" aria-expanded={moreOpen} onClick={() => setMoreOpen(open => !open)}><MoreHorizontal size={18} strokeWidth={1.8} aria-hidden="true"/><span>More</span><ChevronDown className={`nav-more-chevron ${moreOpen ? 'open' : ''}`} size={15} aria-hidden="true"/></button>
    <div id="mail-more-links" className={`nav-more-panel ${moreOpen ? 'open' : ''}`} aria-hidden={!moreOpen} inert={!moreOpen}><div className="nav-more-panel-inner">
      {secondaryMail.map(([label, href, Icon]) => <Link key={href} href={href} title={label} onClick={close} aria-current={isActive(path, href) ? 'page' : undefined} className={`nav-link nav-more-link ${isActive(path, href) ? 'active' : ''}`}><Icon size={18} strokeWidth={1.8} aria-hidden="true"/><span>{label}</span></Link>)}
    </div></div>
  </div>;
}
export function Shell({ user, children }: { user: { name: string; email: string; role: WorkspaceRole }; children: React.ReactNode }) {
  const path = usePathname(); const router = useRouter(); const [mobile, setMobile] = useState(false); const [collapsed, setCollapsed] = useState(false); const [profile, setProfile] = useState(false); const profileRef = useRef<HTMLDivElement>(null); const menuButtonRef = useRef<HTMLButtonElement>(null); const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (mobile) closeButtonRef.current?.focus(); }, [mobile]);
  useEffect(() => { function onKey(event: KeyboardEvent) { if (event.key === 'Escape') { if (mobile) menuButtonRef.current?.focus(); setMobile(false); setProfile(false); } } function onPointer(event: PointerEvent) { if (profileRef.current && !profileRef.current.contains(event.target as Node)) setProfile(false); } document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onPointer); return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); }; }, [mobile]);
  async function logout() { await fetch('/api/v1/auth/logout', { method: 'POST' }); router.replace('/login'); router.refresh(); }
  const globalAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';
  const visibleManage = manage.filter(([, href]) => globalAdmin || user.role === 'MANAGER' && ['/projects','/domains','/mailboxes'].includes(href));
  const visibleSystem = system.filter(([, href]) => href === '/settings' || href === '/monitoring' || user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' && href !== '/mail-servers' && href !== '/cpanel-accounts' && href !== '/logs');
  const pageTitle = path.includes('/folders/') ? 'Webmail' : all.find(([, href]) => path === href || path.startsWith(`${href}/`))?.[0] ?? 'Dashboard';
  return <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}><a className="skip-link" href="#main-content">Skip to content</a>
    {mobile && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobile(false)}/>}
    <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`} aria-label="Workspace sidebar"><div className="sidebar-top"><Link href="/dashboard" className="brand" onClick={() => setMobile(false)}><span className="brand-icon"><Mail size={21} aria-hidden="true"/></span><span className="brand-copy"><strong>Uni Mail Hub</strong><small>CONTROL CENTER</small></span></Link><button ref={closeButtonRef} className="mobile-close icon-button" onClick={() => { setMobile(false); menuButtonRef.current?.focus(); }} aria-label="Close navigation"><X size={20}/></button></div><div className="workspace-switch"><span className="workspace-avatar">U</span><span className="workspace-copy"><strong>Uni Mail Hub</strong><small>Workspace</small></span></div><nav aria-label="Main navigation"><MailNav key={path} path={path} close={() => setMobile(false)}/>{visibleManage.length > 0 && <NavGroup title="MANAGEMENT" items={visibleManage} path={path} close={() => setMobile(false)}/>}<NavGroup title="SYSTEM" items={visibleSystem} path={path} close={() => setMobile(false)}/></nav><div className="sidebar-bottom"><button className="collapse-button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed}><PanelLeftClose size={18} aria-hidden="true"/><span>{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</span></button></div></aside>
    <div className="main-area"><header className="topbar"><div className="topbar-left"><button ref={menuButtonRef} className="mobile-menu icon-button" aria-label="Open navigation" aria-expanded={mobile} onClick={() => setMobile(true)}><Menu size={21}/></button><span className="topbar-location">Workspace <span>/</span> <strong>{pageTitle}</strong></span></div><div className="topbar-actions"><div className="profile-wrap" ref={profileRef}><button className="profile-button" onClick={() => setProfile(!profile)} aria-label="Open account menu" aria-expanded={profile} aria-haspopup="true"><span className="profile-avatar">{user.name.slice(0,1).toUpperCase()}</span><span className="profile-name">{user.name}<small>{user.role.replace('_',' ')}</small></span><ChevronDown size={15} aria-hidden="true"/></button>{profile && <div className="profile-menu"><div className="profile-menu-head"><strong>{user.name}</strong><small>{user.email}</small></div><button onClick={() => void logout()}><LogOut size={16} aria-hidden="true"/>Sign out</button></div>}</div></div></header><RoleProvider value={user.role}><main className="content" id="main-content">{children}</main></RoleProvider></div>
  </div>;
}
