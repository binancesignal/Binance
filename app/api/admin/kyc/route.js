import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { listUsers, getUserById, updateUser, writeAudit, sanitizeUser } from '../../../../lib/database/users.js';

export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}

/** GET ?status=pending|approved|rejected|all */
export async function GET(req) {
  const { error } = await requireAdmin();
  if (error) return error;
  const status = new URL(req.url).searchParams.get('status') || 'pending';
  const users = await listUsers({ limit: 200 });
  let list = users.filter((u) => u.kyc_status && u.kyc_status !== 'none' && u.kyc_status !== 'draft');
  if (status !== 'all') list = list.filter((u) => u.kyc_status === status);
  // pending first
  list.sort((a, b) => {
    if (a.kyc_status === 'pending' && b.kyc_status !== 'pending') return -1;
    if (b.kyc_status === 'pending' && a.kyc_status !== 'pending') return 1;
    return String(b.kyc_submitted_at || '').localeCompare(String(a.kyc_submitted_at || ''));
  });
  return NextResponse.json({
    ok: true,
    items: list.map((u) => ({
      id: u.id,
      email: u.email,
      country: u.country,
      countryCode: u.country_code,
      kycStatus: u.kyc_status,
      submittedAt: u.kyc_submitted_at,
      reviewedAt: u.kyc_reviewed_at,
      reviewNote: u.kyc_review_note,
      data: u.kyc_data || {},
    })),
  });
}

/** POST { userId, action: 'approve'|'reject', note? } */
export async function POST(req) {
  const { session, error } = await requireAdmin();
  if (error) return error;
  try {
    const body = await req.json().catch(() => ({}));
    const { userId, action, note } = body;
    if (!userId || !['approve', 'reject'].includes(action)) {
      return NextResponse.json({ error: 'userId and action (approve|reject) required' }, { status: 400 });
    }
    const target = await getUserById(userId);
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (target.kyc_status !== 'pending' && target.kyc_status !== 'rejected' && target.kyc_status !== 'approved') {
      return NextResponse.json({ error: 'No KYC submission to review' }, { status: 400 });
    }
    const nextStatus = action === 'approve' ? 'approved' : 'rejected';
    const updated = await updateUser(userId, {
      kyc_status: nextStatus,
      kyc_reviewed_at: new Date().toISOString(),
      kyc_reviewed_by: session.userId,
      kyc_review_note: note ? String(note).slice(0, 500) : null,
    });
    await writeAudit(session.userId, `kyc_${action}`, { userId, email: target.email, note: note || null });
    return NextResponse.json({ ok: true, user: sanitizeUser(updated) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
