/**
 * Encryption helpers for API secrets at rest.
 * Uses AES-256-GCM with ENCRYPTION_KEY (32-byte hex or base64).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    // Dev fallback — NEVER use in production
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      throw new Error('ENCRYPTION_KEY is required in production');
    }
    return scryptSync('dev-only-insecure-key', 'salt', 32);
  }
  // Accept 64-char hex or base64
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 32) return buf;
  return scryptSync(raw, 'saas-salt', 32);
}

export function encryptSecret(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: iv:tag:ciphertext (base64)
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload) {
  if (!payload) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted payload');
  const [ivB64, tagB64, dataB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function maskSecret(s, visible = 4) {
  if (!s || s.length < visible + 2) return '••••••••';
  return s.slice(0, visible) + '••••••••' + s.slice(-2);
}
