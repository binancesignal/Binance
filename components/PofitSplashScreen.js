'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import './pofit-splash.css';

/**
 * POFIT splash / loading screen — follows the 6-step reference sequence:
 *   1 logo build (inside a ring) → 2 logo complete + glow → 3 POFIT text reveal
 *   → 4 tagline + ring pulse → 5 progress bar (indeterminate, loops) → 6 check + fade-out.
 *
 * Purely visual. It owns no data and adds NO artificial waiting:
 *   - `active` mirrors the app's real loading state.
 *   - the moment `active` turns false the check pops and the screen fades out
 *     (the content underneath is already rendered, so this is the dashboard fade-in too).
 *   - if loading is slow the bar simply keeps looping; if it is fast the intro is cut short.
 *
 * Usage A (persistent overlay, smoothest):   <PofitSplashScreen active={loading} />
 * Usage B (early return):                    if (loading) return <PofitSplashScreen />;
 *   When unmounted while still active, a static copy is left behind just long
 *   enough to fade out, so there is no hard jump.
 *
 * Logo + wordmark are vector traces of the supplied POFIT reference artwork.
 */

const FADE_MS = 520; // 120 ms check pop + 400 ms fade (see pofit-splash.css)

// Vector paths traced from the reference artwork (viewBox "20 28 664 200").
const MARK_BOWL =
  'M163.5 40.5Q160.2 38.2 157.6 37.0Q155.0 35.8 150.0 34.4Q145.0 33.0 139.4 32.9Q133.8 32.8 131.0 33.0Q128.2 33.2 95.9 42.4Q63.5 51.5 60.8 52.5Q58.0 53.5 54.4 55.4Q50.8 57.2 48.0 59.4Q45.2 61.5 42.6 64.2Q40.0 67.0 37.9 69.9Q35.8 72.8 33.9 76.4Q32.0 80.0 30.0 87.0Q28.0 94.0 27.8 96.6Q27.5 99.2 27.5 111.1L27.5 123.0L27.9 123.4L28.2 123.8L28.9 123.8Q29.5 123.8 32.2 122.0Q35.0 120.2 39.6 118.0Q44.2 115.8 51.1 112.9Q58.0 110.0 66.2 107.4Q74.5 104.8 84.1 101.2Q93.8 97.8 104.9 94.4Q116.0 91.0 120.0 89.5Q124.0 88.0 128.4 86.8Q132.8 85.5 134.2 84.8Q135.8 84.0 136.5 84.0L137.2 84.0L137.6 84.4L138.0 84.8L137.9 89.2Q137.8 93.8 137.0 96.0Q136.2 98.2 135.0 100.4Q133.8 102.5 132.4 103.9Q131.0 105.2 129.5 106.1Q128.0 107.0 120.1 109.5Q112.2 112.0 109.8 113.2Q107.2 114.5 103.9 117.1Q100.5 119.8 97.5 123.2Q94.5 126.8 92.5 130.9Q90.5 135.0 89.6 138.2Q88.8 141.5 88.4 145.0Q88.0 148.5 87.8 158.0L87.5 167.5L88.1 168.1L88.8 168.8L91.4 168.1Q94.0 167.5 100.9 164.9Q107.8 162.2 130.0 154.9Q152.2 147.5 155.4 145.8Q158.5 144.0 162.6 140.4Q166.8 136.8 168.6 134.5Q170.5 132.2 172.2 129.5Q174.0 126.8 175.9 122.5Q177.8 118.2 179.2 112.4Q180.8 106.5 180.8 90.8Q180.8 75.0 180.4 69.4Q180.0 63.8 179.0 60.8Q178.0 57.8 175.5 53.5Q173.0 49.2 169.9 46.0Q166.8 42.8 163.5 40.5Z';
const MARK_STEM =
  'M82.5 122.1L82.2 121.8L81.4 121.6Q80.5 121.5 70.1 124.8Q59.8 128.0 55.4 130.0Q51.0 132.0 48.1 133.8Q45.2 135.5 42.6 137.6Q40.0 139.8 37.8 142.1Q35.5 144.5 33.9 146.8Q32.2 149.0 30.1 153.4Q28.0 157.8 27.0 161.2Q26.0 164.8 25.4 168.2Q24.8 171.8 24.1 186.8Q23.5 201.8 23.5 211.0Q23.5 220.2 23.9 220.9L24.2 221.5L25.1 221.6Q26.0 221.8 32.6 219.6Q39.2 217.5 45.6 214.5Q52.0 211.5 54.8 209.6Q57.5 207.8 59.6 205.9Q61.8 204.0 63.4 202.1Q65.0 200.2 67.2 196.2Q69.5 192.2 70.6 188.9Q71.8 185.5 72.1 183.1Q72.5 180.8 72.8 167.8Q73.0 154.8 73.6 146.9Q74.2 139.0 76.4 133.6Q78.5 128.2 80.5 125.9Q82.5 123.5 82.6 123.0L82.8 122.5L82.5 122.1Z';
