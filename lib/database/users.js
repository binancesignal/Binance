/**
 * Multi-user data access layer.
 * Tables: users, plans, subscriptions, user_exchange_keys, user_trading_settings, admin_audit_log
 */
import { getDb } from './index.js';
import { encryptSecret, decryptSecret, maskSecret } from '../auth/crypto.js';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);

// ─── memory helpers ───────────────────────────────────────────────
function memUsers() {
  const db = getDb();
  if (db.type !== 'memory') return null;
  if (!db.store.users) db.store.users = new Map();
  if (!db.store.plans) {
    db.store.plans = new Map();
    // seed default plans
    const defaults = [
      { id: 'trial', name: 'Trial', price_cents: 0, currency: 'usd', auto_trade: false, max_positions: 1, max_pairs: 5, features: ['signals_view'], trial_days: TRIAL_DAYS, active: true },
      { id: 'signal', name: 'Signal', price_cents: 1900, currency: 'usd', auto_trade: false, max_positions: 0, max_pairs: 50, features: ['signals_view', 'telegram'], trial_days: 0, active: true },
      { id: 'auto', name: 'Auto', price_cents: 4900, currency: 'usd', auto_trade: true, max_positions: 5, max_pairs: 100, features: ['signals_view', 'telegram', 'auto_trade'], trial_days: 0, active: true },
      { id: 'pro', name: 'Pro', price_cents: 9900, currency: 'usd', auto_trade: true, max_positions: 15, max_pairs: 200, features: ['signals_view', 'telegram', 'auto_trade', 'priority'], trial_days: 0, active: true },
    ];
    for (const p of defaults) db.store.plans.set(p.id, p);
  }
  if (!db.store.subscriptions) db.store.subscriptions = new Map();
  if (!db.store.user_keys) db.store.user_keys = new Map();
  if (!db.store.user_settings) db.store.user_settings = new Map();
  if (!db.store.audit) db.store.audit = [];
  return db.store;
}

// ─── Plans ────────────────────────────────────────────────────────
export async function listPlans() {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('plans').select('*').eq('active', true).order('price_cents');
    if (error) throw error;
    return data || [];
  }
  return [...memUsers().plans.values()].filter((p) => p.active);
}

export async function getPlan(id) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('plans').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }
  return memUsers().plans.get(id) || null;
}

export async function upsertPlan(plan) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('plans').upsert(plan).select().single();
    if (error) throw error;
    return data;
  }
  const store = memUsers();
  const existing = store.plans.get(plan.id) || {};
  const next = { ...existing, ...plan };
  store.plans.set(plan.id, next);
  return next;
}

// ─── Users ────────────────────────────────────────────────────────
export async function createUser({ email, password, role = 'user' }) {
  const emailNorm = String(email).trim().toLowerCase();
  if (!emailNorm || !password || password.length < 8) {
    throw new Error('Valid email and password (min 8 chars) required');
  }
  const existing = await getUserByEmail(emailNorm);
  if (existing) throw new Error('Email already registered');

  const id = randomUUID();
  const password_hash = await bcrypt.hash(password, 12);
  const now = new Date();
  const trialEnds = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  const user = {
    id,
    email: emailNorm,
    password_hash,
    role,
    plan: 'trial',
    trial_started_at: now.toISOString(),
    trial_ends_at: trialEnds.toISOString(),
    subscription_status: 'trialing',
    is_suspended: false,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('users').insert(user).select().single();
    if (error) throw error;
    // create default subscription row
    await db.client.from('subscriptions').insert({
      id: randomUUID(),
      user_id: id,
      plan_id: 'trial',
      status: 'trialing',
      current_period_end: trialEnds.toISOString(),
      created_at: now.toISOString(),
    });
    return sanitizeUser(data);
  }

  const store = memUsers();
  store.users.set(id, user);
  store.subscriptions.set(id, {
    id: randomUUID(),
    user_id: id,
    plan_id: 'trial',
    status: 'trialing',
    current_period_end: trialEnds.toISOString(),
    created_at: now.toISOString(),
  });
  return sanitizeUser(user);
}

export async function getUserById(id) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('users').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }
  return memUsers().users.get(id) || null;
}

export async function getUserByEmail(email) {
  const emailNorm = String(email).trim().toLowerCase();
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('users').select('*').eq('email', emailNorm).maybeSingle();
    if (error) throw error;
    return data;
  }
  for (const u of memUsers().users.values()) {
    if (u.email === emailNorm) return u;
  }
  return null;
}

