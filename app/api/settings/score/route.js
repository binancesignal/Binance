import { NextResponse } from 'next/server';
import { getState, setState } from '../../../../lib/database/appState.js';
import { SIGNAL_CONFIG } from '../../../../lib/config/signalConfig.js';
import { sanitizeGateModes } from '../../../../lib/scanner/strategy/chartPattern/gates.js';

export const dynamic = 'force-dynamic';

function boolOr(stored, fallback) {
  if (stored === true || stored === false) return stored;
  return fallback;
}

export async function GET() {
  try {
    const [
      storedScore,
      storedMin,
      storedMax,
      storedTg,
      storedGap,
      sHtf,
      sLiq,
      sSw,
      sStrategy,
      sCpCfg,
    ] = await Promise.all([
      getState('min_score', null),
      getState('min_entry_atr', null),
      getState('max_entry_atr', null),
      getState('telegram_max_atr', null),
      getState('max_gap_percent', null),
      getState('require_htf_aligned', null),
      getState('require_liquidity_edge', null),
      getState('require_sweep_or_fvg', null),
      getState('strategy_mode', null),
      getState('chart_pattern_config', null),
    ]);

    const minScore =
      storedScore != null && Number.isFinite(+storedScore)
        ? Math.round(+storedScore)
        : SIGNAL_CONFIG.minScore;
    const minEntryATR =
      storedMin != null && Number.isFinite(+storedMin)
        ? +storedMin
        : SIGNAL_CONFIG.minEntryDistanceATR ?? 0.75;
    const maxEntryATR =
      storedMax != null && Number.isFinite(+storedMax)
        ? +storedMax
        : SIGNAL_CONFIG.maxEntryDistanceATR ?? 4;
    const telegramMaxATR =
      storedTg != null && Number.isFinite(+storedTg)
        ? +storedTg
        : SIGNAL_CONFIG.telegramMaxDistanceATR ?? 2;
    const maxGapPercent =
      storedGap != null && Number.isFinite(+storedGap)
        ? +storedGap
        : SIGNAL_CONFIG.maxGapPercent ?? 3;

    return NextResponse.json({
      ok: true,
      minScore,
      minEntryATR,
      maxEntryATR,
      telegramMaxATR,
      maxGapPercent,
      requireHtfAligned: boolOr(sHtf, SIGNAL_CONFIG.requireHtfAligned !== false),
      requireLiquidityEdge: boolOr(
        sLiq,
        SIGNAL_CONFIG.requireLiquidityEdge !== false
      ),
      requireSweepOrFvg: boolOr(sSw, !!SIGNAL_CONFIG.requireSweepOrFvg),
      strategyMode: 'chart_pattern',
      chartPatternConfig: sCpCfg && typeof sCpCfg === 'object' ? sCpCfg : {},
      scanUniverse: SIGNAL_CONFIG.scanUniverse,
      scanChunkSize: SIGNAL_CONFIG.scanChunkSize,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const out = { ok: true };
    const msgs = [];

    if (body.minScore != null) {
      const n = Math.round(+body.minScore);
      if (!Number.isFinite(n) || n < 50 || n > 100) {
        return NextResponse.json({ error: 'minScore must be 50–100' }, { status: 400 });
      }
      await setState('min_score', n);
      out.minScore = n;
      msgs.push(`Min score ≥ ${n}`);
    }
    if (body.minEntryATR != null) {
      const a = +body.minEntryATR;
      if (!Number.isFinite(a) || a < 0 || a > 20) {
        return NextResponse.json({ error: 'minEntryATR invalid' }, { status: 400 });
      }
      await setState('min_entry_atr', a);
      out.minEntryATR = a;
      msgs.push(`Min entry ATR ${a}`);
    }
    if (body.maxEntryATR != null) {
      const a = +body.maxEntryATR;
      if (!Number.isFinite(a) || a < 0.5 || a > 50) {
        return NextResponse.json({ error: 'maxEntryATR invalid' }, { status: 400 });
      }
      await setState('max_entry_atr', a);
      out.maxEntryATR = a;
      msgs.push(`Max entry ATR ${a}`);
    }
    if (body.telegramMaxATR != null) {
      const a = +body.telegramMaxATR;
      if (!Number.isFinite(a) || a < 0.5 || a > 50) {
        return NextResponse.json({ error: 'telegramMaxATR invalid' }, { status: 400 });
      }
      await setState('telegram_max_atr', a);
      out.telegramMaxATR = a;
      msgs.push(`TG max ATR ${a}`);
    }
    if (body.maxGapPercent != null) {
      const g = +body.maxGapPercent;
      if (!Number.isFinite(g) || g < 0.5 || g > 50) {
        return NextResponse.json({ error: 'maxGapPercent invalid' }, { status: 400 });
      }
      await setState('max_gap_percent', g);
      out.maxGapPercent = g;
      msgs.push(`Max gap ≤ ${g}%`);
    }
    if (typeof body.requireHtfAligned === 'boolean') {
      await setState('require_htf_aligned', body.requireHtfAligned);
      out.requireHtfAligned = body.requireHtfAligned;
      msgs.push(`HTF aligned: ${body.requireHtfAligned ? 'ON' : 'OFF'}`);
    }
    if (typeof body.requireLiquidityEdge === 'boolean') {
      await setState('require_liquidity_edge', body.requireLiquidityEdge);
      out.requireLiquidityEdge = body.requireLiquidityEdge;
      msgs.push(`Liquidity edge: ${body.requireLiquidityEdge ? 'ON' : 'OFF'}`);
    }
    if (typeof body.requireSweepOrFvg === 'boolean') {
      await setState('require_sweep_or_fvg', body.requireSweepOrFvg);
      out.requireSweepOrFvg = body.requireSweepOrFvg;
      msgs.push(`Sweep/FVG required: ${body.requireSweepOrFvg ? 'ON' : 'OFF'}`);
    }
    if (body.chartPatternConfig != null && typeof body.chartPatternConfig === 'object') {
      const prev = (await getState('chart_pattern_config', null)) || {};
      const incoming = { ...body.chartPatternConfig };
      if (incoming.patternTfs != null) {
        const okTfs = ['5m', '15m', '30m', '1h', '2h'];
        const list = Array.isArray(incoming.patternTfs) ? incoming.patternTfs.filter((t) => okTfs.includes(t)) : [];
        incoming.patternTfs = list.length ? list : ['15m'];
      }
      if (incoming.gateModes != null) {
        incoming.gateModes = { ...(prev.gateModes || {}), ...sanitizeGateModes(incoming.gateModes) };
      }
      if (incoming.minTp1RR != null) {
        const v = +incoming.minTp1RR;
        incoming.minTp1RR = Number.isFinite(v) ? Math.min(5, Math.max(0.5, v)) : 1.0;
      }
      // Maximum pattern / near-setup age in candles (0 = disable age invalidation)
      if (incoming.nearMaxPatternAge != null) {
        const v = Math.round(+incoming.nearMaxPatternAge);
        incoming.nearMaxPatternAge = Number.isFinite(v) ? Math.min(500, Math.max(0, v)) : 30;
      }
      const next = { ...prev, ...incoming };
      await setState('chart_pattern_config', next);
      out.chartPatternConfig = next;
      msgs.push('Chart pattern settings saved');
    }

    if (!msgs.length) {
      return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 });
    }
    out.msg = msgs.join(' · ');
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
