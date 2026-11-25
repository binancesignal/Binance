'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import '../../globals.css';
import AuthShell, { BrandMark, useBranding } from '../../../components/AuthShell.js';
import NexoraSplashScreen from '../../../components/NexoraSplashScreen.js';
import { COUNTRIES, countryName } from '../../../lib/kyc/countries.js';

const flagOf = (code) =>
  /^[A-Za-z]{2}$/.test(code || '')
    ? String.fromCodePoint(...[...code.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)))
    : '🌍';

const RULES = [
  { id: 'len', label: 'Use 10 - 15 characters', test: (p) => p.length >= 10 && p.length <= 15 },
  { id: 'num', label: 'Use 1 or more numbers', test: (p) => /\d/.test(p) },
  { id: 'low', label: 'Use 1 or more English lower case letters', test: (p) => /[a-z]/.test(p) },
  { id: 'up', label: 'Use 1 or more English upper case letters', test: (p) => /[A-Z]/.test(p) },
  { id: 'sp', label: 'Use 1 or more special characters (#[]()@$&*!?|,.^/\\+_-)', test: (p) => /[^A-Za-z0-9]/.test(p) },
];
const SEG_COLORS = ['#e5e7eb', '#ef4444', '#f59e0b', '#eab308', '#0a9b57'];

