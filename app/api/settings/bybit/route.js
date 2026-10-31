import { NextResponse } from 'next/server';
import { getState, setState } from '../../../../lib/database/appState.js';
import { getWalletBalance, getBaseUrl, isTestnetBase } from '../../../../lib/bybit/client.js';

export const dynamic = 'force-dynamic';

function mask(s) {
  if (!s || s.length < 8) return s ? '****' : '';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export async function GET() {
  try {
    const apiKey = (await getState('bybit_api_key', null)) || '';
    const hasSecret = !!(await getState('bybit_api_secret', null));
    const baseUrl = await getBaseUrl();
    const testnet = isTestnetBase(baseUrl);
    let balance = null;
    let balanceError = null;
    if (apiKey && hasSecret) {
      try {
        const secret = await getState('bybit_api_secret', null);
        balance = await getWalletBalance(apiKey, secret, 'UNIFIED');
      } catch (e) {
        try {
          const secret = await getState('bybit_api_secret', null);
          balance = await getWalletBalance(apiKey, secret, 'CONTRACT');
        } catch (e2) {
          balanceError = e2.message || e.message;
        }
      }
    }
    return NextResponse.json({
      ok: true,
      configured: !!(apiKey && hasSecret),
      apiKeyMasked: mask(apiKey),
      hasSecret,
      testnet,
      baseUrl,
      isTestnet: testnet,
      balance,
      balanceError,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * Bybit access is TESTNET-only. Network selection is deliberately unavailable.
 * Body: { apiKey, apiSecret } — save and verify TESTNET keys.
 * Body: { clear: true } — remove keys
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));

    if (body.clear === true) {
      await setState('bybit_api_key', '');
      await setState('bybit_api_secret', '');
      await setState('bybit_testnet', true);
      return NextResponse.json({
        ok: true,
        testnet: true,
        isTestnet: true,
        msg: 'Bybit TESTNET API keys cleared',
      });
    }

    const hasKeys = body.apiKey != null || body.apiSecret != null;
    if (!hasKeys && body.testnet !== undefined) {
      if (!body.testnet) {
        return NextResponse.json(
          { error: 'Bybit TESTNET only; MAINNET cannot be selected.' },
          { status: 400 }
        );
      }
      await setState('bybit_testnet', true);
      return NextResponse.json({
        ok: true,
        msg: 'Bybit TESTNET is enforced',
        testnet: true,
        baseUrl: await getBaseUrl(),
        isTestnet: true,
      });
    }

    if (body.testnet === false) {
      return NextResponse.json(
        { error: 'Bybit TESTNET only; MAINNET cannot be selected.' },
        { status: 400 }
      );
    }

    const apiKey = String(body.apiKey || '').trim();
    const apiSecret = String(body.apiSecret || '').trim();
    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: 'apiKey and apiSecret required' },
        { status: 400 }
      );
    }

    // Persist the enforced value before verifying; request or prior state cannot
    // redirect the balance check to production.
    await setState('bybit_testnet', true);

    // Verify by fetching balance on the selected network
    let balance = null;
    try {
      balance = await getWalletBalance(apiKey, apiSecret, 'UNIFIED');
    } catch (_) {
      balance = await getWalletBalance(apiKey, apiSecret, 'CONTRACT');
    }
    await setState('bybit_api_key', apiKey);
    await setState('bybit_api_secret', apiSecret);

    const baseUrl = await getBaseUrl();
    const testnet = isTestnetBase(baseUrl);

    return NextResponse.json({
      ok: true,
      msg: 'Bybit TESTNET API keys saved',
      apiKeyMasked: `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`,
      testnet,
      baseUrl,
      isTestnet: testnet,
      balance,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Bybit auth failed: ${e.message}` },
      { status: 400 }
    );
  }
}
