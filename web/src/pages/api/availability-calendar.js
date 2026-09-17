import { getAvailabilityCalendar } from '../../lib/api.js';

// Same-origin proxy for the month-level date summary. Mirrors
// `availability.js`: the island never sees the backend URL, and the backend
// stays the only thing that decides whether a date can be booked.
export const prerender = false;

export async function GET({ url }) {
  const club = url.searchParams.get('club');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const facilityType = url.searchParams.get('facility_type') || undefined;
  const body = (club && from && to)
    ? await getAvailabilityCalendar({ club, from, to, facilityType })
    : null;
  // An empty days map means 'nothing known', which the calendar renders as a
  // load failure rather than as a month with no availability.
  return new Response(JSON.stringify(body || { days: {}, next_available: null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
