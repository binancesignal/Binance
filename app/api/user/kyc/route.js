import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getUserById, updateUser, sanitizeUser } from '../../../../lib/database/users.js';
import { countryName } from '../../../../lib/kyc/countries.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function requireUser() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const user = await getUserById(session.userId);
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  return { session, user };
}

/** Public-safe KYC payload (still includes images for user's own review) */
function publicKyc(user) {
  const data = user.kyc_data && typeof user.kyc_data === 'object' ? user.kyc_data : {};
  return {
    status: user.kyc_status || 'none',
    country: user.country || null,
    countryCode: user.country_code || null,
    submittedAt: user.kyc_submitted_at || null,
    reviewedAt: user.kyc_reviewed_at || null,
    reviewNote: user.kyc_review_note || null,
    data: {
      docType: data.docType || null,
      firstName: data.firstName || '',
      lastName: data.lastName || '',
      docNumber: data.docNumber || '',
      dob: data.dob || '',
      nationality: data.nationality || '',
      docFront: data.docFront || null,
      docBack: data.docBack || null,
      selfie: data.selfie || null,
      updatedAt: data.updatedAt || null,
    },
  };
}

/** GET — current KYC status + draft data */
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;
  return NextResponse.json({ ok: true, kyc: publicKyc(user), user: sanitizeUser(user) });
}

/**
 * PATCH / POST body:
 *  { action: 'set_country', countryCode, country? }
 *  { action: 'save_draft', data: { docType, firstName, ... images } }
 *  { action: 'submit' }  — lock & send to admin (requires photos + names)
 */
export async function POST(req) {
  const { user, error } = await requireUser();
  if (error) return error;
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'save_draft';

    if (user.kyc_status === 'approved') {
      return NextResponse.json({ error: 'KYC already approved' }, { status: 400 });
    }
    if (user.kyc_status === 'pending' && action !== 'set_country') {
      // allow country change only before submit; after pending, no edits
      if (action !== 'get') {
        return NextResponse.json({ error: 'KYC is pending review — wait for admin' }, { status: 400 });
      }
    }

    if (action === 'set_country') {
      const code = String(body.countryCode || '').toUpperCase().slice(0, 8);
      if (!code) return NextResponse.json({ error: 'countryCode required' }, { status: 400 });
      const name = body.country || countryName(code);
      const updated = await updateUser(user.id, {
        country_code: code,
        country: name,
        kyc_status: user.kyc_status === 'none' ? 'draft' : user.kyc_status,
      });
      return NextResponse.json({ ok: true, kyc: publicKyc(updated) });
    }

    if (action === 'save_draft') {
      if (user.kyc_status === 'pending') {
        return NextResponse.json({ error: 'Already submitted' }, { status: 400 });
      }
      const prev = user.kyc_data && typeof user.kyc_data === 'object' ? user.kyc_data : {};
      const incoming = body.data && typeof body.data === 'object' ? body.data : {};
      // Cap base64 sizes roughly (~4MB each encoded)
      const maxLen = 5_500_000;
      for (const key of ['docFront', 'docBack', 'selfie']) {
        if (incoming[key] && String(incoming[key]).length > maxLen) {
          return NextResponse.json({ error: `${key} image too large — retake with lower quality` }, { status: 400 });
        }
      }
      const next = {
        ...prev,
        ...incoming,
        updatedAt: new Date().toISOString(),
      };
      const updated = await updateUser(user.id, {
        kyc_data: next,
        kyc_status: 'draft',
      });
      return NextResponse.json({ ok: true, kyc: publicKyc(updated) });
    }

    if (action === 'submit') {
      const data = { ...(user.kyc_data || {}), ...(body.data || {}) };
      if (!user.country_code && !body.countryCode) {
        return NextResponse.json({ error: 'Select your country first' }, { status: 400 });
      }
      if (!data.docType) return NextResponse.json({ error: 'Select document type' }, { status: 400 });
      if (!data.docFront) return NextResponse.json({ error: 'Document photo required' }, { status: 400 });
      if (!data.selfie) return NextResponse.json({ error: 'Selfie with ID required' }, { status: 400 });
      if (!String(data.firstName || '').trim() || !String(data.lastName || '').trim()) {
        return NextResponse.json({ error: 'First and last name required' }, { status: 400 });
      }

      // Face match from client (face-api). Threshold can be tuned via env.
      const faceMatch = body.faceMatch || data.faceMatch || null;
      const liveness = body.liveness || data.liveness || null;
      const autoEnabled = process.env.KYC_FACE_AUTO_APPROVE !== '0';
      const minScore = Math.min(0.95, Math.max(0.25, Number(process.env.KYC_FACE_MIN_SCORE || 0.45)));
      const requireLive = process.env.KYC_REQUIRE_LIVENESS !== '0';
      const score = faceMatch && faceMatch.ok ? Number(faceMatch.score) : null;
      const liveOk =
        liveness &&
        liveness.ok === true &&
        (liveness.mode === 'free_yaw_ring'
          ? Number(liveness.coverage || 0) >= 0.75
          : Array.isArray(liveness.challenges) && liveness.challenges.length >= 3);
      const strongMatch =
        autoEnabled &&
        score != null &&
        Number.isFinite(score) &&
        score >= minScore &&
        (faceMatch.docFaces || 0) >= 1 &&
        (faceMatch.selfieFaces || 0) >= 1 &&
        (!requireLive || liveOk);

      const nowIso = new Date().toISOString();
      const kycPayload = {
        ...data,
        faceMatch: faceMatch
          ? {
              ok: !!faceMatch.ok,
              score: faceMatch.score ?? null,
              distance: faceMatch.distance ?? null,
              docFaces: faceMatch.docFaces ?? 0,
              selfieFaces: faceMatch.selfieFaces ?? 0,
              provider: faceMatch.provider || 'face-api',
              error: faceMatch.error || null,
              at: nowIso,
            }
          : null,
        liveness: liveness
          ? {
              ok: !!liveness.ok,
              challenges: Array.isArray(liveness.challenges) ? liveness.challenges : [],
              completedAt: liveness.completedAt || nowIso,
            }
          : null,
        updatedAt: nowIso,
      };

      const patch = {
        kyc_data: kycPayload,
        kyc_status: strongMatch ? 'approved' : 'pending',
        kyc_submitted_at: nowIso,
        kyc_review_note: strongMatch
          ? `Auto-approved: face ${Math.round((score || 0) * 100)}% + liveness OK`
          : null,
        kyc_reviewed_at: strongMatch ? nowIso : null,
        kyc_reviewed_by: strongMatch ? null : null,
      };
      if (body.countryCode) {
        patch.country_code = String(body.countryCode).toUpperCase();
        patch.country = body.country || countryName(patch.country_code);
      }
      const updated = await updateUser(user.id, patch);
      return NextResponse.json({
        ok: true,
        kyc: publicKyc(updated),
        autoApproved: !!strongMatch,
        faceScore: score,
        message: strongMatch ? 'Face verified — auto-approved' : 'Submitted for review',
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'KYC failed' }, { status: 500 });
  }
}
