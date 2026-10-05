'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Dialog({ open, title, description, children, footer, onClose, dismissible = true, size = 'default' }: { open: boolean; title: string; description?: string; children: ReactNode; footer?: ReactNode; onClose: () => void; dismissible?: boolean; size?: 'default' | 'wide' }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (!dialog) return; if (open && !dialog.open) dialog.showModal(); else if (!open && dialog.open) dialog.close(); }, [open]);
  return <dialog ref={ref} className={`app-dialog ${size === 'wide' ? 'app-dialog-wide' : ''}`} aria-label={title} onKeyDown={event => { if (event.key === 'Escape') { if (!dismissible) event.preventDefault(); else onClose(); } }} onCancel={event => { if (!dismissible) event.preventDefault(); else onClose(); }} onClose={() => { if (open && dismissible) onClose(); }}>
    <div className="dialog-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{dismissible && <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button>}</div>
    <div className="dialog-content">{children}</div>{footer && <div className="dialog-footer">{footer}</div>}
  </dialog>;
}

export function ConfirmDialog({ open, title, description, confirmLabel, onConfirm, onClose, busy = false, destructive = true }: { open: boolean; title: string; description: string; confirmLabel: string; onConfirm: () => void; onClose: () => void; busy?: boolean; destructive?: boolean }) {
  return <Dialog open={open} title={title} description={description} onClose={onClose} footer={<><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={destructive ? 'danger-button' : 'primary-button'} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button></>}><p className="confirm-note">{destructive ? 'This action may affect connected applications.' : 'Review the details before continuing.'}</p></Dialog>;
}
