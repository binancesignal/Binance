/**
 * Telegram: LIMIT ORDER READY = text+chart; ENTRY/TP/SL = text only.
 * Credentials: env vars OR app_state (set from site UI).
 */
import { generateSignalChartImage } from './chart.js';
import { getState } from '../database/appState.js';
import { formatLK, nowLK } from '../utils/time.js';
import {
  getTelegramNotifyConfig,
  eventAllowed,
  chartAllowed,
} from './notifyConfig.js';
import { pushLiveBoardEvent } from './liveBoard.js';

async function getTelegramConfig() {
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

async function configured() {
  const { token, chatId } = await getTelegramConfig();
  return !!(token && chatId);
}

export async function sendTelegramMessage(text) {
  const { token, chatId } = await getTelegramConfig();
  if (!token || !chatId) {
    console.warn('[Telegram] Not configured — skip send');
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      }
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('[Telegram] API error', data);
      return { ok: false, error: data };
    }
    return { ok: true };
  } catch (e) {
    console.error('[Telegram] Network error', e.message);
    return { ok: false, error: e.message };
  }
}

/** length Telegram counts against the 1024 caption limit (tags excluded) */
function visibleLen(html) {
  return String(html || '').replace(/<[^>]+>/g, '').length;
}

/**
 * Short caption that never cuts an HTML tag in half.
 * (The old slice() could leave an unclosed <b>, Telegram rejected the photo
 *  with "can't parse entities" and the bot silently fell back to text-only.)
 */
function shortCaption(html, max = 900) {
  const head = String(html).split('\n\n<b>Analysis')[0];
  if (visibleLen(head) <= max) return head;
  const out = [];
  let len = 0;
  for (const line of head.split('\n')) {
    len += visibleLen(line) + 1;
    if (len > max) break;
    out.push(line);
  }
  return out.join('\n');
}

export async function sendPhotoMessage(caption, imageUrlOrBuffer) {
  const { token, chatId } = await getTelegramConfig();
  if (!token || !chatId) {
    console.warn('[Telegram] Not configured — skip photo');
    return { ok: false, skipped: true };
  }
  if (!imageUrlOrBuffer) {
    return sendTelegramMessage(caption);
  }

  // Chart already shows the full analysis. If the text is too long for a photo
  // caption, send the photo with a short caption and the full text right after.
  const tooLong = visibleLen(caption) > 1000;
  const cap = tooLong ? shortCaption(caption) : caption;
  const finish = async (r) => {
    if (tooLong) await sendTelegramMessage(caption);
    return r;
  };

  try {
    if (typeof imageUrlOrBuffer === 'string') {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/sendPhoto`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            photo: imageUrlOrBuffer,
            caption: cap,
            parse_mode: 'HTML',
          }),
        }
      );
      const data = await res.json();
      if (!data.ok) {
        console.error('[Telegram] sendPhoto error', data);
        return sendTelegramMessage(caption);
      }
      return finish({ ok: true, photo: true });
    }

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', cap);
    form.append('parse_mode', 'HTML');
    form.append(
      'photo',
      new Blob([imageUrlOrBuffer], { type: 'image/png' }),
      'chart.png'
    );
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendPhoto`,
      { method: 'POST', body: form }
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('[Telegram] sendPhoto buffer error', data);
      return sendTelegramMessage(caption);
    }
    return finish({ ok: true, photo: true });
  } catch (e) {
    console.error('[Telegram] photo network error', e.message);
    return sendTelegramMessage(caption);
  }
}

function fmt(n, d) {
  if (n == null || Number.isNaN(+n)) return '—';
  const v = Number(n);
  if (d != null) return v.toFixed(d);
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toFixed(2);
  if (a >= 1) return v.toFixed(4);
  if (a >= 0.01) return v.toFixed(5);
  if (a >= 0.0001) return v.toFixed(6);
  return v.toFixed(8);
}

function confLines(signal) {
  const conf = signal.metadata?.conf || signal.conf || [];
  if (!conf.length) return '';
  return conf.map((c) => `• ${c}`).join('\n');
}

