import { getAvailability } from '../../lib/api.js';

// Same-origin proxy so the booking island can fetch availability from the
// browser without CORS / exposing the backend URL. SSR runtime -> Django.
export const prerender = false;

export async function GET({ url }) {
  const club = url.searchParams.get('club');
  const date = url.searchParams.get('date') || undefined;
  const facilityType = url.searchParams.get('facility_type') || undefined;
  const body = club ? await getAvailability({ club, date, facilityType }) : null;
  return new Response(JSON.stringify(body || { closed: true, slots: [], weekdays: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
