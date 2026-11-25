# Volume Profile peak zone (blue zone) — build binance-20

Port of the LuxAlgo **Volume Profile with Node Detection** indicator, default settings
(`lib/scanner/strategy/harmonicScan/volumeProfile.js`):

| setting | value |
|---|---|
| Profile Lookback Length | 360 bars |
| Profile Number of Rows | 100 |
| Value Area | 70 % |
| Volume Peaks | Peaks · Node Detection Percent 9 % · Volume Node Threshold 1 % |

A **peak node** (the blue zone) is a price row whose volume is higher than each of the 9 rows below and the
9 rows above it (9 % of 100 rows) and above 1 % of the biggest row.

## New checkbox (Harmonic card, next to the breaker options)
**Require a blue Volume Profile peak zone inside that breaker block**

Setup is kept only when all three overlap:
1. the **D zone** overlaps a **breaker block** (same rule as "Require breaker block overlapping D zone")
2. the **blue peak zone** overlaps **that same breaker block**
3. (so D zone ∩ breaker ∩ blue zone)

- with both checkboxes ON → exactly as you described
- the new box on its own also needs a breaker through D (it switches breaker detection on by itself)
- nodes that do not touch the breaker are ignored; setups with no node inside the breaker are dropped
- OFF = nothing changes

## Chart
The blue zone is drawn in the Scanner/feed SVG chart (`VP PEAK lo–hi`, blue band from the start of the 360-bar
lookback to the right edge) and as an annotation group **"Volume peak (VP)"** in the live chart.
Saved signals keep the zone (`volumeNodes`), so refreshed charts still show it.

## Differences from TradingView (on purpose)
- Volume of each bar is spread over its high–low using the scanned timeframe's own candles. TradingView first
  requests lower-timeframe bars (1h → 5m, ~12× more data). That would multiply Binance requests per coin (ban
  risk); the peak rows barely change.
- The profile is computed once per scan at the last closed bar, like the indicator shows it "now".
