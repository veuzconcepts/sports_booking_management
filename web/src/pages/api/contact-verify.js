import { verifyContact } from '../../lib/api.js';

// Same-origin proxy: verify the OTP for an existing contact and return the
// record's details to prefill the booking form. SSR runtime → Django public endpoint.
export const prerender = false;

export async function POST({ request }) {
  let payload = {};
  try { payload = await request.json(); } catch { payload = {}; }
  const { ok, status, data } = await verifyContact(payload);
  return new Response(JSON.stringify(data || { ok: false, detail: 'Could not reach the verification service.' }), {
    status: ok ? 200 : (status || 502),
    headers: { 'Content-Type': 'application/json' },
  });
}
