import { createOrder } from '../../lib/api.js';

// Same-origin proxy for a multi-slot checkout. Mirrors `book.js`: the island
// never sees the backend URL, and the backend stays the only thing that
// decides whether the selection is allowed.
export const prerender = false;

export async function POST({ request }) {
  let payload = {};
  try { payload = await request.json(); } catch { payload = {}; }
  const { ok, status, data } = await createOrder(payload);
  return new Response(JSON.stringify(data || { detail: 'Could not reach the booking service.' }), {
    status: ok ? 201 : (status || 502),
    headers: { 'Content-Type': 'application/json' },
  });
}