/** Full analyze-style caption (Telegram photo caption max ~1024) */
function buildFullCaption(title, signal) {
  const meta = signal.metadata || {};
  const st = signal.structure || meta.structure || {};
  const pd = signal.pd || meta.pd || {};
  const conf = confLines(signal);
  const htf = meta.htf || '4h';
  const obtf = meta.obTf || '1h';
  const style = meta.entryStyle || 'conservative';
  const close =
    signal.close_label ||
    (signal.atr_distance != null && signal.atr_distance <= 0.5
      ? 'CLOSE'
      : 'WATCH');
  const rvol = signal.rvol ?? meta.rvol;
  const price = signal.current_price ?? signal.price;

  const strat = meta.strategy || signal.strategy || 'existing_smc';
  const isChart = strat === 'chart_pattern';
  const patternName = meta.pattern || meta.patternType || signal.pattern || '';
  const stratLine = isChart
    ? `Strategy: <b>CHART PATTERN</b>${patternName ? ` · ${patternName}` : ''}${meta.patternTf ? ` · ${String(meta.patternTf).toUpperCase()}` : ''}${meta.breakoutConfirmed ? ' · Breakout ✓' : ''}`
    : `Strategy: <b>EXISTING SMC</b>`;

  let text = `${title}

<b>${signal.symbol}</b> ${signal.direction} · Score <b>${signal.score}/100</b>
${stratLine}
${close} · ATR ${fmt(signal.atr_distance, 2)} (≤0.5 = close)

<b>Prices</b>
Market: ${fmt(price)}
Entry: ${fmt(signal.entry)}
SL: ${fmt(signal.sl)}
TP1: ${fmt(signal.tp1)} · TP2: ${fmt(signal.tp2)} · TP3: ${fmt(signal.tp3)}
R:R 1:${signal.rr}
Gap: ${fmt(signal.distance_percent, 2)}% · ${fmt(signal.distance_to_entry)}
Entry Distance: ${fmt(signal.atr_distance, 2)} ATR
`;
  if (isChart && meta.breakoutLevel != null) {
    text += `Breakout: ${fmt(meta.breakoutLevel)} · RVOL: ${rvol != null ? Number(rvol).toFixed(2) : '—'}\n`;
  }
  text += `
<b>Analysis (${htf}→${obtf}${isChart ? ' · pattern' : ` · ${style}`})</b>
Bias: ${st.bias ?? '—'} · BOS: ${st.bos ?? '—'} · CHOCH: ${st.choch ?? '—'}
${isChart
  ? `Pattern range: ${fmt(signal.ob_low)} – ${fmt(signal.ob_high)} · Breakout RVOL: ${rvol != null ? Number(rvol).toFixed(2) : '—'}
Targets: measured move (TP2 = 1x height, TP3 = 1.618x)
`
  : `Zone: ${pd.zone ?? '—'} · RVOL: ${rvol != null ? Number(rvol).toFixed(2) : '—'}
OB: ${fmt(signal.ob_low)} – ${fmt(signal.ob_high)}
`}
`;

  if (conf) text += `\n<b>Confluence</b>\n${conf}\n`;
  text += `\n${nowLK()} LK`;
  return text;
}

export async function sendReadyNotification(signal) {
  const meta = signal.metadata || {};
  const isChart =
    (meta.strategy || signal.strategy) === 'chart_pattern' ||
    !!(meta.pattern || signal.pattern);
  const title = isChart
    ? `🟡 <b>CHART PATTERN BREAKOUT</b>${meta.pattern || signal.pattern ? ` · ${meta.pattern || signal.pattern}` : ''}`
    : '🟡 <b>LIMIT ORDER READY</b>';
  let text = buildFullCaption(title, signal);
  // Telegram photo caption max 1024
  if (text.length > 1000) text = text.slice(0, 990) + '\n…';
  try {
    const chartPng = await generateSignalChartImage(signal);
    if (chartPng) {
      const photoRes = await sendPhotoMessage(text, chartPng);
      if (photoRes?.ok) return photoRes;
      console.error('[Telegram] READY photo failed, falling back to text', photoRes?.error);
    } else {
      console.error('[Telegram] READY chart null for', signal.symbol, meta.strategy || signal.strategy);
    }
    return sendTelegramMessage(text);
  } catch (e) {
    console.error('[Telegram] READY chart failed', e.message);
    return sendTelegramMessage(text);
  }
}

