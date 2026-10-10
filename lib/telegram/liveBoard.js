/**
 * One editable Telegram "LIVE SIGNAL BOARD" message.
 * Structure: one row per coin | WATCHING | READY | ONGOING columns
 * + compact ONGOING detail blocks (entry / market / PnL / TP ladder).
 * sendMessage on first run; editMessageText on subsequent scans.
 */
import { getState, setState } from '../database/appState.js';
import { getActiveSignals, getHistorySignals } from '../database/signals.js';
import { SIGNAL_STATUS } from '../config/signalConfig.js';
import { getTelegramNotifyConfig } from './notifyConfig.js';
import { nowLK } from '../utils/time.js';
import {
  formatResolvedOutcome,
  getRecentResolvedOutcomes,
  summarizeResolvedOutcomes,
} from './boardOutcomes.js';

async function getTelegramCredentials() {
  let token = process.env.TELEGRAM_BOT_TOKEN || '';
  let chatId = process.env.TELEGRAM_CHAT_ID || '';
  try {
    const stored = await getState('telegram_config', null);
    if (stored && typeof stored === 'object') {
      if (stored.bot_token) token = stored.bot_token;
      if (stored.chat_id) chatId = String(stored.chat_id);
    }
  } catch (_) {}
  return { token, chatId };
}

function pad(str, width, align = 'left') {
  const s = String(str ?? '');
  if (s.length === width) return s;
  if (s.length > width) return s.slice(0, width);
  const gap = width - s.length;
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const L = Math.floor(gap / 2);
    return ' '.repeat(L) + s + ' '.repeat(gap - L);
  }
  return s + ' '.repeat(gap);
}

function fmtPrice(v) {
  if (v == null || !Number.isFinite(+v)) return '—';
  const n = +v;
  const a = Math.abs(n);
  if (a >= 1000) return n.toFixed(2);
  if (a >= 1) return n.toFixed(4);
  if (a >= 0.01) return n.toFixed(5);
  return Number(n.toPrecision(5)).toString();
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(+v)) return null;
  const n = +v;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function pnlOf(s) {
  const cur = +s.current_pnl_percent;
  if (Number.isFinite(cur)) return cur;
  const maxP = +s.max_profit_percent;
  const maxL = +s.max_loss_percent;
  if (Number.isFinite(maxP) && Number.isFinite(maxL)) {
    return Math.abs(maxP) >= Math.abs(maxL) ? maxP : maxL;
  }
  if (Number.isFinite(maxP)) return maxP;
  if (Number.isFinite(maxL)) return maxL;
  return null;
}

function marketPriceOf(s) {
  const p = +s.current_price;
  if (Number.isFinite(p) && p > 0) return p;
  const lp = +s.last_price;
  if (Number.isFinite(lp) && lp > 0) return lp;
  return null;
}

function dirLabel(s) {
  const d = String(s.direction || s.dir || '').toUpperCase();
  if (d === 'LONG') return 'LONG';
  if (d === 'SHORT') return 'SHORT';
  return d || '—';
}

/**
 * Status cells — fixed tokens for stable alignment.
 * Progression from authoritative status only:
 *   WATCHING → [👀] [—] [—]
 *   READY    → [✅] [🚀] [—]
 *   ONGOING  → [✅] [✅] [🟢]
 */
function statusCells(status) {
  const st = String(status || '').toUpperCase();
  if (st === SIGNAL_STATUS.ONGOING) return { w: '[✅]', r: '[✅]', o: '[🟢]' };
  if (st === SIGNAL_STATUS.READY) return { w: '[✅]', r: '[🚀]', o: '[—]' };
  if (st === SIGNAL_STATUS.WATCHING) return { w: '[👀]', r: '[—]', o: '[—]' };
  return { w: '[—]', r: '[—]', o: '[—]' };
}

const COL = { coin: 10, cell: 5 };

function formatTableRow(symbol, cells) {
  const coinStr = pad(String(symbol || '').slice(0, COL.coin), COL.coin, 'left');
  return (
    coinStr +
    ' ' +
    pad(cells.w, COL.cell, 'center') +
    ' ' +
    pad(cells.r, COL.cell, 'center') +
    ' ' +
    pad(cells.o, COL.cell, 'center')
  );
}

function formatHeaderRow() {
  return (
    pad('COIN', COL.coin, 'left') +
    ' ' +
    pad('W', COL.cell, 'center') +
    ' ' +
    pad('R', COL.cell, 'center') +
    ' ' +
    pad('O', COL.cell, 'center')
  );
}

function pickPrimaryBySymbol(signals) {
  const rank = {
    [SIGNAL_STATUS.ONGOING]: 3,
    [SIGNAL_STATUS.READY]: 2,
    [SIGNAL_STATUS.WATCHING]: 1,
  };
  const map = new Map();
  for (const s of signals) {
    const sym = s.symbol;
    if (!sym) continue;
    const prev = map.get(sym);
    if (!prev) {
      map.set(sym, s);
      continue;
    }
    const pr = rank[String(prev.status).toUpperCase()] || 0;
    const cr = rank[String(s.status).toUpperCase()] || 0;
    if (cr > pr) map.set(sym, s);
  }
  return [...map.values()];
}

