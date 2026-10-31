import { getDb } from '../database/db.js';

export async function writePaymentAudit({ payment_id, user_id, event, previous_status, new_status, source = 'system', meta = {} }) {
  const row = {
    payment_id: payment_id || null,
    user_id: user_id || null,
    event,
    previous_status: previous_status || null,
    new_status: new_status || null,
    source,
    meta,
    created_at: new Date().toISOString(),
  };
  const db = getDb();
  if (db.type === 'supabase') {
    try {
      await db.client.from('payment_audit').insert(row);
    } catch (e) {
      console.warn('[payment_audit]', e.message);
    }
    return row;
  }
  if (!db.store.payment_audit) db.store.payment_audit = [];
  row.id = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.store.payment_audit.unshift(row);
  return row;
}