export async function sendEntryNotification(signal) {
  const text = `🟢 <b>IN TRADE</b>  ${signal.symbol}  ${signal.direction || ''}

<code>E ${fmt(signal.entry_hit_price ?? signal.entry)} · SL ${fmt(signal.sl)}</code>
→ TP1 ${fmt(signal.tp1)}
${nowLK()} LK`;
  return sendTelegramMessage(text);
}

export async function sendTPNotification(level, signal) {
  const icons = { TP1: '✅', TP2: '✅', TP3: '🏆' };
  const pnl = signal.current_pnl_percent;
  const pnlStr =
    pnl != null && Number.isFinite(+pnl)
      ? `${+pnl >= 0 ? '+' : ''}${fmt(pnl, 2)}%`
      : '—';
  const hits = [
    signal.tp1_hit || level === 'TP1' ? 'TP1✓' : null,
    signal.tp2_hit || level === 'TP2' ? 'TP2✓' : null,
    signal.tp3_hit || level === 'TP3' ? 'TP3✓' : null,
  ]
    .filter(Boolean)
    .join('  ');
  const title =
    level === 'TP3'
      ? `${icons.TP3} <b>TP3 · COMPLETED</b>`
      : `${icons[level] || '✅'} <b>${level} HIT</b>`;
  const text = `${title}
<b>${signal.symbol}</b> ${signal.direction || ''}
💰 PnL <b>${pnlStr}</b>
🎯 ${hits || level}
<code>${fmt(signal.entry_hit_price || signal.entry)} → ${fmt(signal.current_price)}</code>`;
  return sendTelegramMessage(text);
}

export async function sendSLNotification(signal) {
  const pnl = signal.current_pnl_percent;
  const pnlStr =
    pnl != null && Number.isFinite(+pnl)
      ? `${+pnl >= 0 ? '+' : ''}${fmt(pnl, 2)}%`
      : '—';
  const text = `🛑 <b>STOP LOSS</b>
<b>${signal.symbol}</b> ${signal.direction || ''}
📉 PnL <b>${pnlStr}</b>
<code>E ${fmt(signal.entry_hit_price || signal.entry)} → ${fmt(signal.current_price)}</code>`;
  return sendTelegramMessage(text);
}

export async function sendInvalidationNotification(signal) {
  const text = `⚪ <b>SIGNAL INVALIDATED</b>

<b>${signal.symbol}</b> ${signal.direction}

Entry: ${fmt(signal.entry)}
Current: ${fmt(signal.current_price)}
Score: ${signal.score}

Status: INVALIDATED`;
  return sendTelegramMessage(text);
}

const NEAR_STATE_LABEL = {
  BREAKING_NOW: '⚡ BREAKING NOW · candle close බලාපොරොත්තුවෙන්',
  AT_LEVEL: '📍 AT LEVEL · breakout level ළඟ',
  APPROACHING: '⏳ APPROACHING · level ට ළඟ වෙමින්',
};

