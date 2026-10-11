'use client';
import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { PageHeader } from './ui';

type Session = { id: string; createdAt: string; lastUsedAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null; current: boolean };
type Status = { twoFactorEnabled: boolean; recoveryCodeCount: number; lastLoginAt: string | null; sessions: Session[] };
type Setup = { secret: string; qrCodeDataUrl: string };

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/v1/auth/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? 'Security request failed');
  return value as T;
}

export function SecuritySettings() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changeCurrent, setChangeCurrent] = useState('');
  const [changeNext, setChangeNext] = useState('');
  const [changeCode, setChangeCode] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => { setStatus(await request<Status>('security')); }, []);
  useEffect(() => { void request<Status>('security').then(setStatus).catch(() => setError('Security settings are unavailable.')); }, []);
  async function act(fn: () => Promise<void>) { setError(''); setNotice(''); setBusy(true); try { await fn(); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Security request failed'); } finally { setBusy(false); } }
  return <><PageHeader eyebrow="SETTINGS / SECURITY" title="Security" description="Manage two-factor authentication and active sessions."/>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <section className="panel security-panel"><div className="panel-title"><div><h2>Two-factor authentication</h2><p>{status?.twoFactorEnabled ? 'Enabled' : 'Add an authenticator app before production use.'}</p></div></div>
      <div className="security-body"><p>Last login: {status?.lastLoginAt ? new Date(status.lastLoginAt).toLocaleString() : 'Never'} · Recovery codes remaining: {status?.recoveryCodeCount ?? '—'}</p>
        {!status?.twoFactorEnabled && !setup && <div className="security-stack"><label>Confirm password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password"/></label><button className="primary-button" disabled={busy || !password} onClick={() => void act(async () => { setSetup(await request<Setup>('2fa/setup', { password })); setPassword(''); })}>Set up 2FA</button></div>}
        {setup && <div className="security-stack"><p>Scan this QR code with your authenticator app. The secret is shown only during setup.</p><Image src={setup.qrCodeDataUrl} unoptimized alt="Authenticator setup QR code" width={190} height={190}/><code>{setup.secret}</code><label>Verification code<input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code"/></label><button className="primary-button" disabled={busy} onClick={() => void act(async () => { const result = await request<{ recoveryCodes: string[] }>('2fa/verify', { code }); setCodes(result.recoveryCodes); setSetup(null); setCode(''); })}>Verify and enable</button></div>}
        {codes.length > 0 && <div className="security-stack"><strong>Save these recovery codes now. They cannot be viewed again.</strong><div className="security-codes">{codes.map(value => <code key={value}>{value}</code>)}</div><button className="secondary-button" onClick={() => setCodes([])}>I saved these codes</button></div>}
        {status?.twoFactorEnabled && <div className="security-stack"><p>To regenerate recovery codes, enter your password and a current authenticator or recovery code. Existing recovery codes will stop working.</p><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password"/></label><label>Verification code<input value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code"/></label><div className="security-actions"><button className="secondary-button" disabled={busy || !password || !code} onClick={() => void act(async () => { const result = await request<{ recoveryCodes: string[] }>('2fa/recovery-codes', { password, code }); setCodes(result.recoveryCodes); setCode(''); setPassword(''); })}>Regenerate recovery codes</button><button className="secondary-button" disabled={busy || !password || !code} onClick={() => void act(async () => { await request('2fa/disable', { password, code }); setCode(''); setPassword(''); })}>Disable 2FA</button></div></div>}
      </div></section>
    {status?.twoFactorEnabled && <section className="panel security-panel"><div className="panel-title"><div><h2>Change administrator password</h2><p>Confirm your current password and an authenticator or recovery code.</p></div></div><div className="security-body security-stack"><label>Current password<input type="password" value={changeCurrent} onChange={event => setChangeCurrent(event.target.value)} autoComplete="current-password"/></label><label>New password (at least 16 characters)<input type="password" value={changeNext} onChange={event => setChangeNext(event.target.value)} autoComplete="new-password"/></label><label>Verification or recovery code<input value={changeCode} onChange={event => setChangeCode(event.target.value)} autoComplete="one-time-code"/></label><button className="primary-button" disabled={busy || !changeCurrent || changeNext.length < 16 || !changeCode} onClick={() => void act(async () => { await request('password/change', { currentPassword: changeCurrent, newPassword: changeNext, code: changeCode }); setChangeCurrent(''); setChangeNext(''); setChangeCode(''); setNotice('Password changed. Other sessions were signed out.'); })}>Change password</button></div></section>}
    <section className="panel security-panel"><div className="panel-title"><div><h2>Active sessions</h2><p>Revoke a session to require a new sign-in.</p></div><button className="secondary-button" disabled={busy} onClick={() => void act(async () => { await request('sessions/revoke-others', {}); })}>Revoke other sessions</button></div><div className="security-body">{status?.sessions.length ? status.sessions.map(session => <div className="security-session" key={session.id}><div><strong>{session.current ? 'This session' : session.userAgent || 'Unknown device'}</strong><small>{session.ipAddress || 'Unknown IP'} · Started {new Date(session.createdAt).toLocaleString()} · Last used {new Date(session.lastUsedAt).toLocaleString()}</small></div><button className="secondary-button" disabled={busy} onClick={() => void act(async () => { const result = await request<{ current: boolean }>('sessions/' + session.id + '/revoke', {}); if (result.current) { router.replace('/login'); router.refresh(); } })}>Revoke</button></div>) : <p>No active sessions.</p>}</div></section>
  </>;
}
