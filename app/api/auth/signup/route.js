import { NextResponse } from 'next/server';
import { createUser, deleteUser } from '../../../../lib/database/users.js';
import { createSessionToken, setSessionCookie } from '../../../../lib/auth/session.js';
import { attachReferrer, ensureReferralCode } from '../../../../lib/database/payments.js';
import { isMailConfigured } from '../../../../lib/mail/mailer.js';
import { sendVerificationEmail } from '../../../../lib/auth/emailVerify.js';

export async function POST(req) {
  try {
    const body = await req.json();
    const { email, password, ref, referralCode, country, countryCode } = body || {};
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    // When SMTP is set up in Admin → Email, new accounts must verify their email first.
    const needsVerification = await isMailConfigured();

    const user = await createUser({
      email,
      password,
      role: 'user',
      country: country || null,
      country_code: countryCode || null,
      ...(needsVerification ? { email_verified: false } : {}),
    });
    try {
      await ensureReferralCode(user.id);
      const code = ref || referralCode;
      if (code) await attachReferrer(user.id, code);
    } catch (_) {
      /* non-fatal */
    }

    if (needsVerification) {
      try {
        await sendVerificationEmail(user, req);
      } catch (mailErr) {
        // Don't leave an account the person can never verify.
        try { await deleteUser(user.id); } catch (_) {}
        return NextResponse.json(
          { error: 'We could not send the verification email. Please check the address and try again.' },
          { status: 502 }
        );
      }
      return NextResponse.json({ ok: true, needsVerification: true, email: user.email });
    }

    const token = await createSessionToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      plan: user.plan,
    });
    await setSessionCookie(token);

    return NextResponse.json({
      ok: true,
      needsVerification: false,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        plan: user.plan,
        trial_ends_at: user.trial_ends_at,
        subscription_status: user.subscription_status,
        country: user.country,
        country_code: user.country_code,
      },
      message: 'Account created. Your 7-day free trial has started.',
    });
  } catch (e) {
    const msg = e.message || 'Signup failed';
    const status = msg.includes('already') ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
