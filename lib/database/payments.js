/**
 * Payments, wallet, deposits, withdrawals, multi-level referrals.
 */
import { getDb } from './index.js';
import { randomUUID } from 'node:crypto';
import { getUserById, updateUser, getUserByEmail } from './users.js';

const SETTINGS_ID = 'default';

function memPay() {
  const db = getDb();
  if (db.type !== 'memory') return null;
  if (!db.store.payment_settings) {
    db.store.payment_settings = {
      id: SETTINGS_ID,
      plan_price_usdt: 49,
      plan_duration_days: 30,
      plan_name: 'Pro',
      deposit_address_usdt: '',
      deposit_network: 'TRC20',
      deposit_auto_confirm_minutes: 0,
      withdraw_min_usdt: 10,
      withdraw_fee_usdt: 1,
      withdraw_coins: ['USDT', 'BTC', 'ETH', 'BNB'],
      referral_levels: 4,
      referral_rates: [10, 5, 3, 2],
      auto_deposit_enabled: true,
      auto_withdraw_enabled: false,
      auto_withdraw_max_usdt: 50,
      usdt_enabled: true,
      paypal_enabled: true,
      bank_enabled: false,
      usdt_price: null,
      paypal_price: null,
      bank_price: null,
      usdt_fee_pct: 0,
      paypal_fee_pct: 0,
      bank_fee_pct: 0,
      paypal_email: '',
      paypal_me_link: '',
      bank_instructions: '',
      require_profile_verify_for_pay: false,
      updated_at: new Date().toISOString(),
    };
  }
  if (!db.store.deposits) db.store.deposits = new Map();
  if (!db.store.payment_audit) db.store.payment_audit = [];
  if (!db.store.withdrawals) db.store.withdrawals = new Map();
  if (!db.store.wallet_ledger) db.store.wallet_ledger = [];
  if (!db.store.referral_earnings) db.store.referral_earnings = [];
  return db.store;
}

export async function getPaymentSettings() {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('payment_settings')
      .select('*')
      .eq('id', SETTINGS_ID)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const defaults = {
        id: SETTINGS_ID,
        plan_price_usdt: 49,
        plan_duration_days: 30,
        plan_name: 'Pro',
        deposit_address_usdt: '',
        deposit_network: 'TRC20',
        deposit_auto_confirm_minutes: 0,
        withdraw_min_usdt: 10,
        withdraw_fee_usdt: 1,
        withdraw_coins: ['USDT', 'BTC', 'ETH', 'BNB'],
        referral_levels: 4,
        referral_rates: [10, 5, 3, 2],
        auto_deposit_enabled: true,
        auto_withdraw_enabled: false,
        auto_withdraw_max_usdt: 50,
        usdt_enabled: true,
        paypal_enabled: true,
        bank_enabled: false,
        require_profile_verify_for_pay: false,
      };
      await db.client.from('payment_settings').upsert(defaults);
      return defaults;
    }
    return data;
  }
  return { ...memPay().payment_settings };
}