const WORDMARK =
  'M326.4 95.1Q324.2 92.8 322.6 91.5Q321.0 90.2 319.0 89.1Q317.0 88.0 313.4 86.9Q309.8 85.8 307.1 85.4Q304.5 85.0 277.0 85.0L249.5 85.0L248.9 85.5L248.2 86.0L248.1 128.9Q248.0 171.8 248.5 172.5L249.0 173.2L258.0 173.5Q267.0 173.8 267.9 173.2L268.8 172.8L268.9 160.4Q269.0 148.0 269.2 147.4Q269.5 146.8 270.2 146.2Q271.0 145.8 289.4 145.6Q307.8 145.5 311.9 144.5Q316.0 143.5 318.2 142.5Q320.5 141.5 322.2 140.2Q324.0 139.0 325.4 137.6Q326.8 136.2 328.6 133.4Q330.5 130.5 331.8 127.4Q333.0 124.2 333.4 121.8Q333.8 119.2 333.8 115.6Q333.8 112.0 333.4 109.8Q333.0 107.5 332.1 105.0Q331.2 102.5 329.9 100.0Q328.5 97.5 326.4 95.1ZM269.1 115.5L269.2 104.8L270.4 104.0Q271.5 103.2 285.9 103.2Q300.2 103.2 302.5 103.8Q304.8 104.2 306.2 105.0Q307.8 105.8 308.5 106.5Q309.2 107.2 310.4 109.1Q311.5 111.0 311.6 114.8Q311.8 118.5 310.9 120.5Q310.0 122.5 309.0 123.8Q308.0 125.0 305.4 126.4Q302.8 127.8 286.5 127.8L270.2 127.8L269.6 127.0L269.0 126.2L269.1 115.5ZM373.0 88.1Q368.8 90.0 365.4 92.5Q362.0 95.0 360.5 96.5Q359.0 98.0 356.6 101.1Q354.2 104.2 353.1 106.4Q352.0 108.5 351.0 111.2Q350.0 114.0 349.0 119.4Q348.0 124.8 348.0 128.1Q348.0 131.5 348.9 137.0Q349.8 142.5 350.9 146.0Q352.0 149.5 353.1 151.6Q354.2 153.8 356.2 156.6Q358.2 159.5 361.4 162.5Q364.5 165.5 367.2 167.4Q370.0 169.2 371.8 170.1Q373.5 171.0 377.4 172.2Q381.2 173.5 386.6 174.4Q392.0 175.2 398.6 175.4Q405.2 175.5 410.9 174.6Q416.5 173.8 419.1 172.8Q421.8 171.8 423.1 171.5Q424.5 171.2 426.4 170.4Q428.2 169.5 431.5 167.4Q434.8 165.2 437.1 162.9Q439.5 160.5 441.1 158.5Q442.8 156.5 445.0 152.8Q447.2 149.0 448.5 145.4Q449.8 141.8 449.9 140.0Q450.0 138.2 450.6 135.5Q451.2 132.8 451.2 128.9Q451.2 125.0 450.4 120.0Q449.5 115.0 448.5 112.2Q447.5 109.5 446.2 107.1Q445.0 104.8 442.8 101.6Q440.5 98.5 437.5 95.6Q434.5 92.8 430.8 90.4Q427.0 88.0 421.5 86.1Q416.0 84.2 412.8 83.8Q409.5 83.2 402.0 83.1Q394.5 83.0 390.9 83.4Q387.2 83.8 382.2 85.0Q377.2 86.2 373.0 88.1ZM377.4 109.1Q379.2 107.2 382.2 105.5Q385.2 103.8 388.1 102.9Q391.0 102.0 392.4 101.8Q393.8 101.5 400.6 101.6Q407.5 101.8 411.1 102.9Q414.8 104.0 416.8 105.1Q418.8 106.2 421.0 108.4Q423.2 110.5 424.4 112.1Q425.5 113.8 426.5 115.9Q427.5 118.0 428.2 122.0Q429.0 126.0 429.0 129.4Q429.0 132.8 428.5 135.6Q428.0 138.5 427.0 140.9Q426.0 143.2 424.4 145.8Q422.8 148.2 421.2 149.8Q419.8 151.2 417.8 152.6Q415.8 154.0 413.1 154.9Q410.5 155.8 406.6 156.4Q402.8 157.0 399.1 157.0Q395.5 157.0 391.4 156.2Q387.2 155.5 384.9 154.4Q382.5 153.2 380.9 152.1Q379.2 151.0 378.1 149.9Q377.0 148.8 375.2 146.4Q373.5 144.0 372.6 142.0Q371.8 140.0 371.1 137.0Q370.5 134.0 370.4 130.5Q370.2 127.0 371.1 122.1Q372.0 117.2 373.8 114.1Q375.5 111.0 377.4 109.1ZM541.8 86.1L541.2 85.0L529.6 84.8Q518.0 84.5 502.9 84.6Q487.8 84.8 484.9 85.4Q482.0 86.0 480.4 86.8Q478.8 87.5 477.1 88.6Q475.5 89.8 474.0 91.2Q472.5 92.8 471.4 94.6Q470.2 96.5 469.2 100.5Q468.2 104.5 468.4 138.1Q468.5 171.8 469.0 172.5L469.5 173.2L478.8 173.5Q488.0 173.8 488.8 173.2L489.5 172.8L489.6 157.0L489.8 141.2L490.4 140.5L491.0 139.8L512.8 139.6Q534.5 139.5 535.0 139.1L535.5 138.8L535.6 131.1Q535.8 123.5 535.4 123.0L535.0 122.5L513.2 122.4L491.5 122.2L490.6 121.4L489.8 120.5L489.8 114.4Q489.8 108.2 490.1 107.4Q490.5 106.5 491.6 105.4Q492.8 104.2 493.6 103.9Q494.5 103.5 517.5 103.5L540.5 103.5L541.2 102.8L542.0 102.0L542.1 94.6Q542.2 87.2 541.8 86.1ZM570.0 84.8Q561.0 84.8 560.4 85.0L559.8 85.2L559.4 86.1Q559.0 87.0 559.1 129.4Q559.2 171.8 559.8 172.5L560.2 173.2L561.1 173.5Q562.0 173.8 570.2 173.8L578.5 173.8L579.4 173.0L580.2 172.2L580.4 129.8Q580.5 87.2 580.1 86.2Q579.8 85.2 579.4 85.0Q579.0 84.8 570.0 84.8ZM602.8 85.0L597.5 85.2L597.0 86.0Q596.5 86.8 596.5 94.2L596.5 101.8L597.0 102.4L597.5 103.0L600.1 103.2Q602.8 103.5 613.4 103.4Q624.0 103.2 624.6 103.5Q625.2 103.8 625.8 104.4L626.2 105.0L626.5 138.9L626.8 172.8L627.6 173.2Q628.5 173.8 637.1 173.8Q645.8 173.8 646.4 173.5L647.0 173.2L647.2 172.8Q647.5 172.2 647.4 138.8L647.2 105.2L648.0 104.4Q648.8 103.5 649.1 103.4Q649.5 103.2 656.2 103.4Q663.0 103.5 669.8 103.2L676.5 103.0L677.0 102.2Q677.5 101.5 677.4 93.6L677.2 85.8L676.5 85.2Q675.8 84.8 641.9 84.8Q608.0 84.8 602.8 85.0Z';

