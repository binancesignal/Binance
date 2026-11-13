# ICT / SMC PROBABILITY-BASED POI (paper / analysis only)

Independent strategy — never places orders, never touches auto-trading. Admin account only.

**Where:** Signals tab → "ICT / SMC POI" card (scan · chart · why/why-not) · Admin → "ICT/SMC POI" (all settings, saved in `app_state.poi_system_config`).

## Files
- New: `lib/poiSystem/{config,structure,engine,backtest}.js`, `app/api/poi-system/route.js`, `components/PoiSystemCard.js`, `components/PoiSystemAdmin.js`, `tests/poi-system.test.js`
- Modified: `app/page.js` (mount card), `app/admin/page.js` (admin tab), `components/SkChart.js` (extra annotation groups + 3m)
- Reused (not rewritten): `lib/scanner/indicators.js` (findSwings, ATR), `lib/scanner/orderBlocks.js` (LuxAlgo OB detector), `lib/doubleOb/detect.js` (double OB), `lib/exchange` (klines, ban guard), `lib/skSystem/{access,universe,structure}.js`, SkChart canvas.

## Logic
1D+4H structure (BOS/MSS, HH/HL/LH/LL) → bias · 4H major swings → dealing range, equilibrium, premium/discount · 4H/1H/30M/15M zones: OB (FRESH/MITIGATED/INVALIDATED, displacement-validated), FVG (FRESH/PARTIAL/FILLED/INVALIDATED), double OB → merged into one POI per area · liquidity pools (equal H/L, swings, internal/external) + sweeps (REJECTED only when price holds away) · 15M MSS/BOS after the POI was reached (and after the sweep) → CONFIRMED.
States WATCHING → READY (POI reached) → CONFIRMED (closed 15M shift) | INVALIDATED. Class A+/B/C = setup quality (NOT a win rate), each score factor counted once.
SHORT = the same code on price-mirrored candles. Only closed candles are used.

## Scan
Client scans 3 coins per request with a 0.7 s pause; stops at once on a ban/429. Every coin returns diagnostics ("Not listed (why)").

## Limitations
No DB persistence / cron for POI yet (scan results live in the card). Backtest window ≈ 8 days (1500 × 15M bars). Dealing range = latest major 4H swing pair.