export async function updatePaymentSettings(patch) {
  const allowed = [
    'plan_price_usdt',
    'plan_duration_days',
    'plan_name',
    'deposit_address_usdt',
    'deposit_network',
    'deposit_auto_confirm_minutes',
    'withdraw_min_usdt',
    'withdraw_fee_usdt',
    'withdraw_coins',
    'referral_levels',
    'referral_rates',
    'auto_deposit_enabled',
    'auto_withdraw_enabled',
    'auto_withdraw_max_usdt',
    'usdt_enabled',
    'paypal_enabled',
    'bank_enabled',
    'usdt_price',
    'paypal_price',
    'bank_price',
    'usdt_fee_pct',
    'paypal_fee_pct',
    'bank_fee_pct',
    'paypal_email',
    'paypal_me_link',
    'bank_instructions',
    'require_profile_verify_for_pay',
  ];
  const clean = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) clean[k] = patch[k];
  }
  clean.updated_at = new Date().toISOString();

  if (clean.referral_rates && !Array.isArray(clean.referral_rates)) {
    clean.referral_rates = String(clean.referral_rates)
      .split(',')
      .map((x) => Number(String(x).trim()))
      .filter((n) => !Number.isNaN(n));
  }
  if (clean.withdraw_coins && !Array.isArray(clean.withdraw_coins)) {
    clean.withdraw_coins = String(clean.withdraw_coins)
      .split(',')
      .map((x) => String(x).trim().toUpperCase())
      .filter(Boolean);
  }
  if (clean.plan_price_usdt != null) clean.plan_price_usdt = Number(clean.plan_price_usdt);
  if (clean.plan_duration_days != null) clean.plan_duration_days = Math.max(1, parseInt(clean.plan_duration_days, 10) || 30);
  if (clean.referral_levels != null) clean.referral_levels = Math.max(1, Math.min(10, parseInt(clean.referral_levels, 10) || 4));
  if (clean.withdraw_min_usdt != null) clean.withdraw_min_usdt = Number(clean.withdraw_min_usdt);
  if (clean.withdraw_fee_usdt != null) clean.withdraw_fee_usdt = Number(clean.withdraw_fee_usdt);
  if (clean.deposit_auto_confirm_minutes != null) {
    clean.deposit_auto_confirm_minutes = Math.max(0, parseInt(clean.deposit_auto_confirm_minutes, 10) || 0);
  }
  if (clean.auto_deposit_enabled != null) clean.auto_deposit_enabled = !!clean.auto_deposit_enabled && clean.auto_deposit_enabled !== 'false';
  if (clean.auto_withdraw_enabled != null) clean.auto_withdraw_enabled = !!clean.auto_withdraw_enabled && clean.auto_withdraw_enabled !== 'false';
  for (const bk of ['usdt_enabled', 'paypal_enabled', 'bank_enabled', 'require_profile_verify_for_pay']) {
    if (clean[bk] != null) clean[bk] = !!clean[bk] && clean[bk] !== 'false';
  }
  for (const nk of ['usdt_price', 'paypal_price', 'bank_price', 'usdt_fee_pct', 'paypal_fee_pct', 'bank_fee_pct']) {
    if (clean[nk] != null && clean[nk] !== '') clean[nk] = Number(clean[nk]);
  }
  if (clean.auto_withdraw_max_usdt != null) clean.auto_withdraw_max_usdt = Number(clean.auto_withdraw_max_usdt);

  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('payment_settings')
      .upsert({ id: SETTINGS_ID, ...clean })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  Object.assign(memPay().payment_settings, clean);
  return { ...memPay().payment_settings };
}

/** Ensure user has a referral code */
export async function ensureReferralCode(userId) {
  const user = await getUserById(userId);
  if (!user) throw new Error('User not found');
  if (user.referral_code) return user.referral_code;

  const code = genCode();
  await updateUser(userId, { referral_code: code });
  return code;
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export async function getUserByReferralCode(code) {
  if (!code) return null;
  const db = getDb();
  const c = String(code).trim().toUpperCase();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('users').select('*').eq('referral_code', c).maybeSingle();
    if (error) throw error;
    return data;
  }
  for (const u of memPay() && getDb().store.users?.values?.() || []) {
    if (String(u.referral_code || '').toUpperCase() === c) return u;
  }
  // memory path via users map
  const store = getDb().store;
  if (store?.users) {
    for (const u of store.users.values()) {
      if (String(u.referral_code || '').toUpperCase() === c) return u;
    }
  }
  return null;
}

export async function attachReferrer(userId, refCode) {
  if (!refCode) return null;
  const referrer = await getUserByReferralCode(refCode);
  if (!referrer || referrer.id === userId) return null;
  const user = await getUserById(userId);
  if (user?.referred_by) return user.referred_by;
  await updateUser(userId, { referred_by: referrer.id });
  return referrer.id;
}

