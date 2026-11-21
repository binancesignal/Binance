'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import './nexora-splash.css';
import {
  N_RIBBON,
  N_LEFT,
  N_RIGHT,
  NexoraGradients,
  NexoraMarkPaths,
  NexoraWord,
} from './NexoraLogo.js';

/**
 * NEXORA splash / loading screen — 7-stage sequence (see nexora-splash.css):
 *   1 initial glow · 2 light strokes · 3 N builds · 4 energy sweep
 *   5 name reveal · 6 loading line (loops) · 7 ready → fade to the dashboard
 *
 * It is purely visual and owns NO data and NO timers that delay the app:
 *   - `active` mirrors the app's real loading / auth state.
 *   - the moment `active` becomes false: line completes → logo pulses → screen fades out
 *     (the app underneath is already rendered, so this is also the dashboard fade-in).
 *   - slow load  → stage 6 simply keeps looping.
 *   - fast load  → the intro is not held back; the screen just fades out smoothly.
 *
 * Usage A (persistent overlay, smoothest):  <NexoraSplashScreen active={loading} />
 * Usage B (early return):                   if (loading) return <NexoraSplashScreen />;
 *   When unmounted while still active, a static copy is left behind just long enough to
 *   fade out, so the screen never snaps away.
 *
 * Continuity: if a splash was just unmounted (e.g. login page → dashboard route), the next
 * one mounts straight into stage 6 instead of replaying the intro.
 */

const FADE_MS = 680; // pulse + fade (see nexora-splash.css, .nx--leaving)
const RESUME_WINDOW_MS = 1500;
let lastActiveUnmountAt = 0;

const PARTICLES = [
  { x: 392, y: 78, dx: -26, dy: -30, d: 0 },
  { x: 612, y: 96, dx: 30, dy: -26, d: 0.05 },
  { x: 650, y: 190, dx: 36, dy: 10, d: 0.1 },
  { x: 350, y: 196, dx: -34, dy: 14, d: 0.03 },
  { x: 560, y: 252, dx: 22, dy: 28, d: 0.08 },
  { x: 440, y: 40, dx: -10, dy: -34, d: 0.12 },
];

