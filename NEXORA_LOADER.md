# NEXORA animated loader

Files
- components/NexoraSplashScreen.js  – the loader (`<NexoraSplashScreen active={loading} />`)
- components/nexora-splash.css      – 7-stage keyframes (transform/opacity only, prefers-reduced-motion aware)
- components/NexoraLogo.js          – N mark + wordmark as SVG; `<NexoraMark size={32} />` works in navbar/header

Wired to real state (no fixed delay)
- app/page.js            `active={(gate.loading || !gate.hasUser) && !giveUp}`  (/api/auth/me + redirect)
- app/admin/page.js      `if (loading) return <NexoraSplashScreen />`
- app/backtest/triple-cross/page.js  `if (!ready) ...`
- app/(auth)/welcome     `active={!data}`      app/(auth)/signup  Suspense fallback
- app/(auth)/login       after a successful login the loader stays up until the dashboard route takes over
  (10 s failsafe)

Stages: 1 glow 0–.3s · 2 strokes .3–.7 · 3 N builds .7–1.1 · 4 sweep 1.1–1.5 · 5 name 1.5–2.0 ·
6 loading line (loops while loading) · 7 line completes → logo pulse → fade out (~0.7 s).
The old POFIT splash files are untouched but no longer imported.
