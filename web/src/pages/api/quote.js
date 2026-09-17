import { getQuote } from '../../lib/api.js';

// Same-origin proxy for the live price quote (subtotal/VAT/coupon).
export const prerender = false;

export async function POST({ request }) {
  let payload = {};
  try { payload = await request.json(); } catch { payload = {}; }
  const { ok, status, data } = await getQuote(payload);
  return new Response(JSON.stringify(data || { detail: 'Could not price the selection.' }), {
    status: ok ? 200 : (status || 502),
    headers: { 'Content-Type': 'application/json' },
  });
}
