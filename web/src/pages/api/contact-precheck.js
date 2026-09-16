import { precheckContact } from '../../lib/api.js';

// Same-origin proxy: lets the wizard ask whether the entered unique contact needs
// OTP verification, so it can start verification on 'Book' before the rest of the
// form is filled. SSR runtime → Django public endpoint.
export const prerender = false;

export async function POST({ request }) {
  let payload = {};
  try { payload = await request.json(); } catch { payload = {}; }
  const { ok, status, data } = await precheckContact(payload);
  return new Response(JSON.stringify(data || { requires_otp: false }), {
    status: ok ? 200 : (status || 502),
    headers: { 'Content-Type': 'application/json' },
  });
}