export async function getWalletBalance(userId) {
  const u = await getUserById(userId);
  return Number(u?.wallet_balance || 0);
}

async function adjustWallet(userId, amount, type, refType = null, refId = null, meta = {}) {
  const db = getDb();
  const delta = Number(amount);
  if (!delta || Number.isNaN(delta)) throw new Error('Invalid amount');

  if (db.type === 'supabase') {
    const { data: user, error: e1 } = await db.client.from('users').select('wallet_balance').eq('id', userId).single();
    if (e1) throw e1;
    const next = Number(user.wallet_balance || 0) + delta;
    if (next < -0.0001) throw new Error('Insufficient wallet balance');
    const { error: e2 } = await db.client
      .from('users')
      .update({ wallet_balance: next, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (e2) throw e2;
    await db.client.from('wallet_ledger').insert({
      id: randomUUID(),
      user_id: userId,
      type,
      amount: delta,
      balance_after: next,
      ref_type: refType,
      ref_id: refId ? String(refId) : null,
      meta,
      created_at: new Date().toISOString(),
    });
    return next;
  }

  const store = getDb().store;
  const u = store.users.get(userId);
  if (!u) throw new Error('User not found');
  const next = Number(u.wallet_balance || 0) + delta;
  if (next < -0.0001) throw new Error('Insufficient wallet balance');
  u.wallet_balance = next;
  memPay().wallet_ledger.push({
    id: randomUUID(),
    user_id: userId,
    type,
    amount: delta,
    balance_after: next,
    ref_type: refType,
    ref_id: refId,
    meta,
    created_at: new Date().toISOString(),
  });
  return next;
}

/** Admin credit/debit wallet */
export async function adminAdjustWallet(userId, amount, note = '') {
  return adjustWallet(userId, amount, amount >= 0 ? 'admin_credit' : 'admin_debit', 'admin', null, { note });
}

export async function listLedger(userId, limit = 50) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('wallet_ledger')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
  return memPay()
    .wallet_ledger.filter((x) => x.user_id === userId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit);
}

/** Create deposit intent — unique amount = price + tiny suffix for matching */
export async function createDeposit(userId, method = 'usdt') {
  const settings = await getPaymentSettings();
  const m = String(method || 'usdt').toLowerCase();
  if (!['usdt', 'paypal', 'bank'].includes(m)) throw new Error('Invalid payment method');
  if (m === 'usdt' && settings.usdt_enabled === false) throw new Error('USDT payments are suspended');
  if (m === 'paypal' && settings.paypal_enabled === false) throw new Error('PayPal payments are suspended');
  if (m === 'bank' && settings.bank_enabled === false) throw new Error('Bank transfer is suspended');

  const basePrice =
    m === 'paypal' ? Number(settings.paypal_price ?? settings.plan_price_usdt) || 49
    : m === 'bank' ? Number(settings.bank_price ?? settings.plan_price_usdt) || 49
    : Number(settings.usdt_price ?? settings.plan_price_usdt) || 49;
  const feePct =
    m === 'paypal' ? Number(settings.paypal_fee_pct) || 0
    : m === 'bank' ? Number(settings.bank_fee_pct) || 0
    : Number(settings.usdt_fee_pct) || 0;
  const withFee = Math.round(basePrice * (1 + feePct / 100) * 100) / 100;
  // unique cents only for USDT on-chain matching
  const suffix = m === 'usdt' ? ((Date.now() % 90) + 10) / 100 : 0;
  const uniqueAmount = Math.round((withFee + suffix) * 100) / 100;
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2h window

  const row = {
    id: randomUUID(),
    user_id: userId,
    amount_usdt: basePrice,
    expected_amount: uniqueAmount,
    unique_amount: uniqueAmount,
    method: m,
    currency: m === 'paypal' ? 'USD' : 'USDT',
    network: m === 'usdt' ? (settings.deposit_network || 'TRC20') : m,
    address: m === 'usdt' ? (settings.deposit_address_usdt || '') : null,
    tx_hash: null,
    status: 'pending', // WAITING_PAYMENT
    status_detail: 'WAITING_PAYMENT',
    note: null,
    confirmed_by: null,
    confirmed_at: null,
    detected_at: null,
    detected_amount: null,
    external_ref: null,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('deposits').insert(row).select().single();
    if (error) throw error;
    try {
      await db.client.from('payment_audit').insert({
        payment_id: data.id,
        user_id: userId,
        event: 'PAYMENT_CREATED',
        previous_status: null,
        new_status: 'pending',
        source: 'user',
        meta: { method: m, expected_amount: uniqueAmount },
      });
    } catch (_) {}
    return data;
  }
  memPay().deposits.set(row.id, row);
  memPay().payment_audit.unshift({
    id: randomUUID(),
    payment_id: row.id,
    user_id: userId,
    event: 'PAYMENT_CREATED',
    previous_status: null,
    new_status: 'pending',
    source: 'user',
    meta: { method: m },
    created_at: row.created_at,
  });
  return row;
}

export async function submitDepositTx(userId, depositId, txHash) {
  const db = getDb();
  const patch = {
    tx_hash: String(txHash || '').trim() || null,
    status: 'submitted',
    updated_at: new Date().toISOString(),
  };
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('deposits')
      .update(patch)
      .eq('id', depositId)
      .eq('user_id', userId)
      .in('status', ['pending', 'submitted'])
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const d = memPay().deposits.get(depositId);
  if (!d || d.user_id !== userId) throw new Error('Deposit not found');
  Object.assign(d, patch);
  return d;
}

export async function listUserDeposits(userId, limit = 20) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('deposits')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
  return [...memPay().deposits.values()]
    .filter((d) => d.user_id === userId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit);
}

