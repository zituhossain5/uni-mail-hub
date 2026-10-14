'use client';
import { FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import './users.css';

export function InviteAccept() {
  const token = useRef('');
  const [invite, setInvite] = useState<{ name: string; email: string; expiresAt: string } | null>(null);
  const [error, setError] = useState(''); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState('');
  useEffect(() => {
    const value = window.location.hash.slice(1);
    window.history.replaceState(null, '', '/invite');
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(value)) { void Promise.resolve().then(() => setError('This invitation is unavailable or expired.')); return; }
    token.current = value;
    void fetch('/api/v1/invitations/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: value }), cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error('This invitation is unavailable or expired.'); setInvite(await response.json()); })
      .catch(cause => setError(cause instanceof Error ? cause.message : 'Invitation unavailable'));
  }, []);
  async function accept(event: FormEvent) {
    event.preventDefault(); setError('');
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/v1/invitations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token.current, password, confirmPassword }) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.message || 'Invitation could not be accepted.'); }
      setPassword(''); setConfirmPassword(''); token.current = ''; setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invitation could not be accepted.'); } finally { setBusy(false); }
  }
  return <main className="login-form-panel" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '1.5rem' }}><div style={{ width: 'min(100%, 30rem)' }}><p className="eyebrow">UNI MAIL HUB</p><h1>{done ? 'Account ready' : 'Accept invitation'}</h1>{done ? <><p>Your password is set. You can sign in now.</p><Link className="primary-button" href="/login">Sign in</Link></> : invite ? <><p>Welcome, {invite.name}. Set a password for {invite.email}.</p><form className="users-form" onSubmit={event => void accept(event)}><label>Password<input type="password" autoComplete="new-password" minLength={16} maxLength={256} required value={password} onChange={event => setPassword(event.target.value)}/></label><label>Confirm password<input type="password" autoComplete="new-password" minLength={16} maxLength={256} required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)}/></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? 'Activating…' : 'Activate account'}</button></form></> : <p role={error ? 'alert' : 'status'}>{error || 'Checking invitation…'}</p>}</div></main>;
}
