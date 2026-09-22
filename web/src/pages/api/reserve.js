import {
  createReservation,
  getReservation,
  releaseReservation,
} from '../../lib/api.js';

/**
 * Same-origin proxy for reservation holds.
 *
 * One route for all three operations, because they share the rule that makes
 * them safe: the token is a bearer secret, so it travels in the query string
 * or the body and is never logged, echoed into an error, or written anywhere.
 * This file forwards the backend's answer and nothing else.
 *
 * The browser is told a deadline but never decides one. Every answer here
 * carries the server's own clock alongside it, so a device whose time is wrong
 * cannot make a live reservation look dead or a dead one look live.
 */
export const prerender = false;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST({ request }) {
  let payload = {};
  try { payload = await request.json(); } catch { payload = {}; }
  const { ok, status, data } = await createReservation(payload);
  return json(
    data || { detail: 'Could not reach the booking service.' },
    ok ? 201 : (status || 502),
  );
}

export async function GET({ url }) {
  const token = url.searchParams.get('token') || '';
  if (!token) return json({ detail: 'Missing reservation.' }, 400);
  const data = await getReservation(token);
  // A reservation that cannot be found is gone as far as the checkout is
  // concerned, which is the same outcome as expired and is handled the same.
  if (!data) return json({ detail: 'This reservation is not valid.', code: 'invalid_hold' }, 404);
  return json(data, 200);
}

export async function DELETE({ url }) {
  const token = url.searchParams.get('token') || '';
  if (!token) return json({ detail: 'Missing reservation.' }, 400);
  const { ok, status, data } = await releaseReservation(token);
  return json(data || {}, ok ? 200 : (status || 502));
}