export async function listPendingDeposits(limit = 50) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('deposits')
      .select('*')
      .in('status', ['pending', 'submitted'])
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
  return [...memPay().deposits.values()]
    .filter((d) => d.status === 'pending' || d.status === 'submitted')
    .sort((a, b) => (a.created_at > b.created_at ? 1 : -1))
    .slice(0, limit);
}

/**
 * Confirm deposit → activate plan + pay referral commissions up the chain.
 */
export async function confirmDeposit(depositId, adminId = null) {
  const db = getDb();
  let deposit;
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('deposits').select('*').eq('id', depositId).single();
    if (error) throw error;
    deposit = data;
  } else {
    deposit = memPay().deposits.get(depositId);
  }
  if (!deposit) throw new Error('Deposit not found');
  if (deposit.status === 'confirmed') {
    return { ok: true, already: true, plan_expires_at: null };
  }

  // Same chain tx cannot activate two accounts
  if (deposit.tx_hash) {
    const db2 = getDb();
    if (db2.type === 'supabase') {
      const { data: clash } = await db2.client
        .from('deposits')
        .select('id,user_id,status')
        .eq('tx_hash', deposit.tx_hash)
        .eq('status', 'confirmed')
        .neq('id', depositId)
        .maybeSingle();
      if (clash) throw new Error('DUPLICATE: transaction already used');
    } else {
      for (const d of memPay().deposits.values()) {
        if (d.tx_hash === deposit.tx_hash && d.status === 'confirmed' && d.id !== depositId) {
          throw new Error('DUPLICATE: transaction already used');
        }
      }
    }
  }

  const settings = await getPaymentSettings();
  const durationDays = Number(settings.plan_duration_days) || 30;
  const user = await getUserById(deposit.user_id);
  if (!user) throw new Error('User not found');

  const now = new Date();
  // Idempotent activation: only extend from current expiry once per payment
  const base = user.plan_expires_at && new Date(user.plan_expires_at) > now
    ? new Date(user.plan_expires_at)
    : now;
  const expires = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);

  const patch = {
    status: 'confirmed',
    status_detail: 'SUBSCRIPTION_ACTIVE',
    confirmed_by: adminId,
    confirmed_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  if (db.type === 'supabase') {
    // conditional update prevents double-confirm race
    const { data: updated, error } = await db.client
      .from('deposits')
      .update(patch)
      .eq('id', depositId)
      .neq('status', 'confirmed')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!updated) return { ok: true, already: true };
  } else {
    if (deposit.status === 'confirmed') return { ok: true, already: true };
    Object.assign(deposit, patch);
  }

  await updateUser(deposit.user_id, {
    plan: 'pro',
    subscription_status: 'active',
    plan_expires_at: expires.toISOString(),
    trial_ends_at: expires.toISOString(),
  });

  try {
    if (db.type === 'supabase') {
      await db.client.from('payment_audit').insert([
        {
          payment_id: depositId,
          user_id: deposit.user_id,
          event: 'PAYMENT_CONFIRMED',
          previous_status: 'pending',
          new_status: 'confirmed',
          source: adminId ? 'admin' : 'worker',
        },
        {
          payment_id: depositId,
          user_id: deposit.user_id,
          event: 'SUBSCRIPTION_ACTIVATED',
          previous_status: user.subscription_status,
          new_status: 'active',
          source: adminId ? 'admin' : 'worker',
          meta: { plan_expires_at: expires.toISOString(), duration_days: durationDays },
        },
      ]);
    }
  } catch (_) {}

  const paid = await payReferralChain(deposit.user_id, Number(deposit.amount_usdt), deposit.id, settings);

  return {
    ok: true,
    plan_expires_at: expires.toISOString(),
    duration_days: durationDays,
    referral_paid: paid,
  };
}

