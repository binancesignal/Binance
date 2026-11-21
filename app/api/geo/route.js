import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** GET /api/geo — detect country from request IP (best-effort). */
export async function GET(request) {
  try {
    const fwd = request.headers.get('x-forwarded-for') || '';
    const real = request.headers.get('x-real-ip') || '';
    let ip = (fwd.split(',')[0] || real || '').trim();
    if (!ip || ip === '::1' || ip.startsWith('127.') || ip === 'localhost') {
      // local / unknown — no auto country
      return NextResponse.json({ ok: true, country: null, countryCode: null, ip: ip || null, source: 'local' });
    }

    // Prefer Cloudflare / Vercel geo headers when present
    const cf = request.headers.get('cf-ipcountry');
    const vercel = request.headers.get('x-vercel-ip-country');
    const headerCode = (cf || vercel || '').toUpperCase();
    if (headerCode && headerCode !== 'XX' && headerCode.length === 2) {
      return NextResponse.json({
        ok: true,
        countryCode: headerCode,
        country: null,
        ip,
        source: cf ? 'cloudflare' : 'vercel',
      });
    }

    // Fallback: free IP API (timeout-safe)
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3500);
    try {
      const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        if (data?.country_code) {
          return NextResponse.json({
            ok: true,
            countryCode: String(data.country_code).toUpperCase(),
            country: data.country_name || null,
            ip,
            source: 'ipapi',
          });
        }
      }
    } catch (_) {
      clearTimeout(t);
    }

    return NextResponse.json({ ok: true, country: null, countryCode: null, ip, source: 'none' });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message, countryCode: null }, { status: 200 });
  }
}
