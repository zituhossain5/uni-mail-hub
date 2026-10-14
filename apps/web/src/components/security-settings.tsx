'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from './ui';

type Session = { id: string; createdAt: string; lastUsedAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null; current: boolean };
type Status = { lastLoginAt: string | null; sessions: Session[] };

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/v1/auth/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? 'Security request failed');
  return value as T;
}

export function SecuritySettings() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changeCurrent, setChangeCurrent] = useState('');
  const [changeNext, setChangeNext] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => { setStatus(await request<Status>('security')); }, []);
  useEffect(() => { void request<Status>('security').then(setStatus).catch(() => setError('Security settings are unavailable.')); }, []);
  async function act(fn: () => Promise<void>) { setError(''); setNotice(''); setBusy(true); try { await fn(); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Security request failed'); } finally { setBusy(false); } }
  return <><PageHeader eyebrow="SETTINGS / SECURITY" title="Security" description="Manage your password and active sessions."/>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <section className="panel security-panel"><div className="panel-title"><div><h2>Change password</h2><p>Confirm your current password to make a change.</p></div></div><div className="security-body security-stack"><p>Last login: {status?.lastLoginAt ? new Date(status.lastLoginAt).toLocaleString() : 'Never'}</p><label>Current password<input type="password" value={changeCurrent} onChange={event => setChangeCurrent(event.target.value)} autoComplete="current-password"/></label><label>New password (at least 16 characters)<input type="password" value={changeNext} onChange={event => setChangeNext(event.target.value)} autoComplete="new-password"/></label><button className="primary-button" disabled={busy || !changeCurrent || changeNext.length < 16} onClick={() => void act(async () => { await request('password/change', { currentPassword: changeCurrent, newPassword: changeNext }); setChangeCurrent(''); setChangeNext(''); setNotice('Password changed. Other sessions were signed out.'); })}>Change password</button></div></section>
    <section className="panel security-panel"><div className="panel-title"><div><h2>Active sessions</h2><p>Revoke a session to require a new sign-in.</p></div><button className="secondary-button" disabled={busy} onClick={() => void act(async () => { await request('sessions/revoke-others', {}); })}>Revoke other sessions</button></div><div className="security-body">{status?.sessions.length ? status.sessions.map(session => <div className="security-session" key={session.id}><div><strong>{session.current ? 'This session' : session.userAgent || 'Unknown device'}</strong><small>{session.ipAddress || 'Unknown IP'} · Started {new Date(session.createdAt).toLocaleString()} · Last used {new Date(session.lastUsedAt).toLocaleString()}</small></div><button className="secondary-button" disabled={busy} onClick={() => void act(async () => { const result = await request<{ current: boolean }>('sessions/' + session.id + '/revoke', {}); if (result.current) { router.replace('/login'); router.refresh(); } })}>Revoke</button></div>) : <p>No active sessions.</p>}</div></section>
  </>;
}
