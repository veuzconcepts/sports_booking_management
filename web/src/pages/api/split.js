import {
  getPaymentConfig,
  getSplitManage,
  getSplitShare,
  paySplitShare,
  splitManageAction,
  payBooking,
} from '../../lib/api.js';

/**
 * Same-origin proxy for split payment and card payment.
 *
 * One route rather than six, because they share a single rule that is easy to
 * break by copy-and-paste: the request body may contain card details, so this
 * file must never log a body, never echo one back, and never write one to disk.
 * It forwards and returns the backend's answer, nothing else.
 *
 * Card data therefore exists in exactly three places: the customer's browser,
 * this request in flight, and the gateway module in Django. It is never stored.
 */
export const prerender = false;

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function GET({ url }) {
  const token = url.searchParams.get('token') || '';
  const scope = url.searchParams.get('scope') || 'share';
  if (scope === 'config') {
    const config = await getPaymentConfig(url.searchParams.get('club') || '');
    // A checkout that cannot reach the backend must fall back to cash, never to
    // a card form that would collect details nothing can charge.
    return json(config || {
      card_enabled: false, demo_mode: false, test_cards: [], cash_enabled: true,
    }, 200);
  }
  if (!token) return json({ detail: 'Missing payment link.' }, 400);
  const data = scope === 'manage'
    ? await getSplitManage(token)
    : await getSplitShare(token);
  if (!data) return json({ detail: 'This payment link is not valid.' }, 404);
  return json(data, 200);
}

export async function POST({ request, url }) {
  const payload = await readBody(request);
  const token = url.searchParams.get('token') || '';
  const scope = url.searchParams.get('scope') || 'share';

  let result;
  if (scope === 'booking') {
    result = await payBooking(payload);
  } else if (scope === 'manage') {
    if (!token) return json({ detail: 'Missing payment link.' }, 400);
    result = await splitManageAction(token, payload);
  } else {
    if (!token) return json({ detail: 'Missing payment link.' }, 400);
    result = await paySplitShare(token, payload);
  }

  const { ok, status, data } = result;
  return json(data || { detail: 'Could not reach the payment service.' },
    ok ? 200 : (status || 502));
}