export async function rejectDeposit(depositId, adminId = null, note = '') {
  const db = getDb();
  const patch = {
    status: 'rejected',
    confirmed_by: adminId,
    confirmed_at: new Date().toISOString(),
    note: note || null,
    updated_at: new Date().toISOString(),
  };
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('deposits').update(patch).eq('id', depositId).select().single();
    if (error) throw error;
    return data;
  }
  const d = memPay().deposits.get(depositId);
  if (!d) throw new Error('Deposit not found');
  Object.assign(d, patch);
  return d;
}

async function payReferralChain(buyerId, packageUsdt, depositId, settings) {
  const levels = Number(settings.referral_levels) || 4;
  const rates = Array.isArray(settings.referral_rates) ? settings.referral_rates : [10, 5, 3, 2];
  const paid = [];
  let currentId = buyerId;

  for (let level = 1; level <= levels; level++) {
    const user = await getUserById(currentId);
    if (!user?.referred_by) break;
    const earnerId = user.referred_by;
    const rate = Number(rates[level - 1] || 0);
    if (rate <= 0) {
      currentId = earnerId;
      continue;
    }
    const amount = Math.round(((packageUsdt * rate) / 100) * 100) / 100;
    if (amount <= 0) {
      currentId = earnerId;
      continue;
    }
    await adjustWallet(earnerId, amount, 'referral', 'deposit', depositId, {
      level,
      from_user_id: buyerId,
      rate,
    });

    const row = {
      id: randomUUID(),
      earner_id: earnerId,
      from_user_id: buyerId,
      level,
      deposit_id: depositId,
      amount_usdt: amount,
      rate_percent: rate,
      created_at: new Date().toISOString(),
    };
    const db = getDb();
    if (db.type === 'supabase') {
      await db.client.from('referral_earnings').insert(row);
    } else {
      memPay().referral_earnings.push(row);
    }
    paid.push({ earner_id: earnerId, level, amount });
    currentId = earnerId;
  }
  return paid;
}

