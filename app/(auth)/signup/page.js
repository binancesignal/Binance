'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import '../../globals.css';
import AuthShell from '../../../components/AuthShell.js';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
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
