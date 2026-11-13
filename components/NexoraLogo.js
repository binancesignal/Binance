/**
 * NEXORA logo — scalable SVG.
 *
 * The "N" mark is a folded ribbon (left bar → diagonal → right bar) traced from the
 * supplied NEXORA storyboard. The wordmark is drawn from monoline strokes (no web
 * font needed, so it is sharp at every size and never causes a font-swap flash).
 *
 * Exports:
 *   <NexoraMark />       – the N on its own (navbar / header / favicon-sized use)
 *   NexoraWord           – wordmark <g> used by the splash lockup
 *   N_* constants        – raw geometry shared with NexoraSplashScreen
 */

// Mark coordinate space: viewBox "120 80 690 800"
export const N_VIEWBOX = '120 80 690 800';
export const N_RIBBON =
  'M180 352 L325 212 Q362 196 398 222 L778 572 Q792 592 770 607 L650 738 Q605 764 560 735 L250 395 Q220 352 180 352 Z';
export const N_LEFT =
  'M140 855 L140 412 Q140 374 188 366 Q248 366 286 418 L320 470 L320 712 Z';
export const N_RIGHT = 'M790 98 L790 576 Q790 602 764 608 L612 440 L612 256 Z';
// soft fold shadows that give the ribbon its "folded" depth
export const N_SHADOW_L = 'M212 366 Q252 362 292 422 L322 468 L322 506 L250 404 Q232 372 212 366 Z';
export const N_SHADOW_R = 'M730 566 L774 607 L790 592 L790 580 Z';

export function NexoraGradients({ p = 'nx' }) {
  return (
    <>
      <linearGradient id={`${p}-g-rib`} gradientUnits="userSpaceOnUse" x1="190" y1="210" x2="760" y2="740">
        <stop offset="0" stopColor="#86ffc6" />
        <stop offset="0.42" stopColor="#25ea84" />
        <stop offset="1" stopColor="#00cf68" />
      </linearGradient>
      <linearGradient id={`${p}-g-l`} gradientUnits="userSpaceOnUse" x1="150" y1="380" x2="320" y2="860">
        <stop offset="0" stopColor="#2cf08d" />
        <stop offset="1" stopColor="#0cb556" />
      </linearGradient>
      <linearGradient id={`${p}-g-r`} gradientUnits="userSpaceOnUse" x1="790" y1="100" x2="612" y2="600">
        <stop offset="0" stopColor="#12c260" />
        <stop offset="1" stopColor="#0b9a4b" />
      </linearGradient>
    </>
  );
}

export function NexoraMarkPaths({ p = 'nx' }) {
  return (
    <>
      <path d={N_RIGHT} fill={`url(#${p}-g-r)`} />
      <path d={N_LEFT} fill={`url(#${p}-g-l)`} />
      <path d={N_SHADOW_L} fill="#021a0d" opacity="0.55" />
      <path d={N_RIBBON} fill={`url(#${p}-g-rib)`} />
      <path d={N_SHADOW_R} fill="#021a0d" opacity="0.4" />
    </>
  );
}

/** The N on its own. Use anywhere (header, navbar, favicon-sized). */
export function NexoraMark({ className = '', title, size }) {
  return (
    <svg
      className={className}
      viewBox={N_VIEWBOX}
      width={size ? (size * 690) / 800 : undefined}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <NexoraGradients p="nx-m" />
      </defs>
      <NexoraMarkPaths p="nx-m" />
    </svg>
  );
}

// Wordmark: cap height 70, stroke 10. x = horizontal advance of each letter.
const LETTERS = [
  { k: 'N', x: 0, d: 'M5 70V0 M55 0V70 M5 0L55 70' },
  { k: 'E', x: 84, d: 'M5 0V70 M0 5H50 M0 35H44 M0 65H50' },
  { k: 'X', x: 160, d: 'M2 0L52 70 M52 0L2 70' },
  { k: 'O', x: 236, d: 'M27 5H33Q55 5 55 27V43Q55 65 33 65H27Q5 65 5 43V27Q5 5 27 5Z' },
  { k: 'R', x: 316, d: 'M5 0V70 M0 5H38Q52 5 52 20V25Q52 40 38 40H0 M30 40L54 70' },
  { k: 'A', x: 394, d: 'M2 70L30 0L58 70 M14 50H46' },
];
export const WORD_W = 456;
export const WORD_H = 70;

/** Wordmark group (drawn in a 456×70 box). `animated` adds the per-letter reveal hooks. */
export function NexoraWord({ animated = false, clipId = 'nx-word-clip' }) {
  return (
    <>
      <defs>
        <clipPath id={clipId}>
          <rect x="-10" y="0" width={WORD_W + 20} height={WORD_H} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`} fill="none" stroke="#fff" strokeWidth="10" strokeLinejoin="miter" strokeMiterlimit="10">
        {LETTERS.map((l, i) => (
          <g key={l.k} transform={`translate(${l.x} 0)`}>
            <g className={animated ? 'nx__ltr nx-i' : undefined} style={animated ? { '--i': i } : undefined}>
              <path d={l.d} />
            </g>
          </g>
        ))}
      </g>
    </>
  );
}