/** The "P" leaf mark on its own (viewBox matches the full lockup's mark area). */
export function PofitMark({ className = '', title }) {
  return (
    <svg
      className={className}
      viewBox="20 30 164 196"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id="pofit-m-bowl" gradientUnits="userSpaceOnUse" x1="30" y1="40" x2="175" y2="200">
          <stop offset="0" stopColor="#7CF2A8" />
          <stop offset="0.45" stopColor="#27D465" />
          <stop offset="1" stopColor="#0FBE50" />
        </linearGradient>
        <linearGradient id="pofit-m-stem" gradientUnits="userSpaceOnUse" x1="70" y1="120" x2="35" y2="224">
          <stop offset="0" stopColor="#74F28F" />
          <stop offset="1" stopColor="#58EA78" />
        </linearGradient>
      </defs>
      <path d={MARK_BOWL} fill="url(#pofit-m-bowl)" fillRule="evenodd" />
      <path d={MARK_STEM} fill="url(#pofit-m-stem)" />
    </svg>
  );
}

function SplashBody({ rootRef, leaving }) {
  return (
    <div
      ref={rootRef}
      className={`pofit-splash${leaving ? ' pofit-splash--leaving' : ''}`}
      role="status"
      aria-live="polite"
      aria-busy={!leaving}
    >
      <span className="pofit-sr">Loading POFIT</span>
      <div className="pofit-splash__stage" aria-hidden="true">
        <div className="pofit-splash__lock">
          {/* steps 1–4: ring around the logo / lockup */}
          <svg className="pofit-splash__ring" viewBox="0 0 120 120" focusable="false">
            <circle className="pofit-splash__track" cx="60" cy="60" r="56" />
            <g className="pofit-splash__spin pofit-splash__spin--a">
              <circle className="pofit-splash__arc-glow" cx="60" cy="60" r="56" />
              <circle className="pofit-splash__arc" cx="60" cy="60" r="56" />
            </g>
            <g className="pofit-splash__spin pofit-splash__spin--b">
              <circle className="pofit-splash__arc pofit-splash__arc--short" cx="60" cy="60" r="56" />
            </g>
          </svg>

          <svg className="pofit-splash__lockup" viewBox="20 28 664 200" focusable="false" overflow="visible">
            <defs>
              <linearGradient id="pofit-l-bowl" gradientUnits="userSpaceOnUse" x1="30" y1="40" x2="175" y2="200">
                <stop offset="0" stopColor="#7CF2A8" />
                <stop offset="0.45" stopColor="#27D465" />
                <stop offset="1" stopColor="#0FBE50" />
              </linearGradient>
              <linearGradient id="pofit-l-stem" gradientUnits="userSpaceOnUse" x1="70" y1="120" x2="35" y2="224">
                <stop offset="0" stopColor="#74F28F" />
                <stop offset="1" stopColor="#58EA78" />
              </linearGradient>
              <radialGradient id="pofit-l-glow">
                <stop offset="0" stopColor="#22E27A" stopOpacity="0.5" />
                <stop offset="0.5" stopColor="#22E27A" stopOpacity="0.14" />
                <stop offset="1" stopColor="#22E27A" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* steps 1–3: the mark builds in the centre, then slides left as the word appears */}
            <g className="pofit-splash__mark">
              <circle className="pofit-splash__glow" cx="102" cy="128" r="170" fill="url(#pofit-l-glow)" />
              <path className="pofit-fill pofit-fill--bowl" d={MARK_BOWL} fill="url(#pofit-l-bowl)" fillRule="evenodd" />
              <path className="pofit-fill pofit-fill--stem" d={MARK_STEM} fill="url(#pofit-l-stem)" />
              <path className="pofit-stroke pofit-stroke--bowl" d={MARK_BOWL} pathLength="1" />
              <path className="pofit-stroke pofit-stroke--stem" d={MARK_STEM} pathLength="1" />
            </g>

            {/* step 3: POFIT */}
            <path className="pofit-splash__word" d={WORDMARK} fill="#fff" fillRule="evenodd" />
          </svg>
        </div>

        {/* step 4 */}
        <p className="pofit-splash__tag">
          Trade<i>·</i>Analyze<i>·</i>Grow
        </p>

        {/* step 5 (bar) → step 6 (check) share one slot */}
        <div className="pofit-splash__slot">
          <div className="pofit-splash__bar"><span /></div>
          <svg className="pofit-splash__check" viewBox="0 0 40 40" focusable="false">
            <circle className="pofit-splash__check-ring" cx="20" cy="20" r="17" pathLength="1" />
            <path className="pofit-splash__check-tick" d="M12.5 20.6l5.2 5.2 9.8-10.6" pathLength="1" />
          </svg>
        </div>
      </div>
    </div>
  );
}

export default function PofitSplashScreen({ active = true }) {
  const [visible, setVisible] = useState(true);
  const [leaving, setLeaving] = useState(false);
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

  // Unmounted while still loading (e.g. `if (loading) return <PofitSplashScreen />`
  // or a redirect): leave a static copy that fades out so the screen never snaps away.
  useEffect(() => {
    return () => {
      const node = nodeRef.current;
      // node.isConnected is true during React StrictMode's simulated unmount → skip it (dev only)
      if (!activeRef.current || typeof document === 'undefined' || !node || node.isConnected) return;
      try {
        const ghost = node.cloneNode(true);
        ghost.classList.remove('pofit-splash--leaving');
        ghost.classList.add('pofit-splash--ghost');
        ghost.setAttribute('aria-hidden', 'true');
        document.body.appendChild(ghost);
        const remove = () => ghost.parentNode && ghost.parentNode.removeChild(ghost);
        ghost.addEventListener('animationend', remove, { once: true });
        setTimeout(remove, FADE_MS + 200); // safety net
      } catch (_) {
        /* purely cosmetic — never let it break the app */
      }
    };
  }, []);

  if (!visible) return null;
  return <SplashBody rootRef={setRoot} leaving={leaving} />;
}
