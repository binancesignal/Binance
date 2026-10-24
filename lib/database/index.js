/**
 * Database abstraction layer.
 * Production: Supabase via service role (server-only).
 * Development (no env): in-memory store (NOT for production).
 */
import { createClient } from '@supabase/supabase-js';

let supabase = null;
let memoryStore = null;

function isSupabaseConfigured() {
  return !!(
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export class DbConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DbConfigError';
    this.code = 'DB_NOT_CONFIGURED';
  }
}

// Vercel preview/production deployments must never use the in-memory store.
function isProductionRuntime() {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.VERCEL === '1' ||
    !!process.env.VERCEL_ENV
  );
}

let loggedType = false;

export function getDb() {
  if (isSupabaseConfigured()) {
    if (!supabase) {
      supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
    }
    if (!loggedType) {
      loggedType = true;
      console.log('[DB] database type = supabase');
    }
    return { type: 'supabase', client: supabase };
  }

  if (isProductionRuntime()) {
    throw new DbConfigError(
      'Database not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production. ' +
        'Set them in the Vercel project environment variables and redeploy.'
    );
  }

  // Dev-only in-memory fallback
  if (!memoryStore) {
    memoryStore = {
      signals: new Map(),
      events: [],
      scanRuns: [],
      appState: new Map(),
      lock: null,
    };
    console.warn(
      '[DB] Using in-memory store (development only). Connect Supabase for production.'
    );
  }
  return { type: 'memory', store: memoryStore };
}

export function isProductionDbReady() {
  return isSupabaseConfigured();
}
