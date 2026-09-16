import { getBookingConfig } from '../../lib/api.js';

// Same-origin proxy: the booking island reads the website contact rules
// (email/phone required + unique) so it can mark required fields + run the
// duplicate-reuse flow. SSR runtime → Django public endpoint.
export const prerender = false;

export async function GET() {
  const data = await getBookingConfig();
  return new Response(
    JSON.stringify(data || { email_required: true, phone_required: true, email_unique: false, phone_unique: false }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