export async function sendNearBreakoutNotification(near) {
  const state = near.state || 'APPROACHING';
  const label = NEAR_STATE_LABEL[state] || `⏳ ${state}`;
  const dir = near.direction || near.dir || '—';
  const conf = (near.conf || []).slice(0, 8).map((c) => `• ${c}`).join('\n');
  const text = `⏳ <b>ABOUT TO BREAK OUT</b>

<b>${near.symbol}</b> ${dir} · Score <b>${near.score ?? '—'}/100</b>
${label}

Pattern: <b>${near.pattern || '—'}</b> · TF: <b>${near.patternTf || '—'}</b>
Gap: ${near.gapAtr != null ? Number(near.gapAtr).toFixed(2) : '—'} ATR (${near.gapPct != null ? Number(near.gapPct).toFixed(2) : '—'}%)

Market: ${fmt(near.price)}
Breakout level: ${fmt(near.trigger)}
Confirm close: ${fmt(near.entry)}
SL (if breaks): ${fmt(near.sl)}
TP1 / TP2: ${fmt(near.tp1)} / ${fmt(near.tp2)}
R:R: 1:${near.rr ?? '—'} · measured ${near.rrMeasured ?? '—'}
Vol build: ${near.volBuild != null ? Number(near.volBuild).toFixed(2) : '—'}
HTF: ${near.htfAligned ? 'aligned ✓' : '—'}
${conf ? '\n<b>Confluence</b>\n' + conf + '\n' : ''}
⚠️ Alert only — breakout candle close + volume තහවුරු වුණාම real signal.

${nowLK()} LK`;

  // Chart optional — use pattern TF levels as a pseudo-signal
  try {
    const pseudo = {
      symbol: near.symbol,
      direction: dir,
      strategy: 'chart_pattern',
      pattern: near.pattern,
      entry: near.entry,
      sl: near.sl,
      tp1: near.tp1,
      tp2: near.tp2,
      tp3: near.tp3,
      score: near.score,
      current_price: near.price,
      price: near.price,
      metadata: {
        strategy: 'chart_pattern',
        pattern: near.pattern,
        patternTf: near.patternTf,
        htf: near.htf,
        breakoutLevel: near.trigger,
        patternGeom: near.patternGeom || null,
        conf: near.conf,
      },
    };
    let caption = text;
    if (caption.length > 1000) caption = caption.slice(0, 990) + '\n…';
    const chartPng = await generateSignalChartImage(pseudo);
    if (chartPng) {
      const photoRes = await sendPhotoMessage(caption, chartPng);
      if (photoRes?.ok) return photoRes;
    }
  } catch (e) {
    console.error('[Telegram] near chart', e.message);
  }
  return sendTelegramMessage(text);
}

const IMPORTANT_FOR_PLUS = new Set([
  'NEAR_BREAKOUT',
  'ENTRY_HIT',
  'TP3',
  'SL',
]);

export async function dispatchNotifications(notifications) {
  const results = [];
  let cfg;
  try {
    cfg = await getTelegramNotifyConfig();
  } catch (_) {
    cfg = null;
  }

  for (const n of notifications) {
    const type = n.type;
    const sym = n.signal?.symbol || n.near?.symbol || '';

    try {
      const label =
        type === 'ENTRY_HIT'
          ? 'ONGOING'
          : type === 'NEAR_BREAKOUT'
            ? 'BREAKOUT'
            : type;
      if (sym) await pushLiveBoardEvent(`${sym} → ${label}`);
    } catch (_) {}

    if (cfg?.notificationMode === 'live_board') {
      results.push({
        type,
        signalId: n.signal?.signal_id || n.near?.signal_id,
        ok: true,
        skipped: true,
        reason: 'live_board_mode',
      });
      continue;
    }

    if (
      cfg?.notificationMode === 'live_board_plus' &&
      !IMPORTANT_FOR_PLUS.has(type)
    ) {
      results.push({
        type,
        signalId: n.signal?.signal_id || n.near?.signal_id,
        ok: true,
        skipped: true,
        reason: 'not_important',
      });
      continue;
    }

    if (cfg && !eventAllowed(cfg, type)) {
      results.push({
        type,
        signalId: n.signal?.signal_id || n.near?.signal_id,
        ok: true,
        skipped: true,
        reason: 'disabled',
      });
      continue;
    }

    let res;
    const wantChart = !cfg || chartAllowed(cfg, type);
    const s = n.signal || n.near || {};

    if (type === 'READY') {
      res = wantChart
        ? await sendReadyNotification(n.signal)
        : await sendTelegramMessage(
            `✅ <b>READY</b> ${s.symbol || ''} ${s.direction || s.dir || ''}\nEntry: ${s.entry ?? '—'}`
          );
    } else if (type === 'NEAR_BREAKOUT') {
      res = wantChart
        ? await sendNearBreakoutNotification(n.signal || n.near)
        : await sendTelegramMessage(
            `⏳ <b>NEAR BREAKOUT</b> ${s.symbol || ''}`
          );
    } else if (type === 'ENTRY_HIT') res = await sendEntryNotification(n.signal);
    else if (type === 'TP1') res = await sendTPNotification('TP1', n.signal);
    else if (type === 'TP2') res = await sendTPNotification('TP2', n.signal);
    else if (type === 'TP3') res = await sendTPNotification('TP3', n.signal);
    else if (type === 'SL') res = await sendSLNotification(n.signal);
    else if (type === 'INVALIDATED') res = await sendInvalidationNotification(n.signal);
    else res = { ok: false, skipped: true };

    results.push({
      type,
      signalId: n.signal?.signal_id || n.near?.signal_id,
      ...res,
    });

    // Personal DMs to linked users (independent of live_board channel mode)
    if (['READY', 'ENTRY_HIT', 'TP1', 'TP2', 'TP3', 'SL', 'NEAR_BREAKOUT'].includes(type)) {
      try {
        await notifyLinkedUsers(type, n.signal || n.near || {});
      } catch (_) {}
    }
  }
  return results;
}


