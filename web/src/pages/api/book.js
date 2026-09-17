import { createBooking } from '../../lib/api.js';

// Same-origin proxy so the booking island can submit without CORS / exposing
// the backend URL. SSR runtime → Django public booking endpoint.
export const prerender = false;

export async function POST({ request }) {
  let payload = {};
  try { payload = await request.json(); } catch { payload = {}; }
  const { ok, status, data } = await createBooking(payload);
  return new Response(JSON.stringify(data || { detail: 'Could not reach the booking service.' }), {
    status: ok ? 201 : (status || 502),
    headers: { 'Content-Type': 'application/json' },
  });
}
