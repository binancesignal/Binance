'use client';

import { useEffect, useState } from 'react';

/**
 * Shared shell for /login and /signup.
 * - Pulls the logo the admin uploaded (Admin → Branding) from /api/branding.
 * - Logo is fitted into a fixed-size box with object-fit: contain, so any
 *   shape (wide wordmark, square icon, tall mark) is shown whole, never
 *   stretched or cropped.
 */
export function useBranding() {
  const [brand, setBrand] = useState({ loaded: false, logoUrl: null, appName: 'Signal Desk' });
  useEffect(() => {
    let alive = true;
    fetch('/api/branding', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => alive && setBrand({ loaded: true, logoUrl: d.logoUrl || null, appName: d.appName || 'Signal Desk' }))
      .catch(() => alive && setBrand((b) => ({ ...b, loaded: true })));
    return () => { alive = false; };
  }, []);
  return brand;
}

function BrandMark({ brand }) {
  const [broken, setBroken] = useState(false);
  const showImg = brand.logoUrl && !broken;
  return (
    <div className="brand-mark" aria-label={brand.appName}>
      {!brand.loaded ? null : showImg ? (
        <img
          className="brand-mark-img"
          src={brand.logoUrl}
          alt={brand.appName}
          onError={() => setBroken(true)}
          draggable={false}
        />
      ) : (
        <span className="brand-mark-text">{brand.appName}</span>
      )}
    </div>
  );
}

const PERKS = [
  { t: 'Live signal board', d: 'Entries, stops and targets update as the market moves.' },
  { t: 'Auto-trade on Bybit', d: 'Your keys, your risk limits. Positions are sized for you.' },
  { t: 'Telegram alerts', d: 'Get every new signal and every close on your phone.' },
];

// Static candle data — drawn once, one line sweeps across on load.
const CANDLES = [
  [18, 30, 14, 26], [26, 34, 22, 24], [24, 31, 20, 29], [29, 40, 27, 38], [38, 44, 33, 35],
  [35, 42, 31, 41], [41, 52, 39, 50], [50, 56, 44, 46], [46, 54, 43, 53], [53, 64, 50, 62],
  [62, 68, 55, 58], [58, 70, 56, 68], [68, 78, 64, 75], [75, 82, 68, 71], [71, 84, 69, 82],
];

function HeroChart() {
  const w = 440, h = 200, step = w / CANDLES.length;
  const y = (v) => h - 14 - (v / 90) * (h - 28);
  const line = CANDLES.map((c, i) => `${i === 0 ? 'M' : 'L'}${(i * step + step / 2).toFixed(1)},${y(c[3]).toFixed(1)}`).join(' ');
  return (
    <svg className="auth-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Rising price chart">
      {[0.25, 0.5, 0.75].map((p) => (
        <line key={p} x1="0" x2={w} y1={h * p} y2={h * p} className="auth-chart-grid" />
      ))}
      {CANDLES.map((c, i) => {
        const up = c[3] >= c[0];
        const x = i * step + step / 2;
        return (
          <g key={i} className={up ? 'candle up' : 'candle down'}>
            <line x1={x} x2={x} y1={y(c[1])} y2={y(c[2])} />
            <rect x={x - 6} width="12" y={Math.min(y(c[0]), y(c[3]))} height={Math.max(3, Math.abs(y(c[0]) - y(c[3])))} rx="2" />
          </g>
        );
      })}
      <path d={line} className="auth-chart-line" pathLength="1" />
    </svg>
  );
}

export default function AuthShell({ title, subtitle, children, footer }) {
  const brand = useBranding();
  return (
    <div className="auth-split">
      <aside className="auth-hero" aria-hidden="false">
        <div className="auth-hero-inner">
          <h2 className="auth-hero-title">Trade the signals, not the noise.</h2>
          <p className="auth-hero-sub">A live board that finds the setups, and an auto-trader that takes them for you.</p>
          <HeroChart />
          <ul className="auth-perks">
            {PERKS.map((p) => (
              <li key={p.t}>
                <span className="auth-perk-dot" />
                <div>
                  <div className="auth-perk-t">{p.t}</div>
                  <div className="auth-perk-d">{p.d}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="auth-pane">
        <div className="auth-panel">
          <BrandMark brand={brand} />
          <div className="auth-heading">
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {children}
          {footer && <div className="auth-footer">{footer}</div>}
          <div className="auth-risk">Trading involves risk. Never trade with money you can't afford to lose.</div>
        </div>
      </main>
    </div>
  );
}
