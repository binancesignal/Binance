'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import '../../globals.css';
import NexoraSplashScreen from '../../../components/NexoraSplashScreen.js';
import { DEFAULT_SLIDES } from '../../../lib/branding/welcomeSlides.js';

const AUTO_MS = 4500;

/** Built-in artwork used when the admin has not uploaded a photo for a slide. */
function SlideArt({ index }) {
  const v = index % 3;
  return (
    <svg className="wl-art" viewBox="0 0 1080 1140" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id={`wl-bg${v}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E6E9ED" />
          <stop offset="1" stopColor="#F6F7F9" />
        </linearGradient>
        <linearGradient id={`wl-g${v}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2EE5A0" />
          <stop offset="1" stopColor="#0AA567" />
        </linearGradient>
      </defs>
      <rect width="1080" height="1140" fill={`url(#wl-bg${v})`} />
      {v === 0 && (
        <g>
          {[[200, 640, 120, 360], [370, 540, 110, 300], [540, 430, 120, 380], [710, 340, 110, 330]].map(([x, y, w, h], i) => (
            <g key={i}>
              <rect x={x + w / 2 - 4} y={y - 60} width="8" height={h + 120} rx="4" fill="#B9C0C8" />
              <rect x={x} y={y} width={w} height={h} rx="22" fill={i % 2 ? '#C9CFD6' : `url(#wl-g${v})`} />
            </g>
          ))}
          <path d="M150 800 L330 640 L500 700 L680 470 L900 330" fill="none" stroke="#0F172A" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="900" cy="330" r="34" fill="#0F172A" />
        </g>
      )}
      {v === 1 && (
        <g>
          <ellipse cx="540" cy="860" rx="300" ry="86" fill="#D3D8DE" />
          <ellipse cx="540" cy="800" rx="300" ry="86" fill="#E3E7EB" />
          <ellipse cx="540" cy="740" rx="300" ry="86" fill="#F0F2F5" />
          <ellipse cx="540" cy="520" rx="230" ry="260" fill="#FFFFFF" stroke="#CDD3DA" strokeWidth="14" transform="rotate(-18 540 520)" />
          <circle cx="780" cy="330" r="62" fill={`url(#wl-g${v})`} />
          <path d="M752 330l20 20 38-42" fill="none" stroke="#fff" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
      {v === 2 && (
        <g>
          <rect x="290" y="190" width="500" height="700" rx="46" fill="#FFFFFF" stroke="#CDD3DA" strokeWidth="14" />
          <path d="M540 330l170 62v140c0 100-70 170-170 214-100-44-170-114-170-214V392z" fill={`url(#wl-g${v})`} />
          <path d="M470 540l55 55 100-110" fill="none" stroke="#fff" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="800" cy="760" r="58" fill="#0F172A" />
          <path d="M776 760h48M800 736v48" stroke="#fff" strokeWidth="10" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}

function GoogleG() {
  return (
    <svg width="24" height="24" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.2 5.6c4.3-4 7.1-9.9 7.1-17.1z" />
      <path fill="#FBBC05" d="M10.5 28.6a14.5 14.5 0 010-9.2l-7.9-6.2a24 24 0 000 21.6z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.6 2.2-8.7 2.2-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.2C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

function Welcome() {
  const router = useRouter();
  const search = useSearchParams();
  const [data, setData] = useState(null); // null until /api/welcome answered
  const [idx, setIdx] = useState(0);
  const touch = useRef(null);
  const timer = useRef(null);

  // already signed in → straight to the app
  useEffect(() => {
    let alive = true;
    fetch('/api/auth/me').then((r) => { if (alive && r.ok) router.replace('/'); }).catch(() => {});
    return () => { alive = false; };
  }, [router]);

  useEffect(() => {
    let alive = true;
    fetch('/api/welcome', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ slides: DEFAULT_SLIDES, googleEnabled: false, appName: 'Signal Desk', logoUrl: null }));
    return () => { alive = false; };
  }, []);

  const slides = data?.slides?.length ? data.slides : DEFAULT_SLIDES;
  const n = slides.length;

  const restart = useCallback(() => {
    clearInterval(timer.current);
    if (n < 2) return;
    timer.current = setInterval(() => setIdx((i) => (i + 1) % n), AUTO_MS);
  }, [n]);
  useEffect(() => { restart(); return () => clearInterval(timer.current); }, [restart]);

  const go = (i) => { setIdx(((i % n) + n) % n); restart(); };
  const ref = search.get('ref');
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const err = search.get('error');

  return (
    <>
      <NexoraSplashScreen active={!data} />
      <div
        className="wl"
        onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => {
          if (touch.current == null) return;
          const dx = e.changedTouches[0].clientX - touch.current;
          touch.current = null;
          if (Math.abs(dx) > 45) go(idx + (dx < 0 ? 1 : -1));
        }}
      >
        <div className="wl-hero">
          {slides.map((s, i) => (
            <div key={i} className={`wl-slide-img ${i === idx ? 'is-on' : ''}`} aria-hidden={i !== idx}>
              {s.imageUrl ? <img src={s.imageUrl} alt="" draggable={false} /> : <SlideArt index={i} />}
            </div>
          ))}
          <div className="wl-fade" />
          {data?.logoUrl && <img className="wl-logo" src={data.logoUrl} alt={data.appName || ''} draggable={false} />}
        </div>

        <div className="wl-body">
          <div className="wl-text" key={idx}>
            <h1 className="wl-title">{slides[idx]?.title}</h1>
            {slides[idx]?.subtitle ? <p className="wl-sub">{slides[idx].subtitle}</p> : null}
          </div>

          {n > 1 && (
            <div className="wl-dots" role="tablist" aria-label="Slides">
              {slides.map((_, i) => (
                <button key={i} type="button" role="tab" aria-selected={i === idx} aria-label={`Slide ${i + 1}`} className={`wl-dot ${i === idx ? 'is-on' : ''}`} onClick={() => go(i)} />
              ))}
            </div>
          )}

          {err && <div className="auth-error" role="alert" style={{ marginBottom: 10 }}>Google sign-in failed ({err.replace('google_', '')}). Try again or use email.</div>}

          <div className="wl-actions">
            {data?.googleEnabled && (
              <a className="wl-btn wl-btn-soft" href={`/api/auth/google${q}`}>
                <GoogleG />
                <span>Google</span>
              </a>
            )}
            <a className="wl-btn wl-btn-primary" href={`/signup${q}`}>Register</a>
            <div className="wl-or"><span>or</span></div>
            <a className="wl-btn wl-btn-soft" href="/login">Sign in</a>
          </div>
        </div>
      </div>
    </>
  );
}

export default function WelcomePage() {
  return (
    <Suspense fallback={<NexoraSplashScreen />}>
      <Welcome />
    </Suspense>
  );
}