/** Send HTML text to an arbitrary chat_id (personal DM). */
export async function sendTelegramToChat(chatId, text) {
  const { token } = await getTelegramConfig();
  if (!token || !chatId) {
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: String(chatId),
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      }
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('[Telegram] DM error', data);
      return { ok: false, error: data };
    }
    return { ok: true };
  } catch (e) {
    console.error('[Telegram] DM network error', e.message);
    return { ok: false, error: e.message };
  }
}

function compactPersonalAlert(type, signal) {
  const s = signal || {};
  const sym = s.symbol || '';
  const dir = s.direction || s.dir || '';
  const entry = s.entry ?? s.entry_hit_price ?? '—';
  if (type === 'READY') {
    return '🚀 <b>READY</b> ' + sym + ' ' + dir + '\nEntry: ' + entry;
  }
  if (type === 'ENTRY_HIT') {
    const hitAt = s.entry_hit_at ? formatLK(s.entry_hit_at) : '—';
    return (
      '🟢 <b>ONGOING</b> ' + sym + ' ' + dir +
      '\nEntry price: ' + entry +
      '\nEntry hit (ONGOING): ' + hitAt
    );
  }
  if (type === 'TP1' || type === 'TP2' || type === 'TP3') {
    return '✅ <b>' + type + '</b> ' + sym + ' ' + dir;
  }
  if (type === 'SL') {
    return '🛑 <b>SL HIT</b> ' + sym + ' ' + dir;
  }
  if (type === 'NEAR_BREAKOUT') {
    return '⏳ <b>NEAR</b> ' + sym + ' ' + dir;
  }
  return '📡 <b>' + type + '</b> ' + sym + ' ' + dir;
}

/** Fan-out compact alerts to all linked users with active plan/trial. */
export async function notifyLinkedUsers(type, signal) {
  try {
    const { listLinkedTelegramUsers } = await import('../database/users.js');
    const users = await listLinkedTelegramUsers();
    if (!users.length) return { sent: 0 };
    const text = compactPersonalAlert(type, signal);
    let sent = 0;
    for (const u of users) {
      const r = await sendTelegramToChat(u.telegram_chat_id, text);
      if (r.ok) sent++;
    }
    return { sent, total: users.length };
  } catch (e) {
    console.error('[Telegram] notifyLinkedUsers', e.message);
    return { sent: 0, error: e.message };
  }
}

/** Test message — used by settings UI */
export async function sendTestMessage() {
  return sendTelegramMessage(
    `✅ <b>HQ Monitor connected</b>\nTime: ${nowLK()} LK`
  );
}
