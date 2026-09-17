// Server-side data access for the public marketing site. All fetches are made
// from the SSR runtime against the Django public API; failures degrade
// gracefully (return null/empty) so a backend hiccup never 500s the page.

const API_BASE = import.meta.env.API_BASE_URL || process.env.API_BASE_URL
  || 'http://127.0.0.1:8000/api/v1';

async function getJSON(path) {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** CMS presentation content (sections, banners, testimonials, FAQ, footer, SEO…). */
export const getHome = () => getJSON('/website/public/home/');

/** Org branding: logo variants (per theme + layout), favicon, default OG image,
 *  and SEO fallback title/description. Used by the header, footer and <head>. */
export const getBranding = () => getJSON('/website/public/branding/');

/** Live catalogue from Operations (categories, facility types, membership plans). */
export const getCatalogue = () => getJSON('/website/public/catalogue/');

/** Active clubs / venues for the booking location step. */
export const getClubs = () => getJSON('/website/public/clubs/');

/** Booking availability for a club + date, for ONE facility type.
 *  The type matters: capacity is the units that can host it, and each slot is
 *  tested against that type's full duration. */
export const getAvailability = ({ club, date, facilityType }) => {
  const qs = new URLSearchParams({ club: String(club) });
  if (date) qs.set('date', date);
  if (facilityType) qs.set('facility_type', String(facilityType));
  return getJSON(`/website/public/availability/?${qs.toString()}`);
};

/** Which DATES can be booked over a range, so the calendar can grey out a day
 *  before the customer clicks it. The backend answers with the same engine
 *  the booking itself uses; this is only a UX optimisation. */
export const getAvailabilityCalendar = ({ club, from, to, facilityType }) => {
  const qs = new URLSearchParams({ club: String(club), from, to });
  if (facilityType) qs.set('facility_type', String(facilityType));
  return getJSON(`/website/public/availability/calendar/?${qs.toString()}`);
};

/** POST JSON to the public API; returns { ok, status, data }. */
async function postJSON(path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** Create a booking in Operations from the public site. */
export const createBooking = (payload) => postJSON('/website/public/bookings/', payload);

/** Create a MULTI-SLOT booking: one order, one booking per slot. */
export const createOrder = (payload) => postJSON('/website/public/orders/', payload);

/** Website booking contact rules (email/phone required + unique). */
export const getBookingConfig = () => getJSON('/website/public/booking-config/');

/** Whether the entered unique contact needs OTP verification (no PII returned). */
export const precheckContact = (payload) => postJSON('/website/public/contact-precheck/', payload);

/** Verify the OTP for an existing contact; returns a signed token + record to prefill. */
export const verifyContact = (payload) => postJSON('/website/public/contact-verify/', payload);

/** Live price quote (subtotal, VAT, coupon) for the Confirm & Pay step. */
export const getQuote = (payload) => postJSON('/website/public/quote/', payload);

/**
 * Campaigns this visitor may be shown on a page.
 *
 * Eligibility is settled by the backend: publication, the configured window in
 * the organization's timezone, placement, scope and audience. The site only
 * decides how often to show what it is given.
 */
export const getCampaigns = ({ placement = 'home', club, signedIn = false } = {}) => {
  const qs = new URLSearchParams({ placement });
  if (club) qs.set('club', String(club));
  if (signedIn) qs.set('signed_in', 'true');
  return getJSON(`/website/public/campaigns/?${qs.toString()}`);
};

/** Count an impression, dismissal or CTA click. Anonymous, and never awaited. */
export const recordCampaignEvent = (payload) =>
  postJSON('/website/public/campaign-event/', payload);

/**
 * What payment methods the checkout may offer.
 *
 * The backend decides: it knows whether a provider is configured and whether
 * the demo adapter is genuinely active, and it only ever sends test card
 * numbers while it is. The site must never assume card payment works.
 */
export const getPaymentConfig = () => getJSON('/website/public/payment-config/');

/** The minimal booking summary and assigned amount behind one share link. */
export const getSplitShare = (token) =>
  getJSON(`/website/public/split/${encodeURIComponent(token)}/`);

/**
 * Pay one share. The amount is NOT sent: the backend decides what this link
 * owes, so nothing the browser reports can change what is charged.
 */
export const paySplitShare = (token, body) =>
  postJSON(`/website/public/split/${encodeURIComponent(token)}/`, body);

/** Payment progress for the organizer's own management link. */
export const getSplitManage = (token) =>
  getJSON(`/website/public/split/manage/${encodeURIComponent(token)}/`);

/** An organizer action on their own split (pay remaining, cancel a share, ...). */
export const splitManageAction = (token, body) =>
  postJSON(`/website/public/split/manage/${encodeURIComponent(token)}/`, body);

/** Settle a booking from the confirmation screen, or retry a declined card. */
export const payBooking = (payload) => postJSON('/website/public/booking-pay/', payload);

/** Format a money amount with the catalogue currency code. */
export function money(amount, currency) {
  if (amount === null || amount === undefined) return '';
  const n = Number(amount);
  const value = Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : amount;
  return currency ? `${currency} ${value}` : `${value}`;
}
