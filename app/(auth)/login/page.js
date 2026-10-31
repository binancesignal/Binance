'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import '../../globals.css';
import AuthShell from '../../../components/AuthShell.js';
import NexoraSplashScreen from '../../../components/NexoraSplashScreen.js';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if (!redirecting) return undefined;
    const t = setTimeout(() => setRedirecting(false), 10000);
    return () => clearTimeout(t);
  }, [redirecting]);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      setRedirecting(true);
      router.replace('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {redirecting && <NexoraSplashScreen />}
      <AuthShell
        mode="login"
        title="Login"
        subtitle={<>New here? <a href="/signup">Open an account</a></>}
      >
        {error && <div className="auth-error" role="alert">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="form-group">
            <input
              id="email"
              className="form-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              autoComplete="email"
            />
          </div>
          <div className="form-group">
            <div className="auth-pw">
              <input
                id="password"
                className="form-input"
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                className="auth-pw-toggle"
                aria-label={showPw ? 'Hide password' : 'Show password'}
                onClick={() => setShowPw((v) => !v)}
              >
                {showPw ? '🙈' : '👁'}
              </button>
            </div>
          </div>
          <a className="auth-link" href="/support">Forgot your password?</a>
          <button className="btn btn-primary" type="submit" disabled={busy || redirecting}>
            {busy || redirecting ? 'Signing in…' : 'Login'}
          </button>
        </form>
      </AuthShell>
    </>
  );
}
