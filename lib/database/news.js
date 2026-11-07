/**
 * Dashboard news posts (admin-authored). Stored in app_state as JSON array.
 * Each item: { id, title, body, imageUrl|null, createdAt, createdBy }
 */
import { randomUUID } from 'node:crypto';
import { getState, setState } from './appState.js';

const KEY = 'dashboard_news';
const MAX_POSTS = 40;

export async function listNews({ limit = 20 } = {}) {
  const rows = (await getState(KEY, [])) || [];
  const list = Array.isArray(rows) ? rows : [];
  return list
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export async function addNews({ title, body, imageUrl, createdBy }) {
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  const img = imageUrl ? String(imageUrl).trim() : null;
  if (!t && !b && !img) throw new Error('Title, text, or image required');
  const item = {
    id: randomUUID(),
    title: t || (img ? 'Update' : 'News'),
    body: b,
    imageUrl: img || null,
    createdAt: new Date().toISOString(),
    createdBy: createdBy || null,
  };
  const prev = (await getState(KEY, [])) || [];
  const next = [item, ...(Array.isArray(prev) ? prev : [])].slice(0, MAX_POSTS);
  await setState(KEY, next);
  return item;
}

export async function deleteNews(id) {
  const prev = (await getState(KEY, [])) || [];
  const next = (Array.isArray(prev) ? prev : []).filter((n) => n.id !== id);
  await setState(KEY, next);
  return { ok: true, remaining: next.length };
}
