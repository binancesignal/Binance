/**
 * Telegram: LIMIT ORDER READY = text+chart; ENTRY/TP/SL = text only.
 * Credentials: env vars OR app_state (set from site UI).
 */
import { generateSignalChartImage } from './chart.js';
import { getState } from '../database/appState.js';
import { buildIctChartPreview } from '../scanner/ictChart.js';
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

export async function sendTelegramMessage(text, replyMarkup = null) {
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
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
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

export async function sendPhotoMessage(caption, imageUrlOrBuffer, replyMarkup = null) {
  const { token, chatId } = await getTelegramConfig();
  if (!token || !chatId) {
    console.warn('[Telegram] Not configured — skip photo');
    return { ok: false, skipped: true };
  }
  if (!imageUrlOrBuffer) {
    return sendTelegramMessage(caption, replyMarkup);
  }

  // Chart already shows the full analysis. If the text is too long for a photo
  // caption, send the photo with a short caption and the full text right after.
  const tooLong = visibleLen(caption) > 1000;
  const cap = tooLong ? shortCaption(caption) : caption;
  const finish = async (r) => {
    if (tooLong) await sendTelegramMessage(caption, replyMarkup);
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
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          }),
        }
      );
      const data = await res.json();
      if (!data.ok) {
        console.error('[Telegram] sendPhoto error', data);
        return sendTelegramMessage(caption, replyMarkup);
      }
      return finish({ ok: true, photo: true });
    }

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', cap);
    form.append('parse_mode', 'HTML');
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
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
      return sendTelegramMessage(caption, replyMarkup);
    }
    return finish({ ok: true, photo: true });
  } catch (e) {
    console.error('[Telegram] photo network error', e.message);
    return sendTelegramMessage(caption, replyMarkup);
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
  const isIctSmc = strat === 'ict_smc';
  const isZonePattern = strat === 'zone_pattern';
  const isEmaBump = strat === 'ema_bump';
  const patternName = meta.pattern || meta.patternType || signal.pattern || '';
  const stratLine = isChart
    ? `Strategy: <b>CHART PATTERN</b>${patternName ? ` · ${patternName}` : ''}${meta.patternTf ? ` · ${String(meta.patternTf).toUpperCase()}` : ''}${meta.breakoutConfirmed ? ' · Breakout ✓' : ''}`
    : isIctSmc
      ? `Strategy: <b>ICT SMC</b> · ${String(meta.patternTf || '15m').toUpperCase()}`
      : isZonePattern
        ? `Strategy: <b>ZONE + PATTERN</b>${patternName ? ` · ${patternName}` : ''}${meta.setupTf ? ` · ${String(meta.setupTf).toUpperCase()}` : ''}`
      : isEmaBump
        ? `Strategy: <b>EMA BUMP</b> · EMA${meta.emaFast || 20}/${meta.emaSlow || 50} · ${String(meta.patternTf || '15m').toUpperCase()}`
      : `Strategy: <b>SMC</b>`;

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
  if (isZonePattern) {
    text += `Zone: ${fmt(meta.zone?.low)} – ${fmt(meta.zone?.high)} · Sources: ${(meta.zone?.families || []).join(' + ') || '—'}\n`;
    text += `Pattern BOS: ${patternName || '—'} · ${fmt(meta.breakoutLevel)} · Fib: ${meta.fib?.aligned ? (meta.fib.ratio || 'aligned') : 'not required'}\n`;
  }
  const analysisFrames = isZonePattern
    ? `${meta.contextTf || '4h'}→${meta.setupTf || '15m'}`
    : strat === 'double_confluence'
      ? `${meta.htfTf || '1h'}→${meta.patternTf || '15m'}`
      : isEmaBump
        ? `${String(meta.patternTf || '15m').toUpperCase()}`
        : `${htf}→${obtf}`;
  text += `
<b>Analysis (${analysisFrames}${isChart ? ' · pattern' : isZonePattern ? ' · zone + pattern' : strat === 'double_confluence' ? ' · double confluence' : isEmaBump ? ' · EMA bump' : ` · ${style}`})</b>
Bias: ${st.bias ?? '—'} · BOS: ${st.bos ?? '—'} · CHOCH: ${st.choch ?? '—'}
${isChart
  ? `Pattern range: ${fmt(signal.ob_low)} – ${fmt(signal.ob_high)} · Breakout RVOL: ${rvol != null ? Number(rvol).toFixed(2) : '—'}
Targets: measured move (TP2 = 1x height, TP3 = 1.618x)
`
  : isIctSmc
    ? `Sequence: liquidity sweep → BOS close → fresh POI
Sweep: ${meta.ictAnalysis?.sweepSide || '—'} @ ${fmt(meta.ictAnalysis?.sweepLevel)}
BOS: close beyond ${fmt(meta.ictAnalysis?.bosLevel)} · POI ${meta.ictAnalysis?.poiType || '—'} (${fmt(meta.ictAnalysis?.poiLow)} – ${fmt(meta.ictAnalysis?.poiHigh)})
HTF bias: ${meta.ictAnalysis?.htfBias || '—'}${meta.ictAnalysis?.htfAligned ? ' · aligned' : ''}
`
  : isZonePattern
    ? `Confluence sources: ${(meta.zone?.families || []).join(' + ') || '—'}
Local structure break: ${fmt(meta.breakoutLevel)} · Context: ${meta.contextBias || st.bias || '—'}
`
  : isEmaBump
    ? `EMA${meta.emaFast || 20}: ${fmt(meta.emaValues?.fast)} · EMA${meta.emaSlow || 50}: ${fmt(meta.emaValues?.slow)} · Gap ${meta.gapATR ?? '—'} ATR${meta.barsSinceCross != null ? ` · crossed ${meta.barsSinceCross} bar(s) ago` : ' · not crossed yet'}\nEntry = break of the top ${signal.direction === 'SHORT' ? 'low' : 'high'} · pullback touched EMA${meta.emaSlow || 50} ${meta.touchAge ?? '—'} bar(s) ago · Dip ${meta.depthATR ?? '—'} ATR\n`
  : strat === 'double_confluence'
    ? `Double: ${(meta.doublePattern?.type || '—').toString().replace(/_/g, ' ')} · Harmonic: ${meta.entryTf || '—'} (${meta.confluenceScore ?? '—'})
PRZ: ${fmt(meta.pattern?.neckline?.price)} – ${fmt(meta.breakout?.confirmed)} · Zone: ${meta.zone?.type || '—'}
Overlap: ${meta.confluenceScore ?? '—'} · Sweep: ${meta.liquiditySweep?.confirmed ? 'YES' : '—'} · Quality: ${meta.quality || '—'}
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
  const strategy = meta.strategy || signal.strategy;
  const isChart = strategy === 'chart_pattern';
  const isIctSmc = strategy === 'ict_smc';
  const isZonePattern = strategy === 'zone_pattern';
  const isEmaBump = strategy === 'ema_bump';
  const title = isChart
    ? `🟡 <b>CHART PATTERN BREAKOUT</b>${meta.pattern || signal.pattern ? ` · ${meta.pattern || signal.pattern}` : ''}`
    : isIctSmc
      ? '🟡 <b>ICT SMC · POI READY</b>'
      : isZonePattern
        ? `🟡 <b>ZONE + PATTERN CONFLUENCE</b>${meta.pattern ? ` · ${meta.pattern}` : ''}`
        : isEmaBump
          ? `🟡 <b>EMA BUMP</b> · ${String(meta.patternTf || '15m').toUpperCase()} · ${signal.direction}`
        : strategy === 'double_confluence'
          ? `🟡 <b>DOUBLE TOP/BOTTOM CONFLUENCE</b>${meta.pattern || signal.pattern ? ` · ${meta.pattern || signal.pattern}` : ''}${meta.quality ? ` · ${meta.quality}` : ''}`
          : '🟡 <b>LIMIT ORDER READY</b>';
  let text = buildFullCaption(title, signal);
  const replyMarkup = signalAnalysisKeyboard(signal.signal_id);
  try {
    const chartPng = await generateSignalChartImage(signal);
    if (chartPng) {
      const photoRes = await sendPhotoMessage(text, chartPng, replyMarkup);
      if (photoRes?.ok) return photoRes;
      console.error('[Telegram] READY photo failed, falling back to text', photoRes?.error);
    } else {
      console.error('[Telegram] READY chart null for', signal.symbol, meta.strategy || signal.strategy);
    }
    return sendTelegramMessage(text, replyMarkup);
  } catch (e) {
    console.error('[Telegram] READY chart failed', e.message);
    return sendTelegramMessage(text, replyMarkup);
  }
}

