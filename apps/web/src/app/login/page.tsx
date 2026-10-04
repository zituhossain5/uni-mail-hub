'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, AtSign, LockKeyhole, Mail } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setLoading(true);
    const fields = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: fields.get('email'), password: fields.get('password') }) });
      if (!response.ok) { const body = await response.json(); setError(body.message ?? 'Sign in failed'); return; }
      router.replace('/dashboard'); router.refresh();
    } catch { setError('Unable to reach the server. Please try again.'); }
    finally { setLoading(false); }
  }
  return <main className="login-page">
    <section className="login-art" aria-hidden="true"><div className="login-art-inner"><div className="login-mark"><Mail size={34}/></div><p className="eyebrow light">ONE CLEAR VIEW</p><h1>Every mailbox.<br/>One command center.</h1><p>Bring your projects, domains, and mail operations into focus.</p><div className="login-orbit orbit-one"/><div className="login-orbit orbit-two"/></div><div className="login-art-foot">UNI MAIL HUB <span>•</span> WORKSPACE PLATFORM</div></section>
    <section className="login-form-side"><div className="login-form-wrap"><div className="login-mobile-brand"><span className="brand-icon"><Mail size={21}/></span> Uni Mail Hub</div><p className="eyebrow">WELCOME BACK</p><h2>Sign in to your workspace</h2><p className="muted login-subtitle">Enter your administrator credentials to continue.</p><form onSubmit={submit} className="login-form"><label>Email address<div className="input-icon"><AtSign size={18}/><input type="email" name="email" autoComplete="username" placeholder="admin@example.com" required/></div></label><label>Password<div className="input-icon"><LockKeyhole size={18}/><input type="password" name="password" autoComplete="current-password" placeholder="Enter your password" required/></div></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button login-button" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'} <ArrowRight size={18}/></button></form><p className="login-note">Access is managed by your workspace administrator.</p></div></section>
  </main>;
}
