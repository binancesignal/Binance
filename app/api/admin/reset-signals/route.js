import { NextResponse } from 'next/server';
import { getDb, isProductionDbReady } from '../../../../lib/database/index.js';
import { SIGNAL_STATUS } from '../../../../lib/config/signalConfig.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };

const HISTORY_STATUSES = [
  SIGNAL_STATUS.COMPLETED_PROFIT,
  SIGNAL_STATUS.STOPPED,
  SIGNAL_STATUS.INVALIDATED,
];

function checkSecret(request, body = {}) {
  const cronSecret = process.env.CRON_SECRET || '';
  if (!cronSecret) return { ok: true };
  const authHeader = request.headers.get('authorization') || '';
  const url = new URL(request.url);
  const token = (
    authHeader.replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('secret') ||
    body.secret ||
    ''
  ).trim();
  if (token !== cronSecret.trim()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Unauthorized — CRON_SECRET වැරදියි.' },
        { status: 401 }
      ),
    };
  }
  return { ok: true };
}

/**
 * GET — preview what would be deleted (no delete).
 * Query: ?secret=CRON_SECRET
 */
export async function GET(request) {
  try {
    const auth = checkSecret(request);
    if (!auth.ok) return auth.response;

    const db = getDb();
    const byStatus = {
      WATCHING: [],
      READY: [],
      ONGOING: [],
      COMPLETED_PROFIT: [],
      STOPPED: [],
      INVALIDATED: [],
    };

    if (db.type === 'supabase') {
      const { data, error } = await db.client
        .from('signals')
        .select('signal_id, symbol, direction, status, score, entry, created_at, metadata')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      for (const row of data || []) {
        const st = String(row.status || '').toUpperCase();
        if (byStatus[st]) byStatus[st].push(row);
        else {
          if (!byStatus.OTHER) byStatus.OTHER = [];
          byStatus.OTHER.push(row);
        }
      }
    } else {
      for (const row of db.store.signals?.values() || []) {
        const st = String(row.status || '').toUpperCase();
        if (byStatus[st]) byStatus[st].push(row);
      }
    }

    const counts = {};
    let total = 0;
    let historyCount = 0;
    for (const [k, arr] of Object.entries(byStatus)) {
      counts[k] = arr.length;
      total += arr.length;
      if (HISTORY_STATUSES.includes(k)) historyCount += arr.length;
    }

    const preview = Object.values(byStatus)
      .flat()
      .slice(0, 40)
      .map((s) => ({
        signal_id: s.signal_id,
        symbol: s.symbol,
        direction: s.direction,
        status: s.status,
        score: s.score,
        entry: s.entry,
        pattern: s.metadata?.pattern || s.metadata?.patternType || null,
        created_at: s.created_at,
      }));

    return NextResponse.json({
      ok: true,
      total,
      historyCount,
      activeCount: total - historyCount,
      counts,
      preview,
      msg: `${total} signals in DB (${historyCount} history, ${total - historyCount} active)`,
    }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json(
      { error: String(e.message || e), code: e?.code },
      { status: e?.code === 'DB_NOT_CONFIGURED' ? 503 : 500, headers: NO_STORE }
    );
  }
}

/**
 * POST — delete signals.
 * Body: { confirm: true, secret?, mode?: 'all' | 'history' }
 *   all     = delete every signal + events + scan_runs
 *   history = delete only COMPLETED_PROFIT / STOPPED / INVALIDATED
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.confirm !== true) {
      return NextResponse.json(
        { error: 'Confirmation required. Send { "confirm": true }' },
        { status: 400 }
      );
    }

    const auth = checkSecret(request, body);
    if (!auth.ok) return auth.response;

    if (process.env.NODE_ENV === 'production' && !isProductionDbReady()) {
      return NextResponse.json(
        { error: 'Supabase not configured on server' },
        { status: 503 }
      );
    }

    const mode = body.mode === 'history' ? 'history' : 'all';
    const db = getDb();
    let signalsDeleted = 0;
    let eventsDeleted = 0;
    let runsDeleted = 0;
    const errors = [];

    if (db.type === 'supabase') {
      const since = '1970-01-01T00:00:00.000Z';

      if (mode === 'history') {
        // Only terminal statuses
        const { data, error } = await db.client
          .from('signals')
          .delete()
          .in('status', HISTORY_STATUSES)
          .select('signal_id');
        if (error) {
          errors.push(`signals history: ${error.message}`);
        } else {
          signalsDeleted = (data || []).length;
        }
        // orphan events for deleted history ids are optional cleanup — skip heavy ops
      } else {
        {
          const { data, error } = await db.client
            .from('signal_events')
            .delete()
            .gte('created_at', since)
            .select('id');
          if (error) errors.push(`signal_events: ${error.message}`);
          else eventsDeleted = (data || []).length;
        }
        {
          const { data, error } = await db.client
            .from('signals')
            .delete()
            .gte('created_at', since)
            .select('signal_id');
          if (error) errors.push(`signals: ${error.message}`);
          else signalsDeleted = (data || []).length;
        }
        {
          const { data, error } = await db.client
            .from('scan_runs')
            .delete()
            .gte('started_at', since)
            .select('id');
          if (error) errors.push(`scan_runs: ${error.message}`);
          else runsDeleted = (data || []).length;
        }
      }

      // Verify deletion really happened in Supabase (never report success blindly).
      const count = async (table, col) => {
        const { count: n, error } = await db.client
          .from(table)
          .select(col, { count: 'exact', head: true });
        if (error) throw new Error(`verify ${table}: ${error.message}`);
        return n || 0;
      };
      let remaining = null;
      try {
        if (mode === 'all') {
          remaining = {
            signals: await count('signals', 'signal_id'),
            signal_events: await count('signal_events', 'id'),
            scan_runs: await count('scan_runs', 'id'),
          };
        } else {
          const { count: n, error } = await db.client
            .from('signals')
            .select('signal_id', { count: 'exact', head: true })
            .in('status', HISTORY_STATUSES);
          if (error) throw new Error(`verify signals: ${error.message}`);
          remaining = { history_signals: n || 0 };
        }
      } catch (ve) {
        errors.push(ve.message);
      }
      const leftover = remaining && Object.values(remaining).some((n) => n > 0);
      console.log('[reset-signals]', JSON.stringify({ mode, signalsDeleted, eventsDeleted, runsDeleted, remaining, errors }));

      if (errors.length || leftover) {
        return NextResponse.json(
          {
            ok: false,
            error: errors.length
              ? errors.join('; ')
              : `Reset incomplete — rows remain: ${JSON.stringify(remaining)}`,
            remaining,
            signalsDeleted,
            eventsDeleted,
            runsDeleted,
            hint: 'Check SUPABASE_SERVICE_ROLE_KEY is set in Vercel env',
          },
          { status: 500, headers: NO_STORE }
        );
      }
    } else {
      if (mode === 'history') {
        const toDel = [];
        for (const [id, s] of db.store.signals || []) {
          if (HISTORY_STATUSES.includes(String(s.status || '').toUpperCase())) {
            toDel.push(id);
          }
        }
        for (const id of toDel) db.store.signals.delete(id);
        signalsDeleted = toDel.length;
      } else {
        signalsDeleted = db.store.signals?.size || 0;
        eventsDeleted = db.store.events?.length || 0;
        runsDeleted = db.store.scanRuns?.length || 0;
        if (db.store.signals) db.store.signals.clear();
        if (db.store.events) db.store.events.length = 0;
        if (db.store.scanRuns) db.store.scanRuns.length = 0;
      }
    }

    return NextResponse.json({
      ok: true,
      mode,
      signalsDeleted,
      eventsDeleted,
      runsDeleted,
      verified: true,
      msg:
        mode === 'history'
          ? `Deleted ${signalsDeleted} history signals (active kept).`
          : `Deleted ${signalsDeleted} signals, ${eventsDeleted} events, ${runsDeleted} scan runs. Settings/Telegram kept.`,
    }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json(
      { error: String(e.message || e), code: e?.code },
      { status: e?.code === 'DB_NOT_CONFIGURED' ? 503 : 500, headers: NO_STORE }
    );
  }
}