function sortBoardRows(list) {
  const rank = {
    [SIGNAL_STATUS.ONGOING]: 0,
    [SIGNAL_STATUS.READY]: 1,
    [SIGNAL_STATUS.WATCHING]: 2,
  };
  return [...list].sort((a, b) => {
    const ra = rank[String(a.status).toUpperCase()] ?? 9;
    const rb = rank[String(b.status).toUpperCase()] ?? 9;
    if (ra !== rb) return ra - rb;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
}

function tpLine(label, price, hit) {
  const p = fmtPrice(price);
  if (hit) return `${pad(label, 6, 'left')} ✅ ${p}`;
  return `${pad(label, 6, 'left')} →  ${p}`;
}

function autoStatusOf(s) {
  const meta = s.metadata || {};
  const st = meta.auto_trade_status || s.auto_trade_status || null;
  if (!st) return null;
  const u = String(st).toUpperCase();
  if (u === 'PLACED' || u === 'FILLED') return '🟢 PLACED';
  if (u === 'PENDING' || u === 'PLACING') return '⏳ PENDING';
  if (u === 'FAILED') return '⚠️ FAILED';
  if (u === 'SKIPPED') return '⛔ SKIPPED';
  return null;
}

function formatOngoingDetail(s) {
  const lines = [];
  lines.push(`🟢 ${s.symbol} ${dirLabel(s)}`);
  lines.push(`${pad('Entry', 7, 'left')}${fmtPrice(s.entry ?? s.entry_hit_price)}`);
  lines.push(`${pad('Market', 7, 'left')}${fmtPrice(marketPriceOf(s))}`);
  const pnl = fmtPct(pnlOf(s));
  if (pnl != null) lines.push(`${pad('PnL', 7, 'left')}${pnl}`);
  const auto = autoStatusOf(s);
  if (auto) lines.push(`${pad('Auto', 7, 'left')}${auto}`);
  lines.push(tpLine('TP1', s.tp1, !!s.tp1_hit));
  lines.push(tpLine('TP2', s.tp2, !!s.tp2_hit));
  lines.push(tpLine('TP3', s.tp3, !!s.tp3_hit));
  lines.push(
    tpLine(
      'SL',
      s.sl,
      !!s.sl_hit || String(s.status).toUpperCase() === SIGNAL_STATUS.STOPPED
    )
  );
  return lines.join('\n');
}

function truncate(text, max = 3900) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max - 20) + '\n…(truncated)';
}

function buildBoardKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 ALL', callback_data: 'board:all' },
        { text: '🔄 REFRESH', callback_data: 'board:refresh' },
      ],
      [{ text: '📈 READY charts', callback_data: 'analyze:ready' }],
      [{ text: '🪙 Chart any coin', callback_data: 'analyze:coin' }],
    ],
  };
}

