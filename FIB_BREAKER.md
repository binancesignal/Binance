# FIBONACCI BREAKER BLOCK CONFLUENCE STRATEGY

Admin-only analysis strategy (paper only — no orders).

## Logic
1. Market structure: LH/LL → LH breakout → New High → HL → HH (BOS). SHORT = mirror.
2. **Fibonacci (user update)**: take the two closed candles before the forming candle. Must be opposite colours (G-R or R-G).
   - 1 green + 2 red → Fib from 1 HIGH → 2 LOW
   - 1 red + 2 green → Fib from 1 LOW → 2 HIGH
   Golden pocket zone = **0.618 – 0.65** (configurable on settings page). Fallback to HL→HH if no opposite pair.
3. Breaker block = supply candle at New High that price closed through (flips to support).
4. Trendline = LL→HL ascending support (or mirror for short).
5. **Confluence** = Breaker ∩ Fib golden-pocket zone ∩ Trendline (ATR tolerance).
6. Entry at 0.618 (or zone mid). SL under zone + ATR buffer.
7. TP1 = HH · TP2/TP3 = extensions · **TP4 = 1:4 RR**.

## Stages / buckets
Waiting · Confluence · Entry ready · Active · Completed · Invalidated

## UI
Signals → **Fibonacci Breaker Block Confluence** card (admin).
Pick coins / Top N / All · TFs · chunked scan · chart with structure/fib/breaker/trendline/TP lines.

## Files
- `lib/fibBreaker/{config,engine}.js`
- `components/FibBreakerCard.js`
- `app/api/fib-breaker/route.js`
- Mount: `app/page.js` (replaces ICT/SMC POI card)
