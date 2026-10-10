import { NextResponse } from 'next/server';
import { getState, setState } from '../../../../lib/database/appState.js';
import { SIGNAL_CONFIG } from '../../../../lib/config/signalConfig.js';
import { RECOMMENDED_SCANNER_SETTINGS } from '../../../../lib/config/recommendedScannerSettings.js';
import { sanitizeGateModes } from '../../../../lib/scanner/strategy/chartPattern/gates.js';
import {
  ZONE_PATTERN_DEFAULTS,
  normalizeZonePatternConfig,
} from '../../../../lib/scanner/strategy/zonePattern/config.js';
import {
  DOUBLE_CONFLUENCE_DEFAULTS,
  normalizeDoubleConfluenceConfig,
} from '../../../../lib/scanner/strategy/doubleConfluence/config.js';
import {
  EMA_BUMP_DEFAULTS,
  normalizeEmaBumpConfig,
} from '../../../../lib/scanner/strategy/emaBump/config.js';

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
      sSmcCfg,
      sZonePatternCfg,
      sDhCfg,
      sEbCfg,
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
      getState('smc_config', null),
      getState('zone_pattern_config', null),
      getState('double_confluence_config', null),
      getState('ema_bump_config', null),
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
      strategyMode: ['chart_pattern', 'smc', 'hybrid', 'ict_confluence', 'zone_pattern', 'double_confluence', 'ema_bump'].includes(sStrategy)
        ? sStrategy
        : 'zone_pattern',
      chartPatternConfig: {
        ...RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig,
        ...(sCpCfg && typeof sCpCfg === 'object' ? sCpCfg : {}),
        gateModes: {
          ...RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.gateModes,
          ...(sCpCfg?.gateModes || {}),
        },
      },
      smcConfig: {
        ...RECOMMENDED_SCANNER_SETTINGS.smcConfig,
        ...(sSmcCfg && typeof sSmcCfg === 'object' ? sSmcCfg : {}),
      },
      zonePatternConfig: normalizeZonePatternConfig({
        ...ZONE_PATTERN_DEFAULTS,
        ...(sZonePatternCfg && typeof sZonePatternCfg === 'object' ? sZonePatternCfg : {}),
      }),
      doubleConfluenceConfig: normalizeDoubleConfluenceConfig({
        ...DOUBLE_CONFLUENCE_DEFAULTS,
        ...(sDhCfg && typeof sDhCfg === 'object' ? sDhCfg : {}),
      }),
      emaBumpConfig: normalizeEmaBumpConfig({
        ...EMA_BUMP_DEFAULTS,
        ...(sEbCfg && typeof sEbCfg === 'object' ? sEbCfg : {}),
      }),
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

    if (body.strategyMode != null) {
      const mode = String(body.strategyMode);
      if (!['chart_pattern', 'smc', 'hybrid', 'ict_confluence', 'zone_pattern', 'double_confluence', 'ema_bump'].includes(mode)) {
        return NextResponse.json(
          { error: 'strategyMode must be chart_pattern, smc, hybrid, ict_confluence, zone_pattern, double_confluence, or ema_bump' },
          { status: 400 }
        );
      }
      await setState('strategy_mode', mode);
      out.strategyMode = mode;
      msgs.push(`Strategy: ${mode}`);
    }

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
        const okTfs = ['5m', '15m', '30m', '1h', '2h', '4h', '1d'];
        const list = Array.isArray(incoming.patternTfs) ? incoming.patternTfs.filter((t) => okTfs.includes(t)) : [];
        incoming.patternTfs = list.length ? list : ['15m'];
      }
      if (incoming.enabledPatterns != null) {
        if (incoming.enabledPatterns === 'ALL' || incoming.enabledPatterns === true) {
          incoming.enabledPatterns = 'ALL';
        } else if (Array.isArray(incoming.enabledPatterns)) {
          const list = incoming.enabledPatterns
            .map((x) => String(x || '').toUpperCase().trim())
            .filter(Boolean);
          incoming.enabledPatterns = list.length ? list : 'ALL';
        } else {
          incoming.enabledPatterns = 'ALL';
        }
      }
      if (incoming.gateModes != null) {
        incoming.gateModes = { ...(prev.gateModes || {}), ...sanitizeGateModes(incoming.gateModes) };
      }
      if (incoming.minTp1RR != null) {
        const v = +incoming.minTp1RR;
        incoming.minTp1RR = Number.isFinite(v) ? Math.min(5, Math.max(0.5, v)) : 1.0;
      }
      if (incoming.minSignalScore != null) {
        const v = Math.round(+incoming.minSignalScore);
        incoming.minSignalScore = Number.isFinite(v) ? Math.min(95, Math.max(30, v)) : 55;
        // Keep universal engine floor aligned with admin min score
        incoming.minFinalScore = incoming.minSignalScore;
      }
      if (incoming.gateModes?.wave === 'hard') {
        incoming.waveAnalysisEnabled = true;
        if (!(+incoming.minWaveScore > 0)) incoming.minWaveScore = 40;
      }
      // Maximum pattern / near-setup age in candles (0 = disable age invalidation)
      if (incoming.nearMaxPatternAge != null) {
        const v = Math.round(+incoming.nearMaxPatternAge);
        incoming.nearMaxPatternAge = Number.isFinite(v) ? Math.min(500, Math.max(0, v)) : 30;
      }
      // Stale rescue (ON/OFF + limits)
      if (incoming.nearStaleRescue != null) incoming.nearStaleRescue = incoming.nearStaleRescue === true;
      if (incoming.nearStaleRescueMaxAge != null) {
        const v = Math.round(+incoming.nearStaleRescueMaxAge);
        incoming.nearStaleRescueMaxAge = Number.isFinite(v) ? Math.min(1000, Math.max(0, v)) : 150;
      }
      if (incoming.nearStaleRescueMaxGapATR != null) {
        const v = +incoming.nearStaleRescueMaxGapATR;
        incoming.nearStaleRescueMaxGapATR = Number.isFinite(v) ? Math.min(10, Math.max(0.3, v)) : 1.5;
      }
      if (incoming.weakBreakoutPromote != null) incoming.weakBreakoutPromote = incoming.weakBreakoutPromote === true;
      if (incoming.weakBreakoutMaxChaseR != null) {
        const v = +incoming.weakBreakoutMaxChaseR;
        incoming.weakBreakoutMaxChaseR = Number.isFinite(v) ? Math.min(1.5, Math.max(0.1, v)) : 0.35;
      }
      if (incoming.nearEntryOnLivePrice != null) incoming.nearEntryOnLivePrice = incoming.nearEntryOnLivePrice === true;
      if (incoming.failedBreakoutBufferATR != null) {
        const v = +incoming.failedBreakoutBufferATR;
        incoming.failedBreakoutBufferATR = Number.isFinite(v) ? Math.min(3, Math.max(0.1, v)) : 0.5;
      }
      if (incoming.failedBreakoutConfirmCandles != null) {
        const v = Math.round(+incoming.failedBreakoutConfirmCandles);
        incoming.failedBreakoutConfirmCandles = Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 2;
      }
      if (incoming.minConfluencePillars != null) {
        const v = Math.round(+incoming.minConfluencePillars);
        incoming.minConfluencePillars = Number.isFinite(v) ? Math.min(3, Math.max(0, v)) : 1;
      }
      const next = { ...prev, ...incoming };
      await setState('chart_pattern_config', next);
      out.chartPatternConfig = next;
      msgs.push('Chart pattern settings saved');
    }

    if (body.smcConfig != null && typeof body.smcConfig === 'object') {
      const prev = (await getState('smc_config', null)) || {};
      const incoming = { ...body.smcConfig };
      const setupTfs = ['5m', '15m', '30m'];
      const htfTfs = ['1h', '2h', '4h'];
      if (incoming.setupTf != null) {
        if (!setupTfs.includes(incoming.setupTf)) {
          return NextResponse.json({ error: 'smcConfig.setupTf must be 5m, 15m, or 30m' }, { status: 400 });
        }
      }
      if (incoming.htfTf != null) {
        if (!htfTfs.includes(incoming.htfTf)) {
          return NextResponse.json({ error: 'smcConfig.htfTf must be 1h, 2h, or 4h' }, { status: 400 });
        }
      }
      if (incoming.sweepLookbackBars != null) {
        const v = Math.round(+incoming.sweepLookbackBars);
        incoming.sweepLookbackBars = Number.isFinite(v) ? Math.min(80, Math.max(8, v)) : 28;
      }
      if (incoming.maxBosAgeBars != null) {
        const v = Math.round(+incoming.maxBosAgeBars);
        incoming.maxBosAgeBars = Number.isFinite(v) ? Math.min(48, Math.max(4, v)) : 16;
      }
      const next = { ...prev, setupTf: '15m', htfTf: '1h', ...incoming };
      await setState('smc_config', next);
      out.smcConfig = next;
      msgs.push('ICT SMC settings saved');
    }

    if (body.zonePatternConfig != null && typeof body.zonePatternConfig === 'object') {
      const prev = (await getState('zone_pattern_config', null)) || {};
      const next = normalizeZonePatternConfig({
        ...ZONE_PATTERN_DEFAULTS,
        ...prev,
        ...body.zonePatternConfig,
      });
      await setState('zone_pattern_config', next);
      out.zonePatternConfig = next;
      msgs.push('Zone + Pattern settings saved');
    }

    if (body.doubleConfluenceConfig != null && typeof body.doubleConfluenceConfig === 'object') {
      const prev = (await getState('double_confluence_config', null)) || {};
      const next = normalizeDoubleConfluenceConfig({
        ...DOUBLE_CONFLUENCE_DEFAULTS,
        ...prev,
        ...body.doubleConfluenceConfig,
      });
      await setState('double_confluence_config', next);
      out.doubleConfluenceConfig = next;
      msgs.push('Double Top/Bottom Confluence settings saved');
    }

    if (body.emaBumpConfig != null && typeof body.emaBumpConfig === 'object') {
      const prev = (await getState('ema_bump_config', null)) || {};
      const next = normalizeEmaBumpConfig({
        ...EMA_BUMP_DEFAULTS,
        ...prev,
        ...body.emaBumpConfig,
      });
      await setState('ema_bump_config', next);
      out.emaBumpConfig = next;
      msgs.push('EMA Bump settings saved');
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