export async function getReferralStats(userId) {
  const code = await ensureReferralCode(userId);
  const db = getDb();
  let directs = [];
  let earnings = [];

  if (db.type === 'supabase') {
    const { data: d } = await db.client
      .from('users')
      .select('id,email,plan,subscription_status,created_at,plan_expires_at')
      .eq('referred_by', userId)
      .order('created_at', { ascending: false });
    directs = d || [];
    const { data: e } = await db.client
      .from('referral_earnings')
      .select('*')
      .eq('earner_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    earnings = e || [];
  } else {
    const store = getDb().store;
    directs = [...(store.users?.values?.() || [])].filter((u) => u.referred_by === userId);
    earnings = memPay().referral_earnings.filter((x) => x.earner_id === userId);
  }

  const totalEarned = earnings.reduce((s, x) => s + Number(x.amount_usdt || 0), 0);
  const balance = await getWalletBalance(userId);
  const settings = await getPaymentSettings();

  return {
    referral_code: code,
    referral_link_path: `/signup?ref=${code}`,
    levels: settings.referral_levels,
    rates: settings.referral_rates,
    direct_count: directs.length,
    directs: directs.map((u) => ({
      id: u.id,
      email: maskEmail(u.email),
      plan: u.plan,
      status: u.subscription_status,
      joined: u.created_at,
    })),
    total_earned: totalEarned,
    wallet_balance: balance,
    recent_earnings: earnings.slice(0, 20),
  };
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return '***';
  const [a, b] = email.split('@');
  return (a.slice(0, 2) || '*') + '***@' + b;
}

/** Rough market prices for withdraw conversion (admin can override later) */
const FALLBACK_PRICES = { USDT: 1, BTC: 95000, ETH: 3500, BNB: 600, TRX: 0.25 };

export async function getCoinPrices() {
  try {
    const ids = 'tether,bitcoin,ethereum,binancecoin,tron';
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { next: { revalidate: 60 } }
    );
    if (!res.ok) throw new Error('price api');
    const j = await res.json();
    return {
      USDT: j.tether?.usd || 1,
      BTC: j.bitcoin?.usd || FALLBACK_PRICES.BTC,
      ETH: j.ethereum?.usd || FALLBACK_PRICES.ETH,
      BNB: j.binancecoin?.usd || FALLBACK_PRICES.BNB,
      TRX: j.tron?.usd || FALLBACK_PRICES.TRX,
    };
  } catch {
    return { ...FALLBACK_PRICES };
  }
}

export async function createWithdrawal(userId, { amount_usdt, coin, address, network }) {
  const settings = await getPaymentSettings();
  const min = Number(settings.withdraw_min_usdt) || 10;
  const fee = Number(settings.withdraw_fee_usdt) || 0;
  const amt = Number(amount_usdt);
  if (!amt || amt < min) throw new Error(`Minimum withdraw is ${min} USDT`);
  if (!address || String(address).trim().length < 10) throw new Error('Valid wallet address required');

  const coins = settings.withdraw_coins || ['USDT'];
  const c = String(coin || 'USDT').toUpperCase();
  if (!coins.map((x) => String(x).toUpperCase()).includes(c)) {
    throw new Error(`Coin not allowed. Use: ${coins.join(', ')}`);
  }

  const totalDebit = amt + fee;
  const bal = await getWalletBalance(userId);
  if (bal < totalDebit) throw new Error(`Insufficient balance. Need ${totalDebit} USDT (incl. fee ${fee})`);

  const prices = await getCoinPrices();
  const price = prices[c] || 1;
  const coinAmount = c === 'USDT' ? amt : Math.round((amt / price) * 1e8) / 1e8;

  // lock funds
  await adjustWallet(userId, -totalDebit, 'withdraw_hold', 'withdrawal', null, { coin: c, fee });

  const row = {
    id: randomUUID(),
    user_id: userId,
    amount_usdt: amt,
    coin: c,
    coin_amount: coinAmount,
    coin_price_usdt: price,
    address: String(address).trim(),
    network: network || (c === 'USDT' ? settings.deposit_network || 'TRC20' : c),
    status: 'pending',
    admin_note: null,
    processed_by: null,
    processed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('withdrawals').insert(row).select().single();
    if (error) {
      // refund on failure
      await adjustWallet(userId, totalDebit, 'withdraw_refund', 'withdrawal', null, {});
      throw error;
    }
    return data;
  }
  memPay().withdrawals.set(row.id, row);
  return row;
}

