import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getAutoTradingConfig } from '../../../../lib/trading/autoConfig.js';
import { resolveHighRiskConfig, HIGH_RISK_MARGIN_FLOOR } from '../../../../lib/trading/riskSizing.js';
import { setState } from '../../../../lib/database/appState.js';
import {
  getUserById,
  getUserTradingSettings,
  setUserTradingSettings,
  canAutoTrade,
  getPlan,
} from '../../../../lib/database/users.js';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const settings = await getUserTradingSettings(session.userId);
  const cfg = await getAutoTradingConfig();
  // public view of the High Risk parameters so the Trade tab can show exact numbers
  const highRiskConfig = resolveHighRiskConfig(cfg.highRisk, settings);
  return NextResponse.json({
    ...settings,
    highRiskConfig,
    manualEntryEnabled: !!cfg.manualEntryEnabled,
    freeManualTradeEnabled: cfg.freeManualTradeEnabled !== false,
  });
}

export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json();
    const user = await getUserById(session.userId);
    const plan = await getPlan(user.plan);
    const current = await getUserTradingSettings(session.userId);

    // Exchange selection and the auto-trade switch are managed by /api/user/exchanges
    // (one exchange at a time, must be connected). Ignore them here.
    const {
      autoTradingEnabled: _a,
      autoTradeExchange: _b,
      selectedExchange: _c,
      highRiskConfig: _d,
      capital: _e, // only /api/user/capital may change it (validated against the wallet)
      riskMode,
      confirmHighRisk,
      highRiskMarginPercent,
      ...rest
    } = body || {};
    const next = {
      ...current,
      ...rest,
    };

    // Risk mode: High Risk is the only mode. It needs a one-time explicit confirmation.
    if (riskMode !== undefined || highRiskMarginPercent !== undefined) {
      const cfg = await getAutoTradingConfig();
      const hr = resolveHighRiskConfig(cfg.highRisk, {});
      if (riskMode !== undefined && riskMode !== 'high') {
        return NextResponse.json({ error: 'High Risk is the only available risk mode' }, { status: 400 });
      }
      if (current.riskMode !== 'high' && confirmHighRisk !== true) {
        return NextResponse.json(
          { error: 'Confirm that you understand the risk of High Risk mode', needsConfirm: true },
          { status: 400 }
        );
      }
      if (highRiskMarginPercent !== undefined) {
        const pct = Number(highRiskMarginPercent);
        if (!Number.isFinite(pct)) return NextResponse.json({ error: 'Invalid margin %' }, { status: 400 });
        next.highRiskMarginPercent = Math.min(hr.maxMarginPercent, Math.max(HIGH_RISK_MARGIN_FLOOR, pct));
      }
      if (current.riskMode !== 'high') {
        // fresh baseline for the daily-loss / drawdown brakes when High Risk is first switched on
        // must be {} not null — app_state.value is JSONB NOT NULL
        await setState(`risk_guard:${session.userId}`, {});
      }
      next.riskMode = 'high';
    }

    // clamp by plan
    if (plan?.max_positions) {
      next.maxOpenPositions = Math.min(next.maxOpenPositions || 3, plan.max_positions);
    }

    await setUserTradingSettings(session.userId, next);
    return NextResponse.json(next);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
