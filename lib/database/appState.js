import { getDb } from './index.js';

export async function getState(key, fallback = null) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('app_state')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    return data ? data.value : fallback;
  }
  return db.store.appState.has(key) ? db.store.appState.get(key) : fallback;
}

export async function setState(key, value) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { error } = await db.client
      .from('app_state')
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
    return;
  }
  db.store.appState.set(key, value);
}