export async function listUserWithdrawals(userId, limit = 20) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('withdrawals')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
  return [...memPay().withdrawals.values()]
    .filter((w) => w.user_id === userId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit);
}

export async function listPendingWithdrawals(limit = 50) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('withdrawals')
      .select('*')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
  return [...memPay().withdrawals.values()]
    .filter((w) => w.status === 'pending' || w.status === 'processing')
    .slice(0, limit);
}

export async function completeWithdrawal(withdrawalId, adminId, note = '') {
  const db = getDb();
  let w;
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('withdrawals').select('*').eq('id', withdrawalId).single();
    if (error) throw error;
    w = data;
  } else {
    w = memPay().withdrawals.get(withdrawalId);
  }
  if (!w) throw new Error('Withdrawal not found');
  if (w.status === 'completed') return w;

  const patch = {
    status: 'completed',
    processed_by: adminId,
    processed_at: new Date().toISOString(),
    admin_note: note || null,
    updated_at: new Date().toISOString(),
  };
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('withdrawals').update(patch).eq('id', withdrawalId).select().single();
    if (error) throw error;
    return data;
  }
  Object.assign(w, patch);
  return w;
}

export async function rejectWithdrawal(withdrawalId, adminId, note = '') {
  const db = getDb();
  let w;
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('withdrawals').select('*').eq('id', withdrawalId).single();
    if (error) throw error;
    w = data;
  } else {
    w = memPay().withdrawals.get(withdrawalId);
  }
  if (!w) throw new Error('Withdrawal not found');
  if (w.status === 'completed' || w.status === 'rejected') return w;

  const settings = await getPaymentSettings();
  const fee = Number(settings.withdraw_fee_usdt) || 0;
  const refund = Number(w.amount_usdt) + fee;
  await adjustWallet(w.user_id, refund, 'withdraw_refund', 'withdrawal', w.id, { note });

  const patch = {
    status: 'rejected',
    processed_by: adminId,
    processed_at: new Date().toISOString(),
    admin_note: note || null,
    updated_at: new Date().toISOString(),
  };
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('withdrawals').update(patch).eq('id', withdrawalId).select().single();
    if (error) throw error;
    return data;
  }
  Object.assign(w, patch);
  return w;
}