const Eye = ({ off }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M4 4l16 16" />}
  </svg>
);
const Tick = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0a9b57" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
const Dot = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c3c9d4" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="5" /></svg>
);

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
.xm-auth-signup,.xm-verify{font-family:'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}
.xm-auth-signup{background:#fff}
.xm-auth-signup .xm-title{font-size:25px;font-weight:600;letter-spacing:-.01em;color:#0b0f1a}
.xm-auth-signup .xm-sub{font-size:15.5px;color:#5b6b83;margin-bottom:30px}
.xm-auth-signup .xm-sub a{color:#1560d8;font-weight:600}
.xf{position:relative;display:block;height:56px;margin-bottom:14px;background:#fff;border:1.5px solid #dfe4f0;border-radius:14px;box-shadow:0 1px 2px rgba(16,24,40,.04);transition:border-color .15s,box-shadow .15s}
.xf:focus-within{border-color:#3b82f6;box-shadow:0 0 0 4px #d8e6ff}
.xf input,.xf select{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;border:0;background:transparent;outline:none;font:inherit;font-size:17px;color:#0b0f1a;padding:20px 52px 0 16px;border-radius:14px;-webkit-appearance:none;appearance:none;box-shadow:none}
.xf input::placeholder{color:transparent}
.xf label{position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:16.5px;color:#7a869c;pointer-events:none;transition:all .13s ease}
.xf input:focus + label,.xf input:not(:placeholder-shown) + label,.xf.is-up label{top:8px;transform:none;font-size:12.5px}
.xf-eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:42px;height:42px;display:inline-flex;align-items:center;justify-content:center;color:#475467;background:none;border:0;cursor:pointer;z-index:2}
.xf-country{display:flex;align-items:flex-end;padding:0 16px 8px 16px}
.xf-country .xf-flag{font-size:26px;line-height:1;margin-right:12px;margin-bottom:3px;flex:none}
.xf-country .xf-val{font-size:17px;color:#0b0f1a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;line-height:1.2}
.xf-country label{left:62px}
.xf-country select{opacity:0;padding:0;z-index:1}
.xf-chev{position:absolute;right:16px;top:50%;transform:translateY(-50%);color:#0b0f1a;pointer-events:none}
.pw-req{margin:22px 0 6px}
.pw-req h3{margin:0 0 14px;font-size:19px;font-weight:500;color:#0b0f1a}
.pw-bars{display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin-bottom:22px}
.pw-bars i{height:5px;border-radius:99px;transition:background .2s}
.pw-best{font-size:16px;font-weight:500;color:#0b0f1a;margin-bottom:12px}
.pw-list{list-style:none;margin:0;padding:0;display:grid;gap:9px}
.pw-list li{display:flex;align-items:flex-start;gap:14px;font-size:15px;line-height:1.35;color:#1f2937}
.pw-list li svg{flex:none;margin-top:1px}
.xm-auth-signup .ref-line{margin:22px 0;font-size:16px;color:#0b0f1a}
.xm-auth-signup .ref-line a{color:#1560d8;font-weight:600;text-decoration:none}
.xm-auth-signup .xm-check{align-items:flex-start;gap:14px;margin:4px 0 24px;font-size:16px;line-height:1.45;color:#0b0f1a}
.xm-auth-signup .xm-check input{appearance:none;-webkit-appearance:none;width:22px;height:22px;margin-top:3px;border:1.5px solid #cfd5e3;border-radius:6px;background:#fff;display:grid;place-content:center;flex:none;cursor:pointer}
.xm-auth-signup .xm-check input:checked{background:#0a9b57;border-color:#0a9b57}
.xm-auth-signup .xm-check input:checked::after{content:'';width:5px;height:10px;border:solid #fff;border-width:0 2.2px 2.2px 0;transform:rotate(45deg) translate(-1px,-1px)}
.xm-auth-signup .btn.btn-primary{height:50px;padding:0;border-radius:12px;font-size:18px;font-weight:600;background:#1570ef;color:#fff}
.xm-auth-signup .btn.btn-primary:disabled{background:#f2f4f7;color:#98a2b3;border:1.5px solid #e4e7ec;cursor:not-allowed}
.xm-auth-signup .xm-legal{font-size:15px;line-height:1.55;color:#6b7a90;margin-top:30px}
.xm-auth-signup .xm-legal a{color:#1560d8;font-weight:600;text-decoration:none}
.xm-auth-signup .auth-error{border-radius:12px}
/* check-your-email screen */
.xm-verify{min-height:100dvh;background:#eff2f8;display:flex;flex-direction:column}
.xm-verify-top{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:14px 24px;padding-top:max(14px,env(safe-area-inset-top))}
.xm-verify-top .x{justify-self:end;width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;color:#0b0f1a;text-decoration:none}
.xm-verify-main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 28px 80px;max-width:520px;margin:0 auto}
.xm-verify-main h1{margin:34px 0 22px;font-size:25px;font-weight:600;color:#000}
.xm-verify-main p{margin:0 0 18px;font-size:17px;line-height:1.55;color:#0b0f1a;word-break:break-word}
.xm-verify-resend{margin-top:10px;background:none;border:0;color:#1560d8;font:inherit;font-weight:600;font-size:16px;cursor:pointer}
.xm-verify-resend:disabled{color:#98a2b3;cursor:default}
.xm-verify-note{font-size:14px!important;color:#5b6b83!important}
`;

function CheckEmail({ email, onClose }) {
  const brand = useBranding();
  const [cool, setCool] = useState(30);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (cool <= 0) return undefined;
    const t = setTimeout(() => setCool((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cool]);
  async function resend() {
    setNote('');
    try {
      const res = await fetch('/api/auth/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await res.json();
      if (res.ok) { setNote('Email sent again.'); setCool(30); } else setNote(d.error || 'Could not send');
    } catch (_) { setNote('Could not send'); }
  }
  return (
    <div className="xm-verify">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="xm-verify-top">
        <span />
        <BrandMark brand={brand} />
        <a className="x" href="/login" aria-label="Close" onClick={(e) => { e.preventDefault(); onClose(); }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
        </a>
      </div>
      <div className="xm-verify-main">
        <svg width="62" height="62" viewBox="0 0 24 24" fill="none" stroke="#1b2538" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2.5" y="4.5" width="19" height="15" rx="3.2" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" />
        </svg>
        <h1>Please check your email.</h1>
        <p>An email has been sent to {email}. Please verify your email address to complete your {brand.appName} profile registration.</p>
        <p>If you do not see the email in a few minutes, check your “junk” or “spam” folder. We make every effort to ensure that these emails are delivered.</p>
        <button type="button" className="xm-verify-resend" disabled={cool > 0} onClick={resend}>
          {cool > 0 ? `Resend email in ${cool}s` : 'Resend email'}
        </button>
        {note && <p className="xm-verify-note">{note}</p>}
      </div>
    </div>
  );
}

function SignupForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [referral, setReferral] = useState(search?.get('ref') || '');
  const [showRef, setShowRef] = useState(!!search?.get('ref'));
  const [marketing, setMarketing] = useState(false);
  const [countryCode, setCountryCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const pwTouched = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/geo', { cache: 'no-store' });
        const data = await res.json();
        if (cancelled || !data?.countryCode) return;
        setCountryCode((prev) => prev || data.countryCode);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  const results = useMemo(() => RULES.map((r) => ({ ...r, ok: r.test(password) })), [password]);
  const score = results.filter((r) => r.ok).length;
  const filled = Math.round((score * 4) / 5);
  const pwOk = score === RULES.length;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const canSubmit = !!countryCode && emailOk && pwOk && !busy;

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          referralCode: referral || undefined,
          ref: referral || undefined,
          marketingOptIn: marketing,
          countryCode,
          country: countryName(countryCode),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      if (data.needsVerification) {
        setSentTo(data.email || email.trim());
        return;
      }
      router.replace('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) return <CheckEmail email={sentTo} onClose={() => router.replace('/login')} />;

  return (
    <AuthShell
      mode="signup"
      title="Let’s get you registered!"
      subtitle={<>Already have an account? <a href="/login">Login</a></>}
    >
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      {error && <div className="auth-error" role="alert">{error}</div>}
      <form onSubmit={onSubmit} noValidate>
        <div className="xf xf-country is-up">
          <span className="xf-flag" aria-hidden="true">{flagOf(countryCode)}</span>
          <label>Country of residence</label>
          <span className="xf-val">{countryCode ? countryName(countryCode) : 'Select country'}</span>
          <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)} aria-label="Country of residence">
            <option value="">Select country…</option>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
          <svg className="xf-chev" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </div>

        <div className="xf">
          <input id="su-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder=" " autoComplete="email" inputMode="email" />
          <label htmlFor="su-email">Email</label>
        </div>

        <div className="xf">
          <input
            id="su-pw"
            type={showPw ? 'text' : 'password'}
            value={password}
            maxLength={15}
            onChange={(e) => { pwTouched.current = true; setPassword(e.target.value); }}
            placeholder=" "
            autoComplete="new-password"
          />
          <label htmlFor="su-pw">Password</label>
          <button type="button" className="xf-eye" aria-label={showPw ? 'Hide password' : 'Show password'} onClick={() => setShowPw((v) => !v)}>
            <Eye off={!showPw} />
          </button>
        </div>

        {password.length > 0 && (
          <div className="pw-req">
            <h3>Password Requirements:</h3>
            <div className="pw-bars" aria-hidden="true">
              {[1, 2, 3, 4].map((n) => <i key={n} style={{ background: n <= filled ? SEG_COLORS[filled] : '#e5e7eb' }} />)}
            </div>
            <div className="pw-best">It’s best practice to include:</div>
            <ul className="pw-list">
              {results.map((r) => (
                <li key={r.id}>{r.ok ? <Tick /> : <Dot />}<span>{r.label}</span></li>
              ))}
            </ul>
          </div>
        )}

        {!showRef ? (
          <p className="ref-line">
            Have a partner or referral code?{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setShowRef(true); }}>Enter here</a>
          </p>
        ) : (
          <div className="xf" style={{ marginTop: 14 }}>
            <input id="su-ref" type="text" value={referral} onChange={(e) => setReferral(e.target.value)} placeholder=" " autoComplete="off" />
            <label htmlFor="su-ref">Partner or referral code</label>
          </div>
        )}

        <label className="xm-check">
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
          <span>I consent to receiving marketing communications and to the use of my data for marketing optimization and ad personalization purposes. My consent may be withdrawn at any time.</span>
        </label>

        <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
          {busy ? 'Creating account…' : 'Register'}
        </button>

        <p className="xm-legal">
          By registering, I declare that I have carefully read, understood and accepted the entire text of the Company&apos;s{' '}
          <a href="#" onClick={(e) => e.preventDefault()}>Legal Documents</a> and{' '}
          <a href="#" onClick={(e) => e.preventDefault()}>Privacy Policy</a>. I further understand that I will receive newsletters, company news, and product updates.
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