export async function buildLiveBoardText(scanSummary = {}, recentEvents = []) {
  const cfg = await getTelegramNotifyConfig();
  const [all, history] = await Promise.all([
    getActiveSignals(),
    getHistorySignals(30, [SIGNAL_STATUS.COMPLETED_PROFIT, SIGNAL_STATUS.STOPPED]),
  ]);
  const active = (all || []).filter((s) => {
    const st = String(s.status || '').toUpperCase();
    return (
      st === SIGNAL_STATUS.WATCHING ||
      st === SIGNAL_STATUS.READY ||
      st === SIGNAL_STATUS.ONGOING
    );
  });

  const rows = sortBoardRows(pickPrimaryBySymbol(active));
  const watching = rows.filter((s) => String(s.status).toUpperCase() === SIGNAL_STATUS.WATCHING);
  const ready = rows.filter((s) => String(s.status).toUpperCase() === SIGNAL_STATUS.READY);
  const ongoing = rows.filter((s) => String(s.status).toUpperCase() === SIGNAL_STATUS.ONGOING);
  const outcomes = getRecentResolvedOutcomes(history);
  const outcomeSummary = summarizeResolvedOutcomes(outcomes);

  const updated = nowLK();
  let timeStr = updated;
  try {
    const m = String(updated).match(/(\d{2}:\d{2}:\d{2})/);
    if (m) timeStr = m[1];
  } catch (_) {}

  const lines = [];
  lines.push('📡 <b>LIVE SIGNAL BOARD</b>');
  lines.push(`Updated ${timeStr}`);
  lines.push('');
  lines.push(`👀 ${watching.length}   🚀 ${ready.length}   🟢 ${ongoing.length}`);

  let openPnl = 0;
  let hasPnl = false;
  for (const s of ongoing) {
    const p = pnlOf(s);
    if (p != null) {
      openPnl += p;
      hasPnl = true;
    }
  }
  if (hasPnl) {
    const sign = openPnl > 0 ? '+' : '';
    lines.push(`💰 Open PnL ${sign}${openPnl.toFixed(2)}%`);
  }

  lines.push('');
  lines.push('<code>' + formatHeaderRow() + '</code>');
  lines.push('<code>' + '─'.repeat(COL.coin + 1 + COL.cell * 3 + 2) + '</code>');

  if (!rows.length) {
    lines.push('<i>No active signals</i>');
  } else {
    for (const s of rows) {
      lines.push('<code>' + formatTableRow(s.symbol, statusCells(s.status)) + '</code>');
    }
  }

  lines.push('');
  lines.push('<i>W=Watching  R=Ready  O=Ongoing</i>');

  if (outcomes.length) {
    lines.push('');
    lines.push(`<b>RECENT RESULTS · LAST ${outcomeSummary.total}</b>`);
    lines.push(`✅ TP3 ${outcomeSummary.tp3} · 🔴 SL HIT ${outcomeSummary.sl}`);
    for (const outcome of outcomes) {
      lines.push('<code>' + formatResolvedOutcome(outcome) + '</code>');
      lines.push('━━━━━━━━━━━━━━━━━━━━');
    }
  }

  if (ongoing.length) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    for (const s of ongoing.slice(0, 8)) {
      lines.push('<code>' + formatOngoingDetail(s) + '</code>');
      lines.push('━━━━━━━━━━━━━━━━━━━━');
    }
    if (ongoing.length > 8) lines.push(`… +${ongoing.length - 8} more ongoing`);
  }

  const limit = cfg.recentEventsLimit ?? 10;
  if (limit > 0 && recentEvents && recentEvents.length) {
    lines.push('');
    lines.push('<b>RECENT</b>');
    for (const ev of recentEvents.slice(0, Math.min(limit, 6))) {
      const t = (ev.time || '').toString().slice(-8);
      lines.push(`· ${t}  ${ev.text || ''}`.trim());
    }
  }

  if (cfg.scanSummary && scanSummary && typeof scanSummary === 'object') {
    const bits = [];
    if (scanSummary.symbolsScanned != null) bits.push(`${scanSummary.symbolsScanned} coins`);
    if (scanSummary.signalsCreated != null) bits.push(`+${scanSummary.signalsCreated} new`);
    if (bits.length) {
      lines.push('');
      lines.push(`📊 ${bits.join(' · ')}`);
    }
  }

  return truncate(lines.join('\n'));
}

async function tgApi(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function upsertLiveBoard(scanSummary = {}, recentEvents = [], options = {}) {
  const force = !!options.force;
  const cfg = await getTelegramNotifyConfig();
  if (!cfg.masterEnabled && !force) {
    return { ok: false, skipped: true, reason: 'master off — turn Master Telegram ON' };
  }
  if (!force && cfg.notificationMode === 'every_event') {
    return {
      ok: false,
      skipped: true,
      reason: 'every_event mode — switch to Live Board, or use Refresh (force)',
    };
  }

  const { token, chatId } = await getTelegramCredentials();
  if (!token || !chatId) return { ok: false, skipped: true, reason: 'not configured' };

  const text = await buildLiveBoardText(scanSummary, recentEvents);
  const reply_markup = buildBoardKeyboard();
  const storedId = await getState('telegram_live_board_message_id', null);
  const storedChat = await getState('telegram_live_board_chat_id', null);

  if (storedId && String(storedChat || '') === String(chatId)) {
    const data = await tgApi(token, 'editMessageText', {
      chat_id: chatId,
      message_id: storedId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup,
    });
    if (data.ok) return { ok: true, edited: true, message_id: storedId };
    const desc = String(data.description || data.error_code || '');
    if (/message is not modified/i.test(desc)) {
      try {
        await tgApi(token, 'editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: storedId,
          reply_markup,
        });
      } catch (_) {}
      return { ok: true, edited: true, unchanged: true, message_id: storedId };
    }
    console.warn('[LiveBoard] edit failed, clearing id and resending', desc);
    try {
      await setState('telegram_live_board_message_id', null);
      await setState('telegram_live_board_chat_id', null);
    } catch (_) {}
  }

  const data = await tgApi(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup,
  });
  if (!data.ok) {
    console.error('[LiveBoard] send failed', data);
    return { ok: false, error: data };
  }
  const messageId = data.result?.message_id;
  if (messageId != null) {
    await setState('telegram_live_board_message_id', messageId);
    await setState('telegram_live_board_chat_id', String(chatId));
  }
  return { ok: true, sent: true, message_id: messageId };
}

export async function pushLiveBoardEvent(text) {
  try {
    const cfg = await getTelegramNotifyConfig();
    const limit = Math.max(1, cfg.recentEventsLimit || 10);
    const prev = (await getState('telegram_live_board_events', null)) || [];
    const list = Array.isArray(prev) ? prev : [];
    const entry = { time: nowLK(), text: String(text).slice(0, 120) };
    const next = [entry, ...list].slice(0, limit);
    await setState('telegram_live_board_events', next);
    return next;
  } catch (_) {
    return [];
  }
}

export async function getLiveBoardEvents() {
  try {
    const prev = (await getState('telegram_live_board_events', null)) || [];
    return Array.isArray(prev) ? prev : [];
  } catch (_) {
    return [];
  }
}
