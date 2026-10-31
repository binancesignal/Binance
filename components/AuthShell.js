'use client';

import { useEffect, useState } from 'react';
import { NexoraMark } from './NexoraLogo.js';

const LANGS = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'si', label: 'සිංහල', flag: '🇱🇰' },
];

export function useBranding() {
  const [brand, setBrand] = useState({
    loaded: false,
    logoUrl: null,
    registerBannerUrl: null,
    appName: 'Signal Desk',
  });
  useEffect(() => {
    let alive = true;
    fetch('/api/branding', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setBrand({
          loaded: true,
          logoUrl: d.logoUrl || null,
          registerBannerUrl: d.registerBannerUrl || null,
          appName: d.appName || 'Signal Desk',
        });
      })
      .catch(() => alive && setBrand((b) => ({ ...b, loaded: true })));
    return () => { alive = false; };
  }, []);
  return brand;
}

function BrandMark({ brand }) {
  const [broken, setBroken] = useState(false);
  // Prefer admin-uploaded logo when set; otherwise the NEXORA mark from the splash animation.
  const showImg = brand.logoUrl && !broken;
  return (
    <div className="xm-brand" aria-label={brand.appName || 'NEXORA'}>
      {showImg ? (
        <img className="xm-brand-img" src={brand.logoUrl} alt={brand.appName} onError={() => setBroken(true)} draggable={false} />
      ) : (
        <span className="xm-brand-lockup">
          <NexoraMark className="xm-brand-mark" size={28} title={brand.appName || 'NEXORA'} />
          <span className="xm-brand-text">{brand.appName && brand.appName !== 'Signal Desk' ? brand.appName : 'NEXORA'}</span>
        </span>
      )}
    </div>
  );
}