function SplashBody({ rootRef, leaving, resume }) {
  return (
    <div
      ref={rootRef}
      className={`nx${leaving ? ' nx--leaving' : ''}${resume ? ' nx--resume' : ''}`}
      role="status"
      aria-live="polite"
      aria-busy={!leaving}
    >
      <span className="nx-sr">Loading NEXORA</span>

      {/* stage 1 — ambient glow that fades in on the black screen */}
      <div className="nx__ambient nx-i" aria-hidden="true" />
      <div className="nx__halo" aria-hidden="true" />

      <div className="nx__stage" aria-hidden="true">
        <div className="nx__lock">
          {/* stage 1 flare + stage 2 strokes (HTML layer, transform/opacity only) */}
          <div className="nx__fx">
            <div className="nx__flare nx-i" />
            <div className="nx__stroke nx__stroke--l nx-i" />
            <div className="nx__stroke nx__stroke--r nx-i" />
            <div className="nx__merge nx-i" />
          </div>

          <svg className="nx__lockup" viewBox="0 0 1000 300" focusable="false" overflow="visible">
            <defs>
              <NexoraGradients p="nx" />
              <radialGradient id="nx-glow">
                <stop offset="0" stopColor="#22e27a" stopOpacity="0.5" />
                <stop offset="0.5" stopColor="#22e27a" stopOpacity="0.14" />
                <stop offset="1" stopColor="#22e27a" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="nx-g-sweep" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#d6ffe8" stopOpacity="0" />
                <stop offset="0.5" stopColor="#f0fff7" stopOpacity="0.9" />
                <stop offset="1" stopColor="#d6ffe8" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="nx-g-ring" gradientUnits="userSpaceOnUse" x1="270" y1="230" x2="730" y2="70">
                <stop offset="0" stopColor="#19e57c" stopOpacity="0" />
                <stop offset="0.5" stopColor="#7dffbd" />
                <stop offset="1" stopColor="#eafff3" />
              </linearGradient>
              <clipPath id="nx-clip-n">
                <path d={N_RIBBON} />
                <path d={N_LEFT} />
                <path d={N_RIGHT} />
              </clipPath>
            </defs>

            {/* stages 3–5: the mark builds in the centre, then settles left */}
            <g className="nx__mark nx-i">
              <circle className="nx__markglow nx-i" cx="112" cy="149" r="215" fill="url(#nx-glow)" />
              <g transform="translate(0 20) scale(0.325) translate(-120 -80)">
                {/* stage 3: each piece is revealed by a light stroke */}
                <g className="nx__piece nx__piece--r nx-i">
                  <path d={N_RIGHT} fill="url(#nx-g-r)" />
                </g>
                <g className="nx__piece nx__piece--l nx-i">
                  <path d={N_LEFT} fill="url(#nx-g-l)" />
                </g>
                <g className="nx__piece nx__piece--rib nx-i">
                  <NexoraMarkPaths p="nx" />
                </g>
                {/* leading-edge trace while the N is being drawn */}
                <g className="nx__trace" fill="none">
                  <path className="nx__trace-p nx-i" style={{ '--t': 0 }} d={N_LEFT} pathLength="1" />
                  <path className="nx__trace-p nx-i" style={{ '--t': 1 }} d={N_RIBBON} pathLength="1" />
                  <path className="nx__trace-p nx-i" style={{ '--t': 2 }} d={N_RIGHT} pathLength="1" />
                </g>
                {/* stage 4: light band passing across the finished N */}
                <g clipPath="url(#nx-clip-n)">
                  <g className="nx__sweep nx-i">
                    <rect x="-230" y="-150" width="150" height="1200" fill="url(#nx-g-sweep)" transform="skewX(-18)" />
                  </g>
                </g>
              </g>
            </g>

            {/* stage 4: orbit ring + a few tiny particles */}
            <g className="nx__orbit">
              <ellipse className="nx__ring-base nx-i" cx="500" cy="150" rx="238" ry="82" transform="rotate(-28 500 150)" />
              <ellipse
                className="nx__ring nx-i"
                cx="500"
                cy="150"
                rx="238"
                ry="82"
                transform="rotate(-28 500 150)"
                pathLength="1"
                stroke="url(#nx-g-ring)"
              />
              {PARTICLES.map((p, i) => (
                <circle
                  key={i}
                  className="nx__spark nx-i"
                  cx={p.x}
                  cy={p.y}
                  r="2.2"
                  style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--d': `${p.d}s` }}
                />
              ))}
            </g>

            {/* stage 5: NEXORA wordmark */}
            <g transform="translate(280 97.5) scale(1.5)">
              <NexoraWord animated clipId="nx-word-clip" />
            </g>
          </svg>
        </div>

        {/* stage 6 (loops) → stage 7 (completes) */}
        <div className="nx__slot nx-i">
          <div className="nx__bar">
            <span className="nx__bar-seg" />
            <span className="nx__bar-done" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NexoraSplashScreen({ active = true }) {
  const [visible, setVisible] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const [resume] = useState(
    () => typeof performance !== 'undefined' && lastActiveUnmountAt > 0 && Date.now() - lastActiveUnmountAt < RESUME_WINDOW_MS
  );
  const nodeRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // keep a handle to the DOM node even while React is tearing it down
  const setRoot = useCallback((n) => {
    if (n) nodeRef.current = n;
  }, []);

  // real loading state → fade out immediately, no minimum display time
  useEffect(() => {
    if (active) {
      setLeaving(false);
      setVisible(true);
      return undefined;
    }
    setLeaving(true);
    const t = setTimeout(() => setVisible(false), FADE_MS);
    return () => clearTimeout(t);
  }, [active]);

  // Unmounted while still loading (early return, route change…): leave a static copy that
  // fades out so the screen never snaps away. Cosmetic only — never allowed to break the app.
  useEffect(() => {
    return () => {
      const node = nodeRef.current;
      // node.isConnected is true during React StrictMode's simulated unmount → skip it (dev only)
      if (!activeRef.current || typeof document === 'undefined' || !node || node.isConnected) return;
      lastActiveUnmountAt = Date.now();
      try {
        const ghost = node.cloneNode(true);
        ghost.classList.remove('nx--leaving', 'nx--resume');
        ghost.classList.add('nx--ghost');
        ghost.setAttribute('aria-hidden', 'true');
        document.body.appendChild(ghost);
        const remove = () => ghost.parentNode && ghost.parentNode.removeChild(ghost);
        ghost.addEventListener('animationend', remove, { once: true });
        setTimeout(remove, 800); // safety net
      } catch (_) {
        /* ignore */
      }
    };
  }, []);

  if (!visible) return null;
  return <SplashBody rootRef={setRoot} leaving={leaving} resume={resume} />;
}
