'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import '../../globals.css';
import AuthShell from '../../../components/AuthShell.js';

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState('');

  useEffect(() => {
    const r = searchParams?.get('ref');
    if (r) setRef(String(r).trim().toUpperCase());
  }, [searchParams]);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, ref: ref || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      router.replace('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Start your free trial"
      subtitle="7 days free. No card required."
      footer={<>Already have an account? <a href="/login">Sign in</a></>}
    >
      {error && <div className="auth-error" role="alert">{error}</div>}
      {ref && (
        <div className="form-hint" style={{ marginBottom: 12 }}>
          Referral code: <b>{ref}</b>
        </div>
      )}
      <form onSubmit={onSubmit}>
        <div className="form-group">
          <label className="form-label" htmlFor="email">Email</label>
          <input
            id="email"
            className="form-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@email.com"
            required
            autoComplete="email"
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="password">Password</label>
          <div className="auth-pw">
            <input
              id="password"
              className="form-input"
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              required
              minLength={8}
              autoComplete="new-password"
            />
            <button type="button" className="auth-pw-toggle" onClick={() => setShowPw((v) => !v)}>
              {showPw ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="auth-loading" style={{ padding: 40, textAlign: 'center' }}>Loading…</div>}>
      <SignupForm />
    </Suspense>
  );
}
