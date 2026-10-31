'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import '../../globals.css';
import AuthShell from '../../../components/AuthShell.js';
import NexoraSplashScreen from '../../../components/NexoraSplashScreen.js';

function SignupForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [referral, setReferral] = useState(search?.get('ref') || '');
  const [showRef, setShowRef] = useState(!!search?.get('ref'));
  const [marketing, setMarketing] = useState(false);
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
        body: JSON.stringify({
          email,
          password,
          referralCode: referral || undefined,
          marketingOptIn: marketing,
        }),
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
      mode="signup"
      title="Let's get you registered!"
      subtitle={<>Already have an account? <a href="/login">Login</a></>}
    >
      {error && <div className="auth-error" role="alert">{error}</div>}
      <form onSubmit={onSubmit}>
        <div className="form-group">
          <input
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
              className="form-input"
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              minLength={6}
              autoComplete="new-password"
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

        {!showRef ? (
          <p className="xm-sub" style={{ marginTop: 0, marginBottom: 12 }}>
            Have a partner or referral code?{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setShowRef(true); }}>Enter here</a>
          </p>
        ) : (
          <div className="form-group">
            <input
              className="form-input"
              type="text"
              value={referral}
              onChange={(e) => setReferral(e.target.value)}
              placeholder="Referral code (optional)"
              autoComplete="off"
            />
          </div>
        )}

        <label className="xm-check">
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
          <span>
            I consent to receiving marketing communications and to the use of my data for
            marketing optimization and ad personalization purposes. My consent may be withdrawn at any time.
          </span>
        </label>

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Creating account…' : 'Register'}
        </button>

        <p className="xm-legal">
          By registering, I declare that I have carefully read and fully understood the terms of use
          and privacy policy, and I agree to be bound by them.
        </p>
      </form>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<NexoraSplashScreen />}>
      <SignupForm />
    </Suspense>
  );
}
