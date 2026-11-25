import { NextResponse } from 'next/server';
import { getSession } from '../auth/session.js';
import { getUserById, hasActiveAccess } from '../database/users.js';

/**
 * SK SYSTEM — access helpers.
 *
 * - requireSkReadAccess: any signed-in user with active trial/plan (or admin).
 *   Used for listing setups so the public Scanner can show SK results to everyone.
 * - requireSkAccess: ADMIN ONLY. Used for scan / setup / candles / admin actions.
 *   Config + Scan button live only on the admin account.
 *
 * @returns {{session, isAdmin}|{error: Response}}
 */
export async function requireSkReadAccess() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const isAdmin = session.role === 'admin';
  if (!isAdmin) {
    const user = await getUserById(session.userId);
    if (!user || !hasActiveAccess(user)) {
      return { error: NextResponse.json({ error: 'Active trial or paid plan required' }, { status: 403 }) };
    }
  }
  return { session, isAdmin };
}

/** Admin-only (scan, start run, strategy detail). */
export async function requireSkAccess() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.role !== 'admin') {
    return { error: NextResponse.json({ error: 'SK System scan/settings are admin only' }, { status: 403 }) };
  }
  return { session, isAdmin: true };
}
