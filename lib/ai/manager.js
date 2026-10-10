/**
 * In-app AI manager (Gemini free-tier).
 * Builds user-scoped context from app data, then answers in the user's language.
 */
import { getState } from '../database/appState.js';
import { getUserTradingSettings, getTelegramStatus, getPlan } from '../database/users.js';
import { getActiveSignals } from '../database/signals.js';
import { getOpenExecutions, getExecutionsToday } from '../database/executions.js';
import { getCapital, budgetState } from '../trading/capital.js';
import { getAutoTradingConfig } from '../trading/autoConfig.js';
import { getWebhookInfo } from '../telegram/telegram.js';
import { APP_VERSION } from '../version.js';

const SYSTEM_PROMPT = `You are Nila, the AI Manager inside a Binance signal + auto-trade web app (HQ Monitor).
Introduce yourself as Nila when greeting. Answer clearly and practically. Prefer short spoken-friendly sentences.
Match the user's language (Sinhala, English, or mixed).
You can explain signals (READY/ONGOING/WATCHING), Market Entry, High Risk mode, starting capital, Telegram connect/webhook, plans, and common skip/fail reasons.
Do NOT invent balances, order IDs, or prices that are not in the context.
Do NOT give financial advice as a guarantee of profit; trading is risky.
If something requires admin action, say so.
App version is in the context.`;

async function resolveGeminiKey() {
  let key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';
  try {
    const stored = await getState('ai_manager_config', null);
    if (stored?.api_key) key = stored.api_key;
  } catch (_) {}
  return String(key || '').trim();
}

/** Preferred + fallbacks (Google retires model IDs over time). */
const DEFAULT_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-preview-05-20',
  'gemini-flash-latest',
  'gemini-2.0-flash-001',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash',
];

async function resolveModelList() {
  let preferred = process.env.GEMINI_MODEL || '';
  try {
    const stored = await getState('ai_manager_config', null);
    if (stored?.model) preferred = stored.model;
  } catch (_) {}
  preferred = String(preferred || '').trim();
  const list = [];
  if (preferred) list.push(preferred);
  for (const m of DEFAULT_MODELS) {
    if (!list.includes(m)) list.push(m);
  }
  return list;
}

export async function getAiManagerConfigPublic() {
  const key = await resolveGeminiKey();
  const models = await resolveModelList();
  return {
    configured: !!key,
    model: models[0],
    models,
  };
}

export async function setAiManagerApiKey(apiKey, model) {
  const prev = (await getState('ai_manager_config', null)) || {};
  const next = {
    ...prev,
    api_key: String(apiKey || '').trim() || prev.api_key || '',
    updated_at: new Date().toISOString(),
  };
  if (model && String(model).trim()) {
    next.model = String(model).trim();
  }
  const { setState } = await import('../database/appState.js');
  await setState('ai_manager_config', next);
  return { ok: true, configured: !!next.api_key, model: next.model || null };
}

function summarizeSignals(signals) {
  const byStatus = {};
  for (const s of signals || []) {
    const st = String(s.status || 'UNKNOWN').toUpperCase();
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  const top = (signals || [])
    .slice(0, 12)
    .map(
      (s) =>
        `${s.symbol} ${s.direction || s.dir || ''} ${String(s.status || '').toUpperCase()} score=${s.score ?? '—'} entry=${s.entry ?? '—'}`
    );
  return { counts: byStatus, sample: top };
}

export async function buildUserContext(user) {
  const settings = await getUserTradingSettings(user.id);
  const plan = await getPlan(user.plan);
  const tg = await getTelegramStatus(user.id);
  const autoCfg = await getAutoTradingConfig();
  let signals = [];
  try {
    signals = await getActiveSignals();
  } catch (_) {}
  const signalSummary = summarizeSignals(signals);

  let openExec = [];
  let todayExec = [];
  try {
    openExec = await getOpenExecutions({ userId: user.id, exchange: 'binance' });
  } catch (_) {}
  try {
    todayExec = await getExecutionsToday({ userId: user.id, exchange: 'binance' });
  } catch (_) {}

  const capitalLive = getCapital(settings, 'live');
  const capitalMock = getCapital(settings, 'mock');

  const ctx = {
    appVersion: APP_VERSION,
    user: {
      email: user.email,
      plan: user.plan,
      role: user.role,
      subscription_status: user.subscription_status,
      can_auto_trade: !!(plan?.auto_trade || user.plan === 'auto' || user.plan === 'pro'),
    },
    settings: {
      autoTradingEnabled: !!settings.autoTradingEnabled,
      autoTradeExchange: settings.autoTradeExchange || null,
      riskMode: settings.riskMode || null,
      highRiskMarginPercent: settings.highRiskMarginPercent ?? null,
      maxOpenPositions: settings.maxOpenPositions ?? null,
    },
    capital: {
      live: capitalLive,
      mock: capitalMock,
    },
    telegram: {
      linked: !!tg?.linked,
    },
    signals: signalSummary,
    executions: {
      openCount: openExec?.length || 0,
      todayCount: todayExec?.length || 0,
      openSymbols: (openExec || []).slice(0, 8).map((e) => `${e.symbol} ${e.side} ${e.status}`),
      todaySample: (todayExec || [])
        .slice(0, 8)
        .map((e) => `${e.symbol} ${e.side} ${e.status}${e.error ? ` err=${String(e.error).slice(0, 80)}` : ''}`),
    },
    global: {
      manualEntryEnabled: autoCfg.manualEntryEnabled !== false,
      autoTradingEnabledGlobal: !!autoCfg.autoTradingEnabled,
      minimumScore: autoCfg.minimumScore,
    },
  };

  if (user.role === 'admin') {
    try {
      const wh = await getWebhookInfo();
      ctx.admin = {
        telegramWebhookUrl: wh?.url || null,
        telegramWebhookError: wh?.last_error_message || null,
      };
    } catch (_) {
      ctx.admin = {};
    }
  }

  return ctx;
}

export async function askAiManager({ user, message, history = [] }) {
  const key = await resolveGeminiKey();
  if (!key) {
    return {
      ok: false,
      error:
        'AI Manager is not configured. Admin must set a free Gemini API key (GEMINI_API_KEY env or Admin → AI Manager).',
    };
  }

  const models = await resolveModelList();
  const context = await buildUserContext(user);
  const contextBlock = JSON.stringify(context, null, 2);

  const contents = [];
  for (const h of (history || []).slice(-8)) {
    if (!h?.text) continue;
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(h.text).slice(0, 4000) }],
    });
  }
  contents.push({
    role: 'user',
    parts: [
      {
        text:
          `App context (JSON):\n${contextBlock}\n\n` +
          `User question:\n${String(message || '').slice(0, 4000)}`,
      },
    ],
  });

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1024,
    },
  };

  let lastError = 'No model tried';
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        lastError = data?.error?.message || `Gemini HTTP ${res.status} (${model})`;
        // try next model if this id is retired / not found
        if (/not found|no longer available|not supported|invalid model/i.test(lastError)) {
          continue;
        }
        return { ok: false, error: lastError };
      }
      const text =
        data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') ||
        '';
      if (!text) {
        lastError = `Empty response from ${model}`;
        continue;
      }
      // Remember working model for next time
      try {
        const prev = (await getState('ai_manager_config', null)) || {};
        if (prev.model !== model) {
          const { setState } = await import('../database/appState.js');
          await setState('ai_manager_config', { ...prev, model });
        }
      } catch (_) {}
      return { ok: true, reply: text, model };
    } catch (e) {
      lastError = e.message || String(e);
    }
  }
  return { ok: false, error: lastError };
}