function LanguageButton() {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState('en');
  useEffect(() => {
    try {
      const s = localStorage.getItem('app_lang');
      if (s === 'en' || s === 'si') setLang(s);
    } catch (_) {}
  }, []);
  const current = LANGS.find((l) => l.code === lang) || LANGS[0];
  function pick(code) {
    setLang(code);
    try { localStorage.setItem('app_lang', code); } catch (_) {}
    setOpen(false);
  }
  return (
    <div className="xm-lang-wrap">
      <button type="button" className="xm-lang-btn" aria-label="Language" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span aria-hidden>{current.flag}</span>
      </button>
      {open && (
        <>
          <button type="button" className="xm-lang-backdrop" aria-label="Close" onClick={() => setOpen(false)} />
          <div className="xm-lang-menu" role="menu">
            {LANGS.map((l) => (
              <button key={l.code} type="button" role="menuitem" className={'xm-lang-item' + (l.code === lang ? ' is-active' : '')} onClick={() => pick(l.code)}>
                <span>{l.flag}</span>
                <span>{l.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AuthTopBar({ brand }) {
  return (
    <header className="xm-topbar">
      <div className="xm-topbar-left">
        <a href="/" className="xm-icon-btn" aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
        </a>
      </div>
      <div className="xm-topbar-center"><BrandMark brand={brand} /></div>
      <div className="xm-topbar-right">
        <a href="/support" className="xm-icon-btn" aria-label="Support" title="Support">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
          </svg>
        </a>
        <LanguageButton />
      </div>
    </header>
  );
}

function RegisterBanner({ brand }) {
  const [broken, setBroken] = useState(false);
  if (!brand.registerBannerUrl || broken) {
    return (
      <div className="xm-banner xm-banner-fallback">
        <div className="xm-banner-fallback-inner">
          <div className="xm-banner-kicker">Welcome</div>
          <div className="xm-banner-title">{brand.appName}</div>
          <div className="xm-banner-sub">Create your account and start trading smarter</div>
        </div>
      </div>
    );
  }
  return (
    <div className="xm-banner">
      <img src={brand.registerBannerUrl} alt="" className="xm-banner-img" onError={() => setBroken(true)} draggable={false} />
    </div>
  );
}

export default function AuthShell({ mode = 'login', title, subtitle, children, footer }) {
  const brand = useBranding();
  const isSignup = mode === 'signup';
  return (
    <div className={'xm-auth xm-auth-' + mode}>
      <style dangerouslySetInnerHTML={{ __html: XM_CSS }} />
      <AuthTopBar brand={brand} />
      <div className="xm-auth-scroll">
        {isSignup && <RegisterBanner brand={brand} />}
        <div className="xm-auth-card">
          {title && <h1 className="xm-title">{title}</h1>}
          {subtitle && <p className="xm-sub">{subtitle}</p>}
          <div className="xm-body">{children}</div>
          {footer && <div className="xm-footer">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

const XM_CSS = `.xm-auth{min-height:100dvh;background:#f4f5f7;color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;display:flex;flex-direction:column}.xm-topbar{position:sticky;top:0;z-index:20;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;padding:10px 12px;padding-top:max(10px,env(safe-area-inset-top));background:#fff;border-bottom:1px solid #e8eaed}.xm-topbar-left,.xm-topbar-right{display:flex;align-items:center;gap:4px}.xm-topbar-right{justify-content:flex-end}.xm-topbar-center{display:flex;justify-content:center;max-width:160px}.xm-icon-btn{width:40px;height:40px;border:0;background:transparent;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;color:#111827;text-decoration:none;cursor:pointer}.xm-icon-btn:active{background:#f3f4f6}.xm-brand{display:flex;align-items:center;justify-content:center;max-width:180px;height:36px}.xm-brand-lockup{display:inline-flex;align-items:center;gap:8px;max-width:180px}.xm-brand-mark{display:block;flex-shrink:0;width:auto;height:28px}.xm-brand-img{max-width:140px;max-height:32px;width:auto;height:auto;object-fit:contain}.xm-brand-text{font-weight:800;font-size:16px;letter-spacing:-.02em;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.xm-lang-wrap{position:relative}.xm-lang-btn{width:40px;height:40px;border:0;background:transparent;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;line-height:1}.xm-lang-btn:active{background:#f3f4f6}.xm-lang-backdrop{position:fixed;inset:0;border:0;background:transparent;z-index:30}.xm-lang-menu{position:absolute;right:0;top:calc(100% + 4px);min-width:160px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.12);padding:6px;z-index:40}.xm-lang-item{width:100%;display:flex;align-items:center;gap:10px;padding:10px 12px;border:0;background:transparent;border-radius:8px;font-size:14px;color:#111827;cursor:pointer;text-align:left}.xm-lang-item.is-active{background:#f3f4f6;font-weight:600}.xm-lang-item:hover{background:#f9fafb}.xm-auth-scroll{flex:1;overflow:auto;-webkit-overflow-scrolling:touch}.xm-banner{width:100%;background:#0b1220;overflow:hidden}.xm-banner-img{display:block;width:100%;height:auto;max-height:180px;object-fit:cover}.xm-banner-fallback{background:linear-gradient(135deg,#0b1220 0%,#1e293b 55%,#0f172a 100%);padding:28px 20px 24px}.xm-banner-fallback-inner{max-width:480px;margin:0 auto;color:#fff}.xm-banner-kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.75;margin-bottom:6px}.xm-banner-title{font-size:26px;font-weight:800;letter-spacing:-.03em;margin-bottom:6px}.xm-banner-sub{font-size:14px;opacity:.85;line-height:1.4}.xm-auth-card{max-width:480px;margin:0 auto;padding:22px 20px 40px;padding-bottom:max(40px,env(safe-area-inset-bottom))}.xm-title{margin:0 0 6px;font-size:26px;font-weight:800;letter-spacing:-.03em;color:#111827}.xm-sub{margin:0 0 20px;font-size:14px;color:#6b7280;line-height:1.45}.xm-sub a{color:#2563eb;text-decoration:none;font-weight:600}.xm-footer{margin-top:18px;font-size:13px;color:#6b7280;text-align:center;line-height:1.45}.xm-footer a{color:#2563eb;text-decoration:none;font-weight:600}.xm-auth .form-group{margin-bottom:14px}.xm-auth .form-label{display:none}.xm-auth .form-input{width:100%;box-sizing:border-box;border:1px solid #e5e7eb;background:#fff;border-radius:12px;padding:16px 14px;font-size:15px;color:#111827;outline:none;transition:border-color .15s,box-shadow .15s}.xm-auth .form-input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}.xm-auth .form-input::placeholder{color:#9ca3af}.xm-auth .auth-pw{position:relative}.xm-auth .auth-pw .form-input{padding-right:48px}.xm-auth .auth-pw-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:transparent;width:36px;height:36px;border-radius:999px;color:#6b7280;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}.xm-auth .auth-error{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:12px;padding:12px 14px;font-size:13px;margin-bottom:14px}.xm-auth .auth-link{display:inline-block;margin:4px 0 16px;color:#2563eb;font-size:14px;font-weight:600;text-decoration:none}.xm-auth .btn{width:100%;border:0;border-radius:12px;padding:15px 16px;font-size:16px;font-weight:700;cursor:pointer}.xm-auth .btn-primary{background:#2563eb;color:#fff}.xm-auth .btn-primary:disabled{background:#93c5fd;cursor:not-allowed}.xm-auth .xm-divider{display:flex;align-items:center;gap:12px;margin:18px 0;color:#9ca3af;font-size:13px}.xm-auth .xm-divider::before,.xm-auth .xm-divider::after{content:"";flex:1;height:1px;background:#e5e7eb}.xm-auth .btn-google{width:100%;border:1px solid #e5e7eb;background:#fff;border-radius:12px;padding:13px 16px;font-size:15px;font-weight:600;color:#111827;display:flex;align-items:center;justify-content:center;gap:10px;cursor:pointer}.xm-auth .xm-check{display:flex;gap:10px;align-items:flex-start;margin:8px 0 16px;font-size:12.5px;color:#6b7280;line-height:1.4}.xm-auth .xm-check input{margin-top:2px;width:16px;height:16px;accent-color:#2563eb;flex-shrink:0}.xm-auth .xm-legal{margin-top:14px;font-size:11.5px;color:#9ca3af;line-height:1.45;text-align:left}@media (min-width:640px){.xm-banner-img{max-height:220px}.xm-auth-card{padding-top:28px}}`;