export function sanitizeUser(u) {
  if (!u) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

export async function verifyPassword(user, password) {
  if (!user?.password_hash) return false;
  return bcrypt.compare(password, user.password_hash);
}

export async function updateUser(id, patch) {
  const db = getDb();
  const allowed = [
    'plan', 'subscription_status', 'trial_ends_at', 'trial_started_at',
    'is_suspended', 'role', 'stripe_customer_id', 'updated_at',
  ];
  const clean = {};
  for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
  clean.updated_at = new Date().toISOString();

  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('users').update(clean).eq('id', id).select().single();
    if (error) throw error;
    return sanitizeUser(data);
  }
  const store = memUsers();
  const u = store.users.get(id);
  if (!u) throw new Error('User not found');
  Object.assign(u, clean);
  return sanitizeUser(u);
}

export async function listUsers({ search = '', limit = 50, offset = 0 } = {}) {
  const db = getDb();
  if (db.type === 'supabase') {
    let q = db.client.from('users').select('id,email,role,plan,subscription_status,trial_ends_at,is_suspended,created_at,updated_at').order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (search) q = q.ilike('email', `%${search}%`);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
  let list = [...memUsers().users.values()].map(sanitizeUser);
  if (search) {
    const s = search.toLowerCase();
    list = list.filter((u) => u.email.includes(s));
  }
  return list.slice(offset, offset + limit);
}

// ─── Entitlements ─────────────────────────────────────────────────
export function getTrialDaysLeft(user) {
  if (!user?.trial_ends_at) return 0;
  const end = new Date(user.trial_ends_at).getTime();
  const left = Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000));
  return Math.max(0, left);
}

export function isTrialActive(user) {
  return user?.subscription_status === 'trialing' && getTrialDaysLeft(user) > 0;
}

export function hasActiveAccess(user) {
  if (!user || user.is_suspended) return false;
  if (user.subscription_status === 'active') return true;
  if (user.subscription_status === 'trialing' && getTrialDaysLeft(user) > 0) return true;
  // past_due grace could be added
  return false;
}

export function canAutoTrade(user, plan) {
  if (!hasActiveAccess(user)) return false;
  if (user.plan === 'trial') return false; // trial is view-only for auto by default
  const p = plan || { auto_trade: user.plan === 'auto' || user.plan === 'pro' };
  return !!p.auto_trade;
}

export function canViewSignals(user) {
  return hasActiveAccess(user);
}

// ─── Exchange keys (per user) ─────────────────────────────────────
export async function saveUserKeys(userId, { apiKey, apiSecret }) {
  const encrypted_key = encryptSecret(apiKey);
  const encrypted_secret = encryptSecret(apiSecret);
  const row = {
    user_id: userId,
    exchange: 'bybit',
    encrypted_key,
    encrypted_secret,
    key_hint: maskSecret(apiKey),
    updated_at: new Date().toISOString(),
  };
  const db = getDb();
  if (db.type === 'supabase') {
    const { error } = await db.client.from('user_exchange_keys').upsert(row, { onConflict: 'user_id,exchange' });
    if (error) throw error;
    return { key_hint: row.key_hint, connected: true };
  }
  memUsers().user_keys.set(`${userId}:bybit`, row);
  return { key_hint: row.key_hint, connected: true };
}

export async function getUserKeys(userId) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('user_exchange_keys')
      .select('*')
      .eq('user_id', userId)
      .eq('exchange', 'bybit')
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      apiKey: decryptSecret(data.encrypted_key),
      apiSecret: decryptSecret(data.encrypted_secret),
      key_hint: data.key_hint,
    };
  }
  const row = memUsers().user_keys.get(`${userId}:bybit`);
  if (!row) return null;
  return {
    apiKey: decryptSecret(row.encrypted_key),
    apiSecret: decryptSecret(row.encrypted_secret),
    key_hint: row.key_hint,
  };
}

export async function getUserKeyStatus(userId) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data } = await db.client
      .from('user_exchange_keys')
      .select('key_hint, updated_at')
      .eq('user_id', userId)
      .eq('exchange', 'bybit')
      .maybeSingle();
    return data ? { connected: true, key_hint: data.key_hint, updated_at: data.updated_at } : { connected: false };
  }
  const row = memUsers().user_keys.get(`${userId}:bybit`);
  return row ? { connected: true, key_hint: row.key_hint, updated_at: row.updated_at } : { connected: false };
}

// ─── User trading settings ────────────────────────────────────────
export async function getUserTradingSettings(userId) {
  const defaults = {
    autoTradingEnabled: false,
    marginPercent: 2,
    defaultLeverage: 10,
    maxOpenPositions: 3,
  };
  const db = getDb();
  if (db.type === 'supabase') {
    const { data } = await db.client.from('user_trading_settings').select('settings').eq('user_id', userId).maybeSingle();
    return data?.settings ? { ...defaults, ...data.settings } : defaults;
  }
  return memUsers().user_settings.get(userId) || defaults;
}

