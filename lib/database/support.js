/**
 * Live support chat threads (user ↔ admin via Telegram).
 * Stored in app_state key support_threads: { [userId]: { messages: [], updatedAt } }
 */
import { randomUUID } from 'node:crypto';
import { getState, setState } from './appState.js';

const KEY = 'support_threads';
const MAX_MSGS = 80;

async function allThreads() {
  const data = await getState(KEY, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export async function getThread(userId) {
  const all = await allThreads();
  const t = all[userId];
  if (!t) return { messages: [], updatedAt: null };
  return {
    messages: Array.isArray(t.messages) ? t.messages.slice(-MAX_MSGS) : [],
    updatedAt: t.updatedAt || null,
  };
}

export async function appendMessage(userId, { from, text, meta }) {
  const all = await allThreads();
  const prev = all[userId] || { messages: [] };
  const msg = {
    id: randomUUID(),
    from, // 'user' | 'admin'
    text: String(text || '').trim().slice(0, 2000),
    at: new Date().toISOString(),
    ...(meta && typeof meta === 'object' ? { meta } : {}),
  };
  if (!msg.text) throw new Error('Empty message');
  const messages = [...(prev.messages || []), msg].slice(-MAX_MSGS);
  all[userId] = { messages, updatedAt: msg.at };
  await setState(KEY, all);
  return msg;
}

export async function listOpenThreads(limit = 30) {
  const all = await allThreads();
  return Object.entries(all)
    .map(([userId, t]) => ({
      userId,
      updatedAt: t.updatedAt,
      last: (t.messages || [])[(t.messages || []).length - 1] || null,
      count: (t.messages || []).length,
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit);
}