export function signalAnalysisKeyboard(signalId) {
  if (!signalId) return null;
  return {
    inline_keyboard: [[
      { text: '📊 Full chart analysis', callback_data: `analyze:${signalId}` },
      { text: '🔎 Choose another', callback_data: 'analyze:list' },
    ]],
  };
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
            `✅ <b>READY</b> ${s.symbol || ''} ${s.direction || s.dir || ''}\nEntry: ${s.entry ?? '—'}`,
            signalAnalysisKeyboard(s.signal_id)
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
export async function sendTelegramToChat(chatId, text, replyMarkup = null) {
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
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
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

/** Send the saved signal's complete chart analysis to the chat that pressed the button. */
export async function sendSignalAnalysisChartToChat(chatId, signal) {
  const { token } = await getTelegramConfig();
  if (!token || !chatId || !signal) return { ok: false, skipped: true };
  const caption = buildFullCaption('📊 <b>FULL CHART ANALYSIS</b>', signal);
  const markup = {
    inline_keyboard: [[
      { text: '🔎 Choose another active setup', callback_data: 'analyze:list' },
    ]],
  };
  try {
    const image = await generateSignalChartImage(signal);
    if (!image) {
      return sendTelegramToChat(chatId, 'Chart image could not be rendered for this signal. Please try again later.');
    }
    const tooLong = visibleLen(caption) > 1000;
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', tooLong ? shortCaption(caption) : caption);
    form.append('parse_mode', 'HTML');
    form.append('reply_markup', JSON.stringify(markup));
    form.append('photo', new Blob([image], { type: 'image/png' }), 'analysis.png');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    const data = await response.json();
    if (!data.ok) return { ok: false, error: data };
    if (tooLong) await sendTelegramToChat(chatId, caption);
    return { ok: true, photo: true };
  } catch (e) {
    console.error('[Telegram] analysis chart failed', e.message);
    return { ok: false, error: e.message };
  }
}

/** Analyze a user-selected USDT perpetual and send its ICT/SMC chart to that chat. */
export async function sendCoinAnalysisChartToChat(chatId, rawSymbol, timeframe = '15m') {
  const { token } = await getTelegramConfig();
  if (!token || !chatId) return { ok: false, skipped: true };

  const compact = String(rawSymbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const symbol = compact && compact.endsWith('USDT') ? compact : `${compact}USDT`;
  const allowedTimeframes = ['5m', '15m', '30m', '1h', '2h', '4h'];
  if (!compact || !allowedTimeframes.includes(timeframe)) {
    return { ok: false, error: 'Use /chart BTC 15m. Timeframes: 5m, 15m, 30m, 1h, 2h, 4h.' };
  }

  try {
    const analysis = await buildIctChartPreview(symbol, timeframe);
    const image = await generateSignalChartImage(analysis.signal, analysis.candles);
    if (!image) {
      return sendTelegramToChat(chatId, `Could not render the ${symbol} chart right now. Please try again.`);
    }

    const setup = analysis.setup;
    const lines = [
      '📈 <b>FULL ICT/SMC CHART ANALYSIS</b>',
      `<b>${symbol}</b> · ${timeframe.toUpperCase()} · ${analysis.higherTimeframe.toUpperCase()} HTF`,
      `Market price: ${fmt(analysis.price)}`,
      setup
        ? `Setup: <b>${setup.dir}</b> · Score ${Math.round(+setup.score || 0)}/100`
        : 'Setup: <b>NO ACTIVE SETUP</b> — chart shows current market context',
    ];
    if (setup) {
      lines.push(
        `Entry: ${fmt(setup.entry)} · SL: ${fmt(setup.sl)}`,
        `TP1: ${fmt(setup.tp1)} · TP2: ${fmt(setup.tp2)} · TP3: ${fmt(setup.tp3)}`,
        ...(setup.conf || []).map((item) => `• ${item}`)
      );
    }
    const caption = lines.join('\n');
    const markup = {
      inline_keyboard: [[
        { text: '📈 READY charts', callback_data: 'analyze:ready' },
      ]],
    };
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('reply_markup', JSON.stringify(markup));
    form.append('photo', new Blob([image], { type: 'image/png' }), 'ict-analysis.png');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    const data = await response.json();
    if (!data.ok) return { ok: false, error: data };
    return { ok: true, photo: true };
  } catch (error) {
    console.error('[Telegram] selected coin analysis failed', error?.message || error);
    const message = error?.message || 'Could not analyze this coin right now.';
    await sendTelegramToChat(chatId, message);
    return { ok: false, error: message };
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
      const r = await sendTelegramToChat(
        u.telegram_chat_id,
        text,
        type === 'READY' ? signalAnalysisKeyboard(signal.signal_id) : null
      );
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

/** Resolve public site URL for webhook (Vercel / custom domain). */
export function resolvePublicBaseUrl(requestUrl) {
  const fromEnv =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : '') ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  if (fromEnv) return String(fromEnv).replace(/\/$/, '');
  if (requestUrl) {
    try {
      const u = new URL(requestUrl);
      return `${u.protocol}//${u.host}`;
    } catch (_) {}
  }
  return '';
}

/** Validate token and return bot profile from Telegram getMe. */
export async function getBotMe(tokenOverride) {
  const token = tokenOverride || (await getTelegramConfig()).token;
  if (!token) return { ok: false, error: 'No bot token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.description || 'getMe failed', data };
    return {
      ok: true,
      id: data.result?.id,
      username: data.result?.username || '',
      first_name: data.result?.first_name || '',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getWebhookInfo(tokenOverride) {
  const token = tokenOverride || (await getTelegramConfig()).token;
  if (!token) return { ok: false, error: 'No bot token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.description || 'getWebhookInfo failed', data };
    return {
      ok: true,
      url: data.result?.url || '',
      pending_update_count: data.result?.pending_update_count ?? 0,
      last_error_message: data.result?.last_error_message || null,
      last_error_date: data.result?.last_error_date || null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Point Telegram updates at /api/telegram/webhook on this deployment. */
export async function setTelegramWebhook(baseUrl, tokenOverride) {
  const token = tokenOverride || (await getTelegramConfig()).token;
  if (!token) return { ok: false, error: 'No bot token' };
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base || !/^https:\/\//i.test(base)) {
    return { ok: false, error: 'Public HTTPS base URL required to set webhook' };
  }
  const url = `${base}/api/telegram/webhook`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        allowed_updates: ['message', 'callback_query', 'edited_message'],
        drop_pending_updates: false,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      return { ok: false, error: data.description || 'setWebhook failed', data, url };
    }
    const info = await getWebhookInfo(token);
    return { ok: true, url, info };
  } catch (e) {
    return { ok: false, error: e.message, url };
  }
}

/**
 * Notify the admin board chat about a user trade attempt (placed / failed / skipped).
 * Always includes user email + error reason when not placed.
 */
export async function notifyAdminTradePlaced({
  user,
  signal,
  mode,
  result = {},
  manual = false,
  kind = 'placed', // placed | failed | skipped
  reason = null,
}) {
  const email = String(user?.email || user?.id || 'unknown').replace(/</g, '&lt;');
  const symbol = signal?.symbol || '—';
  const direction = signal?.direction || signal?.dir || '—';
  const status = result?.status || (kind === 'placed' ? 'PLACED' : String(kind).toUpperCase());
  const qty = result?.qty ?? '—';
  const lev = result?.leverage ?? '—';
  const src = manual ? 'Manual Market Entry' : 'Auto-trade';
  const err =
    reason ||
    result?.reason ||
    result?.error ||
    (kind === 'skipped' ? 'Skipped' : kind === 'failed' ? 'Failed' : null);

  let title = '🟢 <b>User trade placed</b>';
  if (kind === 'failed' || kind === 'unknown') title = '❌ <b>User trade FAILED</b>';
  else if (kind === 'skipped') title = '⚠️ <b>User trade SKIPPED</b>';

  let text =
    `${title}\n` +
    `User: <code>${email}</code>\n` +
    `Source: ${src}\n` +
    `${symbol} ${direction}\n` +
    `Mode: ${String(mode || '—').toUpperCase()}\n` +
    `Status: ${status}`;

  if (kind === 'placed') {
    text += `\nQty: ${qty} · Leverage: ${lev}x`;
  }
  if (err) {
    text += `\nReason: ${String(err).replace(/</g, '&lt;').slice(0, 400)}`;
  }
  return sendTelegramMessage(text);
}