/** Plan status helper for UI */
export function planCountdown(user) {
  if (!user) return null;
  const exp = user.plan_expires_at || (user.subscription_status === 'trialing' ? user.trial_ends_at : null);
  if (!exp) return null;
  const end = new Date(exp).getTime();
  const now = Date.now();
  const ms = end - now;
  if (ms <= 0) return { expired: true, days: 0, hours: 0, total_hours: 0, expires_at: exp };
  const totalHours = Math.floor(ms / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return { expired: false, days, hours, total_hours: totalHours, expires_at: exp };
}


/** USDT TRC20 contract on Tron mainnet */
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

/**
 * Check TronGrid for incoming USDT to address matching amount.
 * Requires TRON_API_KEY (TronGrid) optional — works with public rate limits too.
 */
export async function findMatchingTronDeposit(address, uniqueAmount, sinceMs) {
  if (!address) return null;
  const key = process.env.TRON_API_KEY || '';
  const headers = { Accept: 'application/json' };
  if (key) headers['TRON-PRO-API-KEY'] = key;

  const minTs = sinceMs || Date.now() - 7 * 24 * 3600 * 1000;
  const target = Number(uniqueAmount);
  const tolerance = 0.001; // allow tiny float noise

  try {
    // TronGrid trc20 transfers to address
    const url =
      `https://api.trongrid.io/v1/accounts/${encodeURIComponent(address)}/transactions/trc20` +
      `?only_to=true&limit=50&contract_address=${USDT_TRC20}`;
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const rows = json.data || [];
    for (const tx of rows) {
      const ts = Number(tx.block_timestamp || 0);
      if (ts && ts < minTs) continue;
      // USDT has 6 decimals
      const raw = Number(tx.value || 0);
      const amount = raw / 1e6;
      if (Math.abs(amount - target) <= tolerance) {
        return {
          tx_hash: tx.transaction_id || tx.txID || null,
          amount,
          from: tx.from,
          timestamp: ts,
        };
      }
    }
  } catch (e) {
    console.warn('[payments] tron check failed', e.message);
  }
  return null;
}

/**
 * Auto-process pending deposits:
 * 1) On-chain match (TRC20 USDT) when auto_deposit_enabled
 * 2) Time-based auto confirm when deposit_auto_confirm_minutes > 0
 */
export async function processAutoDeposits() {
  const settings = await getPaymentSettings();
  const pending = await listPendingDeposits(100);
  const results = [];
  const onChain = settings.auto_deposit_enabled !== false;
  const address = settings.deposit_address_usdt || '';
  const now = Date.now();

  for (const d of pending) {
    try {
      // Expire unpaid windows
      if (d.expires_at && new Date(d.expires_at).getTime() < now) {
        const db = getDb();
        const patch = { status: 'expired', status_detail: 'EXPIRED', updated_at: new Date().toISOString() };
        if (db.type === 'supabase') {
          await db.client.from('deposits').update(patch).eq('id', d.id).in('status', ['pending', 'submitted']);
        } else if (memPay().deposits.get(d.id)) {
          Object.assign(memPay().deposits.get(d.id), patch);
        }
        results.push({ id: d.id, via: 'expired' });
        continue;
      }

      // USDT: chain verification only (never timer-only)
      const method = d.method || 'usdt';
      if (method === 'usdt' && onChain && address && (d.unique_amount || d.expected_amount)) {
        const since = new Date(d.created_at).getTime() - 60_000;
        const match = await findMatchingTronDeposit(address, d.unique_amount || d.expected_amount, since);
        if (match) {
          if (match.tx_hash && !d.tx_hash) {
            try {
              await submitDepositTx(d.user_id, d.id, match.tx_hash);
            } catch (e) {
              if (/duplicate|unique/i.test(e.message || '')) {
                results.push({ id: d.id, error: 'DUPLICATE_TX' });
                continue;
              }
            }
          }
          const db = getDb();
          if (db.type === 'supabase') {
            await db.client
              .from('deposits')
              .update({
                detected_amount: match.amount,
                detected_at: new Date().toISOString(),
                status_detail: 'PAYMENT_DETECTED',
                updated_at: new Date().toISOString(),
              })
              .eq('id', d.id);
          }
          const r = await confirmDeposit(d.id, null);
          results.push({ id: d.id, via: 'onchain', ...r });
          continue;
        }
      }
      // PayPal / bank: no auto-chain verify — admin confirm or future webhook
    } catch (e) {
      results.push({ id: d.id, error: e.message });
    }
  }
  return { checked: pending.length, confirmed: results.filter((x) => x.ok).length, results };
}

/**
 * Auto-complete withdrawals under max when auto_withdraw_enabled.
 * NOTE: This marks status completed — actual on-chain send is still manual
 * unless you connect an external payout bot watching pending_withdrawals.
 */
export async function processAutoWithdrawals() {
  const settings = await getPaymentSettings();
  if (!settings.auto_withdraw_enabled) {
    return { enabled: false, completed: 0 };
  }
  const max = Number(settings.auto_withdraw_max_usdt) || 50;
  const pending = await listPendingWithdrawals(100);
  const results = [];
  for (const w of pending) {
    try {
      if (Number(w.amount_usdt) <= max) {
        const r = await completeWithdrawal(w.id, null, 'auto_withdraw');
        results.push({ id: w.id, ok: true, amount: w.amount_usdt });
      }
    } catch (e) {
      results.push({ id: w.id, error: e.message });
    }
  }
  return {
    enabled: true,
    max,
    checked: pending.length,
    completed: results.filter((x) => x.ok).length,
    results,
  };
}

