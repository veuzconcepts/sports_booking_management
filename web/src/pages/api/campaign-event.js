import { recordCampaignEvent } from '../../lib/api.js';

// Same-origin proxy for the campaign counters, matching the availability proxy:
// the browser never needs the backend's address, and no CORS is involved.
export const prerender = false;

export async function POST({ request }) {
  let body = null;
  try { body = await request.json(); } catch { body = null; }
  if (!body || !body.id) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const result = await recordCampaignEvent({ id: body.id, event: body.event });
  return new Response(JSON.stringify(result.data || { ok: false }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
