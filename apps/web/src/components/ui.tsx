import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function PageHeader({ eyebrow, title, description, status, actions }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return <header className="page-heading"><div className="page-heading-copy">{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{(status || actions) && <div className="page-heading-actions">{status}{actions}</div>}</header>;
}

const tones: Record<string, string> = {
  ACTIVE: 'success', HEALTHY: 'success', SUCCESS: 'success', CONFIGURED: 'success', SMTP_ACCEPTED: 'success', ACCEPTED: 'success',
  WARNING: 'warning', UNKNOWN: 'neutral', UNVERIFIED: 'warning', PROCESSING: 'info', RUNNING: 'info', QUEUED: 'info', RETRY_SCHEDULED: 'warning', SMTP_ACCEPTED_WITH_REJECTIONS: 'warning', PARTIAL: 'warning',
  ERROR: 'danger', CRITICAL: 'danger', FAILED: 'danger', REVOKED: 'danger', EXPIRED: 'danger', DISABLED: 'neutral', INACTIVE: 'neutral', CANCELLED: 'neutral', PENDING: 'neutral', RESOLVED: 'success', OPEN: 'warning',
};
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`status-badge status-${tones[status.toUpperCase()] ?? 'neutral'}`}><span className="status-badge-dot" aria-hidden="true"/>{label ?? status.replaceAll('_', ' ').toLowerCase()}</span>;
}

export function EmptyState({ icon: Icon, title, description, action }: { icon?: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return <div className="empty-state">{Icon && <span className="empty-state-icon"><Icon size={23} aria-hidden="true"/></span>}<h3>{title}</h3>{description && <p>{description}</p>}{action}</div>;
}

export function DetailField({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return <div className="detail-field"><dt>{label}</dt><dd className={mono ? 'mono' : undefined}>{children ?? '—'}</dd></div>;
}

export function SectionCard({ title, description, actions, children, className = '' }: { title: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel section-card ${className}`}><div className="panel-title"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions}</div><div className="panel-body">{children}</div></section>;
}

export function formatDate(value: string | null | undefined, mode: 'short' | 'full' = 'short') {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, mode === 'full' ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date);
}

export function DateTime({ value, mode = 'short' }: { value: string | null | undefined; mode?: 'short' | 'full' }) {
  return value ? <time dateTime={value} title={formatDate(value, 'full')}>{formatDate(value, mode)}</time> : <span>—</span>;
}
