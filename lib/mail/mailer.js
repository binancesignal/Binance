/**
 * SMTP mailer. Settings live in app_state key "smtp" (Admin → Email).
 * The app password is AES-256-GCM encrypted at rest (ENCRYPTION_KEY).
 * Env fallback: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM_NAME, SMTP_FROM_EMAIL
 */
import nodemailer from 'nodemailer';
import { getState, setState } from '../database/appState.js';
import { encryptSecret, decryptSecret } from '../auth/crypto.js';

const KEY = 'smtp';

function fromEnv() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromName: process.env.SMTP_FROM_NAME || '',
    fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
  };
}

/** Full config incl. decrypted password, or null when mail is not set up. */
export async function getSmtpConfig() {
  let v = null;
  try { v = await getState(KEY, null); } catch (_) {}
  if (v && v.host && v.user && v.passEnc) {
    let pass = '';
    try { pass = decryptSecret(v.passEnc) || ''; } catch (_) {}
    if (pass) {
      return {
        host: v.host,
        port: Number(v.port) || 465,
        secure: v.secure !== false,
        user: v.user,
        pass,
        fromName: v.fromName || '',
        fromEmail: v.fromEmail || v.user,
      };
    }
  }
  return fromEnv();
}

export async function isMailConfigured() {
  return !!(await getSmtpConfig());
}

/** Safe shape for the admin UI — never returns the password. */
export async function getSmtpPublic() {
  let v = null;
  try { v = await getState(KEY, null); } catch (_) {}
  const cfg = await getSmtpConfig();
  return {
    host: v?.host || '',
    port: Number(v?.port) || 465,
    secure: v?.secure !== false,
    user: v?.user || '',
    fromName: v?.fromName || '',
    fromEmail: v?.fromEmail || '',
    hasPassword: !!v?.passEnc,
    configured: !!cfg,
    source: v?.passEnc ? 'admin' : cfg ? 'env' : 'none',
  };
}

export async function saveSmtpConfig(body = {}) {
  const prev = (await getState(KEY, {})) || {};
  const next = { ...prev };
  if (typeof body.host === 'string') next.host = body.host.trim();
  if (body.port !== undefined) next.port = Math.max(1, Math.min(65535, Number(body.port) || 465));
  if (typeof body.secure === 'boolean') next.secure = body.secure;
  if (typeof body.user === 'string') next.user = body.user.trim();
  if (typeof body.fromName === 'string') next.fromName = body.fromName.trim().slice(0, 60);
  if (typeof body.fromEmail === 'string') next.fromEmail = body.fromEmail.trim();
  // Gmail shows app passwords as "abcd efgh ijkl mnop" — strip spaces.
  if (typeof body.pass === 'string' && body.pass.trim()) {
    next.passEnc = encryptSecret(body.pass.replace(/\s+/g, ''));
  }
  if (body.clearPassword) next.passEnc = null;
  next.updatedAt = new Date().toISOString();
  await setState(KEY, next);
  return getSmtpPublic();
}

function makeTransport(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000,
  });
}

export async function sendMail({ to, subject, html, text, appName }) {
  const cfg = await getSmtpConfig();
  if (!cfg) throw new Error('Email (SMTP) is not configured');
  const name = cfg.fromName || appName || '';
  const from = name ? `"${name.replace(/"/g, '')}" <${cfg.fromEmail}>` : cfg.fromEmail;
  const info = await makeTransport(cfg).sendMail({ from, to, subject, html, text });
  return info;
}

/** Verifies host/port/login without sending anything. */
export async function verifySmtp() {
  const cfg = await getSmtpConfig();
  if (!cfg) throw new Error('Email (SMTP) is not configured');
  await makeTransport(cfg).verify();
  return true;
}
