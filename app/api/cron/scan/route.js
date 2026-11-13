import { NextResponse, after } from 'next/server';
import { runFullScan } from '../../../../lib/scanner/scanner.js';
import { isProductionDbReady } from '../../../../lib/database/index.js';
import { getState } from '../../../../lib/database/appState.js';
import { processAutoTrades } from '../../../../lib/trading/autoTrader.js';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request) {
  return handleScan(request);
}

export async function POST(request) {
  return handleScan(request);
}

async function handleScan(request) {
  const authHeader = request.headers.get('authorization') || '';
  const cronSecret = process.env.CRON_SECRET;
  const url = new URL(request.url);
  const querySecret = url.searchParams.get('secret');

  if (cronSecret) {
    const token = authHeader.replace(/^Bearer\s+/i, '') || querySecret;
    if (token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured' },
      { status: 500 }
    );
  }

  // Auto-scan toggle — default OFF
  try {
    const enabled = await getState('auto_scan_enabled', false);
    if (!enabled) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: 'auto_scan_enabled is false — start from dashboard',
      });
    }
  } catch (e) {
    console.error('[cron] auto_scan check failed', e.message);
  }

  if (process.env.NODE_ENV === 'production' && !isProductionDbReady()) {
    return NextResponse.json(
      {
        error:
          'Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
      },
      { status: 503 }
    );
  }

  // Background by default: answer instantly, run the lifecycle scan in after().
  // `&wait=1` keeps the old "hold the response until finished" behaviour for debugging.
  if (url.searchParams.get('wait') === '1') {
    const out = await executeLifecycleScan();
    return NextResponse.json(out.body, { status: out.status });
  }
  after(async () => {
    try {
      const out = await executeLifecycleScan();
      if (out.status >= 400) console.error('[cron/scan] background run failed', JSON.stringify(out.body));
    } catch (e) {
      console.error('[cron/scan] background crash', e);
    }
  });
  return NextResponse.json({
    ok: true,
    started: true,
    background: true,
    msg: 'lifecycle scan started in background — see Admin → Scan log for the result',
  });
}

async function executeLifecycleScan() {
  try {
    const result = await runFullScan('cron');

    let autoTrade = {
      autoTradingEnabled: false,
      autoTradesAttempted: 0,
      autoTradesPlaced: 0,
      autoTradesSkipped: 0,
      autoTradesFailed: 0,
    };
    try {
      if (result.ok && !result.skipped) {
        autoTrade = await processAutoTrades();
      }
    } catch (ae) {
      console.error('[cron] auto-trade', ae.message);
      autoTrade.autoTradesFailed = 1;
      autoTrade.error = ae.message;
    }

    // Return ONLY a tiny summary — cron-job.org / external crons
    // abort if response body is too large.
    const summary = {
      ok: !!result.ok,
      skipped: !!result.skipped,
      partial: !!result.partial,
      byExchange: result.byExchange || null,
      scanRunId: result.scanRunId ?? null,
      symbolsScanned: result.symbolsScanned ?? 0,
      signalsCreated: result.signalsCreated ?? 0,
      signalsUpdated: result.signalsUpdated ?? 0,
      watching: result.watching_count ?? 0,
      ready: result.ready_count ?? 0,
      ongoing: result.ongoing_count ?? 0,
      telegramSent: result.telegramSent ?? 0,
      errorCount: result.errorCount ?? 0,
      autoTradingEnabled: !!autoTrade.autoTradingEnabled,
      autoTradesAttempted: autoTrade.autoTradesAttempted ?? 0,
      autoTradesPlaced: autoTrade.autoTradesPlaced ?? 0,
      autoTradesSkipped: autoTrade.autoTradesSkipped ?? 0,
      autoTradesFailed: autoTrade.autoTradesFailed ?? 0,
      // one-line status for easy log reading
      msg: result.ok
        ? `scanned ${result.symbolsScanned ?? 0}, created ${result.signalsCreated ?? 0}, tg ${result.telegramSent ?? 0}, auto ${autoTrade.autoTradesPlaced ?? 0}/${autoTrade.autoTradesAttempted ?? 0}`
        : result.reason || result.error || 'failed',
    };

    return { status: 200, body: summary };
  } catch (e) {
    console.error('[cron/scan]', e);
    return { status: 500, body: { ok: false, error: String(e.message || e).slice(0, 200) } };
  }
}