export async function setUserTradingSettings(userId, settings) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { error } = await db.client.from('user_trading_settings').upsert({
      user_id: userId,
      settings,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    return settings;
  }
  memUsers().user_settings.set(userId, settings);
  return settings;
}

// ─── Subscriptions ────────────────────────────────────────────────
export async function getSubscription(userId) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data } = await db.client.from('subscriptions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data;
  }
  return memUsers().subscriptions.get(userId) || null;
}

export async function updateSubscription(userId, patch) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('subscriptions').update(patch).eq('user_id', userId).select().single();
    if (error) throw error;
    return data;
  }
  const store = memUsers();
  const sub = store.subscriptions.get(userId) || { user_id: userId };
  Object.assign(sub, patch);
  store.subscriptions.set(userId, sub);
  return sub;
}

// ─── Audit log ────────────────────────────────────────────────────
export async function writeAudit(adminId, action, meta = {}) {
  const row = {
    id: randomUUID(),
    admin_id: adminId,
    action,
    meta,
    created_at: new Date().toISOString(),
  };
  const db = getDb();
  if (db.type === 'supabase') {
    await db.client.from('admin_audit_log').insert(row);
    return;
  }
  memUsers().audit.unshift(row);
  if (memUsers().audit.length > 500) memUsers().audit.length = 500;
}

export async function listAudit(limit = 50) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data } = await db.client.from('admin_audit_log').select('*').order('created_at', { ascending: false }).limit(limit);
    return data || [];
  }
  return memUsers().audit.slice(0, limit);
}


// ─── Personal Telegram link ─────────────────────────────────
export async function setTelegramLinkCode(userId, code) {
  const db = getDb();
  const patch = {
    telegram_link_code: code,
    telegram_link_code_expires: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (db.type === 'supabase') {
    const { error } = await db.client.from('users').update(patch).eq('id', userId);
    if (error) throw error;
    return;
  }
  const u = memUsers().users.get(userId);
  if (!u) throw new Error('User not found');
  Object.assign(u, patch);
}

export async function getUserByTelegramLinkCode(code) {
  if (!code) return null;
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('users')
      .select('*')
      .eq('telegram_link_code', String(code))
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (data.telegram_link_code_expires && new Date(data.telegram_link_code_expires) < new Date()) {
      return null;
    }
    return data;
  }
  for (const u of memUsers().users.values()) {
    if (u.telegram_link_code === String(code)) {
      if (u.telegram_link_code_expires && new Date(u.telegram_link_code_expires) < new Date()) {
        return null;
      }
      return u;
    }
  }
  return null;
}

export async function linkTelegramChat(userId, chatId) {
  const db = getDb();
  const patch = {
    telegram_chat_id: String(chatId),
    telegram_linked_at: new Date().toISOString(),
    telegram_link_code: null,
    telegram_link_code_expires: null,
    updated_at: new Date().toISOString(),
  };
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('users').update(patch).eq('id', userId).select().single();
    if (error) throw error;
    return sanitizeUser(data);
  }
  const u = memUsers().users.get(userId);
  if (!u) throw new Error('User not found');
  Object.assign(u, patch);
  return sanitizeUser(u);
}

export async function unlinkTelegram(userId) {
  const db = getDb();
  const patch = {
    telegram_chat_id: null,
    telegram_linked_at: null,
    telegram_link_code: null,
    telegram_link_code_expires: null,
    updated_at: new Date().toISOString(),
  };
  if (db.type === 'supabase') {
    const { error } = await db.client.from('users').update(patch).eq('id', userId);
    if (error) throw error;
    return;
  }
  const u = memUsers().users.get(userId);
  if (u) Object.assign(u, patch);
}

export async function getTelegramStatus(userId) {
  const u = await getUserById(userId);
  if (!u) return { linked: false };
  return {
    linked: !!u.telegram_chat_id,
    chat_id: u.telegram_chat_id ? String(u.telegram_chat_id).slice(0, 4) + '…' : null,
    linked_at: u.telegram_linked_at || null,
  };
}

/** Users with active access + linked Telegram for personal DMs */
export async function listLinkedTelegramUsers() {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('users')
      .select('id,email,plan,subscription_status,trial_ends_at,is_suspended,telegram_chat_id')
      .not('telegram_chat_id', 'is', null);
    if (error) throw error;
    return (data || []).filter((u) => hasActiveAccess(u) && u.telegram_chat_id);
  }
  const out = [];
  for (const u of memUsers().users.values()) {
    if (u.telegram_chat_id && hasActiveAccess(u) && !u.is_suspended) {
      out.push(u);
    }
  }
  return out;
}

export { TRIAL_DAYS };

