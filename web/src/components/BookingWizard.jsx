import { useEffect, useMemo, useRef, useState } from 'react';
import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js/max';
import { useTranslation } from 'react-i18next';

import { I18n } from '../i18n/client.jsx';
import { intlLocale, weekdayStyle } from '../i18n/index.js';
import PhoneField from './PhoneField.jsx';
import { phoneCountryFor } from '../utils/countries.js';
import { formatCountdown, useReservation } from '../lib/useReservation.js';
import {
  CardForm,
  CheckIcon,
  ClockIcon,
  LockIcon,
  PaymentMethods,
  SplitIcon,
  SplitPanel,
  SplitToggle,
  blankCard,
  blankSplit,
  cardRequest,
  copyLink,
  formatMoney,
  paymentTiles,
  previewEqualSplit,
  shareLink,
  shareTone,
  splitRequest,
  useCountdown,
} from './CheckoutPayment.jsx';

// A "Mobile number" must be a real mobile for its country - reject landlines
// (e.g. UAE +971 9… Fujairah fixed-line) and other non-mobile line types.
const NON_MOBILE_TYPES = new Set(['FIXED_LINE', 'PREMIUM_RATE', 'TOLL_FREE', 'VOIP', 'PAGER', 'UAN', 'SHARED_COST']);
function isValidMobile(value) {
  const v = (value || '').trim();
  if (!v) return false;
  try {
    if (!isValidPhoneNumber(v)) return false;
    return !NON_MOBILE_TYPES.has(parsePhoneNumber(v).getType());
  } catch { return false; }
}

/**
 * Public booking wizard: Category -> Facility -> Club -> Schedule -> Confirm.
 * Data (categories, facility types, clubs) is passed from the SSR page;
 * everything else is client-side with full back/forth navigation.
 */
// Club first: where you play narrows everything after it, and it is the
// question a customer can always answer. Add-ons are their own step rather than
// a modal, so they can be revisited from the timeline like any other choice.
/** A multi-slot selection in a URL: `2026-09-17T21:00~21:45,2026-09-18T09:00~09:45`.
 *  Compact enough to stay readable, and strictly validated on the way back in
 *  because a URL is user input like any other. */
const SLOT_PARAM = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})~(\d{2}:\d{2})$/;

export function formatSlotsParam(slots) {
  return slots.map((s) => `${s.date}T${s.time}~${s.end}`).join(',');
}

/**
 * Why a date cannot be booked, in words a customer can use.
 *
 * The club's own name for the date wins whenever it gave one: "National Day"
 * tells somebody more than "Closed" ever will, and it is the thing they would
 * have been told had they rung up to ask.
 *
 * Reasons a customer can already see for themselves, a date in the past or one
 * beyond the booking window, deliberately return nothing. Explaining those
 * would put a mark and a keyboard stop on most of the month for no gain.
 */
export function reasonText(state, t) {
  if (state?.label) return state.label;
  switch (state?.reason) {
    case 'holiday': return t('wizard.when.holiday');
    case 'closed': return t('wizard.when.closed');
    case 'fully_booked': return t('wizard.when.fullyBooked');
    case 'rules': return t('wizard.when.notEnoughSlots');
    default: return '';
  }
}

/** A real calendar date, not merely four digits, a dash and two more. */
function isRealDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1
    && probe.getUTCDate() === d;
}

const isRealTime = (hhmm) => {
  const [h, min] = hhmm.split(':').map(Number);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
};

export function parseSlotsParam(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw || '').split(',')) {
    const m = SLOT_PARAM.exec(part.trim());
    // The shape is not enough: `2026-13-99T99:99` matches every `\d{2}` in the
    // pattern. A URL is user input, so anything that is not a real date and a
    // real clock time is dropped rather than carried into a booking request.
    if (!m || !isRealDate(m[1]) || !isRealTime(m[2]) || !isRealTime(m[3])) continue;
    const key = `${m[1]}T${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: m[1], time: m[2], end: m[3] });
  }
  return out.sort((a, b) => (a.date === b.date
    ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)));
}

const STEP_KEYS = ['club', 'facility', 'addons', 'when', 'pay'];
const STEP_CLUB = 0, STEP_FACILITY = 1, STEP_ADDONS = 2, STEP_WHEN = 3, STEP_PAY = 4;
const BLANK_DETAILS = { name: '', phone: '', email: '', notes: '' };

function fmt(amount) {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = Number(amount);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : amount;
}
// Renders the amount with the currency symbol; AED uses the UAE Dirham glyph font.
function Price({ amount, currency }) {
  const v = fmt(amount);
  if (v === null) return null;
  const sym = currency === 'AED' ? <span className="aed-symbol">AED</span> : <>{currency}</>;
  return <bdi>{sym} {v}</bdi>;
}
// Distance between the visitor and a club (km), for "nearest" sorting.
function haversine(a, b) {
  if (!a || b.latitude == null || b.longitude == null) return null;
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.lat), dLng = toRad(b.longitude - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function duration(mins, t) {
  if (!mins) return '';
  if (mins < 60) return t('common.minutes', { count: mins });
  const h = Math.round((mins / 60) * 10) / 10;
  return t('common.hours', { count: h });
}

const Bolt = (p) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" {...p}><path d="M13 2L3 14h6l-1 8 10-12h-6l1-8z"/></svg>
);
const Arrow = (p) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M7 17L17 7M9 7h8v8"/></svg>
);
const Pin = (p) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
);
const Droplet = (p) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 2.7S5 10 5 14a7 7 0 0 0 14 0c0-4-7-11.3-7-11.3z"/></svg>
);
const Clock = (p) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
);
const Wrench = (p) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.3L3 18l3 3 6.4-6.3a4 4 0 0 0 5.3-5.4l-2.6 2.6-2.7-2.7 2.3-2.9z"/></svg>
);
const Check = (p) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 6L9 17l-5-5"/></svg>
);
const Sparkle = (p) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" {...p}><path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6L12 2zM19 14l.8 2.7L22.5 17l-2.7.8L19 20l-.8-2.2L15.5 17l2.7-.3L19 14z"/></svg>
);
const ArrowRight = (p) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12h13M12 6l6 6-6 6"/></svg>
);
const Close = (p) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 6l12 12M18 6L6 18"/></svg>
);
const Sun = (p) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
);
const CashIcon = (p) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="2" y="6" width="20" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.4"/><path d="M5.5 12h.01M18.5 12h.01"/></svg>
);
const TagIcon = (p) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1"/></svg>
);
const AppleGlyph = (p) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" {...p}><path d="M16.4 12.9c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.7-1.3-.1-2.6.8-3.3.8-.7 0-1.7-.8-2.8-.7-1.4 0-2.7.8-3.5 2.1-1.5 2.6-.4 6.4 1.1 8.5.7 1 1.5 2.2 2.6 2.1 1-.04 1.4-.7 2.7-.7 1.2 0 1.6.7 2.7.6 1.1-.02 1.8-1 2.5-2 .5-.7.7-1.2.9-1.7-.02-.01-1.8-.7-1.8-2.8zM14.3 6.2c.6-.7 1-1.7.9-2.7-.9.04-1.9.6-2.5 1.3-.5.5-1 1.5-.9 2.5 1 .08 1.9-.5 2.5-1.1z"/></svg>
);
const PlayGlyph = (p) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" {...p}><path d="M4 3.2c-.3.2-.5.5-.5 1v15.6c0 .5.2.8.5 1l8.6-8.8L4 3.2zm10 8.8 2.6-2.7-9.3-5.3 6.7 8zm0 0-6.7 8 9.3-5.3L14 12zm1.4-1.4 2.8-1.6c.6-.4.6-1.2 0-1.6l-2.4-1.4-2.7 2.8 2.3 1.8z"/></svg>
);
// Time / date helpers (client-side island; native Date is fine here).
function fmtTime(hhmm, is24) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (is24) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}
const WK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Reject obviously fake / disposable emails (the backend re-checks too).
const JUNK_EMAIL_DOMAINS = new Set([
  'test.com', 'test.test', 'example.com', 'example.org', 'example.net', 'domain.com',
  'mailinator.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com', 'guerrillamail.com',
  'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com',
  'maildrop.cc', 'fakeinbox.com', 'throwawaymail.com', 'mailnesia.com', 'tempmail.net', 'mintemail.com',
]);
function emailLooksReal(raw) {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return true;                                   // optional field
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v)) return false;
  const domain = v.split('@')[1];
  if (JUNK_EMAIL_DOMAINS.has(domain) || /^(test|example|sample|demo)\./.test(domain)) return false;
  return true;
}

// Placeholder logo shown when a category/facility type has no image. Set from the
// `placeholderLogo` prop (the org's uploaded logo) on each render; falls back to
// the bundled static file.
let PLACEHOLDER_LOGO = '/logo.svg';

export default function BookingWizard({ locale, ...props }) {
  return <I18n locale={locale}><Wizard {...props} /></I18n>;
}

function Wizard({ categories = [], facilityTypes = [], clubs = [], currency = '', city = '', country = '', placeholderLogo = '' }) {
  const { t } = useTranslation();
  PLACEHOLDER_LOGO = placeholderLogo || '/logo.svg';
  const [step, setStep] = useState(0);
  const [category, setCategory] = useState(null);
  const [facilityType, setFacilityType] = useState(null);
  const [club, setClub] = useState(null);
  // The chosen times. An array even when the club allows only one, so every
  // screen below reads the same shape; `slot` stays as the first of them for
  // the parts of the flow that are genuinely about a single time.
  const [slots, setSlots] = useState([]);      // [{ date, time, end }]
  const [addons, setAddons] = useState([]);    // selected add-on ids
  const [query, setQuery] = useState('');
  const [restored, setRestored] = useState(false);
  // A date carried in from the homepage quick search. It only decides which day
  // the calendar opens on; the Date & Time step itself is unchanged.
  const [startDate, setStartDate] = useState(null);
  // Confirm & Pay state lives here so it survives stepping back and forth.
  const [details, setDetails] = useState({ ...BLANK_DETAILS });
  const [pay, setPay] = useState({ method: 'card', coupon: '', applied: null, card: blankCard(), split: blankSplit() });
  const [bookingDone, setBookingDone] = useState(null);
  const slot = slots[0] || null;

  // Start a brand-new booking after a confirmed one.
  const reset = () => {
    setCategory(null); setFacilityType(null); setClub(null); setSlots([]); setAddons([]);
    setDetails({ ...BLANK_DETAILS }); setPay({ method: 'card', coupon: '', applied: null, card: blankCard(), split: blankSplit() });
    setBookingDone(null); setQuery(''); go(0);
  };

  // Only what the CHOSEN club offers. The catalogue is organization-wide, so
  // without this a club with three courts offered a swimming lane it does not
  // have, and the customer reached the calendar to find every slot
  // unavailable. A club that has configured nothing offers nothing, and says
  // so, rather than quietly listing the whole catalogue.
  const clubFacilityTypes = useMemo(() => {
    const allowed = club?.facility_types;
    if (!allowed) return facilityTypes;
    const ids = new Set(allowed.map((entry) => entry.id));
    return facilityTypes.filter((s) => ids.has(s.id));
  }, [club, facilityTypes]);

  // A category with nothing behind it at this club would filter to an empty
  // list, so it is not offered.
  const clubCategories = useMemo(() => {
    const ids = new Set(
      clubFacilityTypes.flatMap((s) => s.category_ids || []));
    return categories.filter((c) => ids.has(c.id));
  }, [categories, clubFacilityTypes]);

  const catFacilityTypes = useMemo(
    () => (category
      ? clubFacilityTypes.filter((s) => (s.category_ids || []).includes(category.id))
      : []),
    [category, clubFacilityTypes],
  );

  const filteredClubes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clubs;
    return clubs.filter((b) =>
      [b.name, b.address, b.city].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [query, clubs]);

  // Restore the wizard from the URL on load, so a refresh keeps your place
  // (category -> facility type -> club -> schedule -> details).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const cat = categories.find((c) => c.id === Number(sp.get('category')));
    const svc = facilityTypes.find((s) => s.id === Number(sp.get('facilityType')));
    const br = clubs.find((b) => b.id === Number(sp.get('club')));
    if (cat) setCategory(cat);
    if (svc) setFacilityType(svc);
    if (br) setClub(br);
    const aIds = (sp.get('a') || '').split(',').map(Number).filter(Boolean);
    if (aIds.length && svc) setAddons(aIds.filter((id) => (svc.add_ons || []).some((a) => a.id === id)));
    const sd = sp.get('d'), st = sp.get('t'), se = sp.get('e');
    let restoredSlot = null;
    // `s` carries a whole multi-slot selection; `d`/`t`/`e` remain for a single
    // time so older links, and links people have already shared, still open.
    const restoredSlots = parseSlotsParam(sp.get('s'));
    if (restoredSlots.length) {
      restoredSlot = restoredSlots[0];
      setSlots(restoredSlots);
    } else if (sd && st && se) {
      restoredSlot = { date: sd, time: st, end: se };
      setSlots([restoredSlot]);
    }
    // A bare `d` is a requested day, not a booked slot: open the calendar there.
    else if (/^\d{4}-\d{2}-\d{2}$/.test(sd || '')) setStartDate(sd);
    // Clamp the requested step to what the restored selections actually unlock,
    // in the order the wizard now runs: club, facility, add-ons, time, payment.
    let maxReach = 0;
    if (br) maxReach = 1;
    if (br && svc) maxReach = 3;
    if (br && svc && restoredSlot) maxReach = 4;
    setStep(Math.min(Number(sp.get('step')) || 0, maxReach));
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once a booking is confirmed, drop the wizard URL params so a refresh starts
  // a fresh booking (no re-entering / re-submitting the completed one).
  useEffect(() => {
    if (bookingDone) window.history.replaceState({}, '', window.location.pathname);
  }, [bookingDone]);

  // Reflect the current step + selections in the URL (replace, so refresh restores it).
  useEffect(() => {
    if (!restored || bookingDone) return;       // terminal once confirmed
    const params = new URLSearchParams();
    if (club && step >= STEP_FACILITY) params.set('club', String(club.id));
    if (category && step >= STEP_FACILITY) params.set('category', String(category.id));
    if (facilityType && step >= STEP_ADDONS) params.set('facilityType', String(facilityType.id));
    if (addons.length && step >= STEP_WHEN) params.set('a', addons.join(','));
    if (slot && step >= STEP_PAY) {
      params.set('d', slot.date); params.set('t', slot.time); params.set('e', slot.end);
      // Without this a refresh on the payment step would silently drop every
      // time after the first, and the customer would pay for one slot.
      if (slots.length > 1) params.set('s', formatSlotsParam(slots));
    }
    if (step > 0) params.set('step', String(step));
    const qs = params.toString();
    window.history.replaceState({}, '', qs ? `?${qs}` : window.location.pathname);
  }, [step, category, facilityType, addons, club, slots, slot, restored, bookingDone]);

  const go = (n) => setStep(Math.max(0, Math.min(STEP_KEYS.length - 1, n)));

  // The courts are claimed while the checkout is open and given back the
  // moment it is left, so somebody who returns to the calendar does not leave
  // an evening slot locked behind a timer nobody is watching. A completed
  // booking has already converted its reservation, so the hold is dropped
  // rather than released.
  const reservation = useReservation({
    club, facilityType, slots,
    active: step === STEP_PAY && !bookingDone,
  });

  // A facility with no optional extras has nothing to show on the add-ons step,
  // so that step is passed over in both directions rather than shown empty.
  const hasAddons = Boolean(facilityType?.add_ons?.length);

  // Category is a filter on the facility step now, not a step of its own.
  const pickCategory = (c) => {
    setCategory(c); setFacilityType(null); setSlots([]); setAddons([]);
  };
  const pickFacilityType = (s) => {
    setFacilityType(s); setSlots([]); setAddons([]); setBookingDone(null);
    go(s.add_ons?.length ? STEP_ADDONS : STEP_WHEN);
  };
  const confirmAddons = (ids) => { setAddons(ids); go(STEP_WHEN); };
  // Choosing a club auto-advances to the facility list.
  const pickClub = (b) => { setClub(b); setSlots([]); go(STEP_FACILITY); };

  const back = () => go(step === STEP_WHEN && !hasAddons ? STEP_FACILITY : step - 1);

  // Which timeline steps the user may jump to (only ones already unlocked).
  const reachable = (i) => i === STEP_CLUB
    || (i === STEP_FACILITY && !!club)
    || (i === STEP_ADDONS && !!facilityType && hasAddons)
    || (i === STEP_WHEN && !!facilityType)
    || (i === STEP_PAY && slots.length > 0);
  const jump = (i) => { if (reachable(i)) go(i); };

  const TITLES = {
    [STEP_FACILITY]: [t('wizard.facility.title'), t('wizard.facility.subtitle')],
    [STEP_ADDONS]: [t('wizard.addons.title'), t('wizard.addons.subtitle')],
    [STEP_WHEN]: [t('wizard.when.title'), t('wizard.when.subtitle')],
    [STEP_PAY]: [t('checkout.title'), t('checkout.subtitle')],
  };

  return (
    <div className="bw">
      {step > 0 && !bookingDone && (
        <div className="bw__head">
          <button className="bw__back" type="button" onClick={back} aria-label={t('common.back')}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div className="bw__titles">
            <h1>{TITLES[step]?.[0]}</h1>
            <p>{TITLES[step]?.[1]}</p>
          </div>
          <Progress step={step} reachable={reachable} onJump={jump} />
        </div>
      )}

      <div className="bw__stage" key={step}>
        {step === STEP_CLUB && (
          <Location
            clubs={filteredClubes} query={query} setQuery={setQuery}
            club={club} onChoose={pickClub} city={country || city}
          />
        )}
        {step === STEP_FACILITY && (
          <FacilityBrowser
            categories={clubCategories} category={category} onCategory={pickCategory}
            list={category ? catFacilityTypes : clubFacilityTypes}
            currency={currency} onPick={pickFacilityType}
          />
        )}
        {step === STEP_ADDONS && (
          <AddOns facilityType={facilityType} currency={currency}
            selected={addons} onConfirm={confirmAddons} />
        )}
        {step === STEP_WHEN && (
          <Schedule
            facilityType={facilityType} category={category} club={club} currency={currency}
            initialDate={startDate}
            addons={addons}
            values={slots} onChange={setSlots} onContinue={() => go(STEP_PAY)}
          />
        )}
        {step === STEP_PAY && (
          <Details
            facilityType={facilityType} category={category} club={club}
            slot={slot} slots={slots} currency={currency}
            country={country}
            addons={addons}
            reservation={reservation}
            details={details} setDetails={setDetails} pay={pay} setPay={setPay}
            done={bookingDone} setDone={setBookingDone} onReset={reset}
            onEditBooking={() => go(STEP_WHEN)}
          />
        )}
      </div>
    </div>
  );
}

function Progress({ step, reachable, onJump }) {
  const { t } = useTranslation();
  return (
    <ol className="bw__steps"
      aria-label={t('wizard.stepOf', { current: step + 1, total: STEP_KEYS.length })}>
      {STEP_KEYS.map((key, i) => {
        const label = t(`wizard.steps.${key}`);
        const state = i < step ? 'done' : i === step ? 'active' : 'todo';
        const can = reachable(i) && i !== step;
        return (
          <li key={key} className={`bw__step bw__step--${state}`}>
            <button type="button" className="bw__step-btn" disabled={!can}
              onClick={() => onJump(i)} aria-label={label}>
              <span className="bw__step-dot">{i < step ? <Check /> : i + 1}</span>
              <span className="bw__step-label">{label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function FacilityMedia({ s }) {
  if (s.video) return <video src={s.video} muted loop autoPlay playsInline preload="metadata" />;
  if (s.image) return <img src={s.image} alt={s.name} loading="lazy" />;
  return <span className="bw__fac-ph"><img src={PLACEHOLDER_LOGO} alt={s.name} /></span>;
}

function FacilityCard({ s, currency, onPick, onMore }) {
  const { t } = useTranslation();
  return (
    <article className="bw__fac" role="button" tabIndex={0}
      onClick={() => onPick(s)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(s); } }}>
      <div className="bw__fac-main">
        <div className="bw__fac-img"><FacilityMedia s={s} /></div>
        <div className="bw__fac-body">
          <h3>{s.name}{s.tagline && <em> {s.tagline}</em>}</h3>
          <div className="bw__fac-tags">
            
            {s.badge_display && <span className="bw__tag bw__tag--badge"><Bolt /> {s.badge_display}</span>}
            
            {s.duration_minutes ? <span className="bw__tag"><Clock /> {duration(s.duration_minutes, t)}</span> : null}
          </div>
          <div className="bw__fac-price"><strong><Price amount={s.price} currency={currency} /></strong> <VatNote inclusive={s.tax_inclusive} /></div>
          {(s.description || s.whats_included) && (
            <div className="bw__fac-descrow">
              {s.description && <p className="bw__fac-desc">{s.description}</p>}
              {s.whats_included && (
                <button className="bw__fac-more" type="button"
                  onClick={(e) => { e.stopPropagation(); onMore(s); }}>
                  <Sparkle /> {t('wizard.facility.included')} <Arrow />
                </button>
              )}
            </div>
          )}
        </div>
        <span className="bw__fac-cta" aria-hidden="true"><ArrowRight /></span>
      </div>
    </article>
  );
}

// "Where it's performed" groups - At your location first, then center options;
// facility types with no club set are shown last, under a separator.
const PERFORMED_GROUPS = [
  { key: 'at_location', label: 'At your location', icon: Pin },
  { key: 'both', label: 'Center or your location', icon: Pin },

];

function FacilityTypes({ list, currency, onPick, emptyKey = 'wizard.facility.empty' }) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState(null);
  if (list.length === 0) {
    // "Nothing in this category" and "nothing at this club at all" are
    // different problems, and only one of them the customer can fix by
    // picking another category.
    return <p className="bw__empty">{t(emptyKey)}</p>;
  }
  const groups = PERFORMED_GROUPS
    .map((g) => ({ ...g, items: list.filter((s) => s.performed_at === g.key) }))
    .filter((g) => g.items.length);
  const known = new Set(PERFORMED_GROUPS.map((g) => g.key));
  const other = list.filter((s) => !known.has(s.performed_at));
  const card = (s) => (
    <FacilityCard key={s.id} s={s} currency={currency} onPick={onPick} onMore={setDetail} />
  );

  return (
    <div className="bw__facilities">
      {groups.map((g) => (
        <section key={g.key} className="bw__fac-group">
          <h3 className="bw__fac-grouph"><g.icon /> {g.label}</h3>
          <div className="bw__fac-list">{g.items.map(card)}</div>
        </section>
      ))}

      {other.length > 0 && (
        groups.length === 0
          ? <div className="bw__fac-list">{other.map(card)}</div>
          : (
            <section className="bw__fac-group">
              <div className="bw__fac-sep"><span>{t('wizard.facility.more')}</span></div>
              <div className="bw__fac-list">{other.map(card)}</div>
            </section>
          )
      )}

      {detail && (
        <FacilityModal facilityType={detail} currency={currency}
          onClose={() => setDetail(null)}
          onSelect={(s) => { setDetail(null); onPick(s); }} />
      )}
    </div>
  );
}

function FacilityModal({ facilityType: s, currency, onClose, onSelect }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  return (
    <div className="bw__modal" role="dialog" aria-modal="true" aria-label={s.name} onClick={onClose}>
      <div className="bw__modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="bw__modal-close" type="button" onClick={onClose} aria-label={t('common.close')}><Close /></button>
        <div className="bw__modal-media">
          <FacilityMedia s={s} />
          <div className="bw__modal-media-tag">
            <strong><Price amount={s.price} currency={currency} /></strong><VatNote inclusive={s.tax_inclusive} />
          </div>
        </div>
        <div className="bw__modal-right">
          <div className="bw__modal-scroll">
            <h3 className="bw__modal-title">{s.name}{s.tagline && <em> - {s.tagline}</em>}</h3>
            <div className="bw__modal-meta">
              {s.duration_minutes ? <span className="bw__time"><Clock /> {duration(s.duration_minutes, t)}</span> : null}
              {s.badge_display && <span className="bw__time"><Bolt /> {s.badge_display}</span>}
              
            </div>
            <h4 className="bw__modal-sub"><Sparkle /> {t('wizard.facility.included')}</h4>
            <div className="bw__rte" dangerouslySetInnerHTML={{ __html: s.whats_included }} />
            {s.whats_not_included && (
              <div className="bw__modal-excl">
                {s.whats_not_included.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => (
                  <p key={i}>{l}</p>
                ))}
              </div>
            )}
          </div>
          <div className="bw__modal-foot">
            <button className="bw__modal-close-btn" type="button" onClick={onClose}>{t('common.close')}</button>
            <button className="bw__modal-select" type="button" onClick={() => onSelect(s)}>{t('wizard.facility.selectCta')} <ArrowRight /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

// VAT suffix that respects the admin "tax inclusive" flag (never static).
function VatNote({ inclusive }) {
  return <span className="bw__vat">{inclusive ? 'incl. VAT' : '+ VAT'}</span>;
}

/**
 * Optional extras for the chosen facility, as a step rather than a modal.
 *
 * A modal made this a one-shot decision: dismissing it lost the choice and
 * there was no way back to it. As a step it behaves like every other choice in
 * the wizard - revisitable from the timeline, and restored from the URL. The
 * markup keeps the existing add-on classes, so the styling is unchanged.
 */
function AddOns({ facilityType, currency, selected = [], onConfirm }) {
  const { t } = useTranslation();
  const list = facilityType?.add_ons || [];
  const [picked, setPicked] = useState(selected);

  // Coming back to the step shows what was chosen last time, not a blank slate.
  useEffect(() => { setPicked(selected); }, [facilityType?.id]);   // eslint-disable-line

  const toggle = (id) => setPicked(
    picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id],
  );
  const count = picked.length;

  if (list.length === 0) {
    return (
      <div className="bw__addon-step">
        <p className="bw__empty">{t('wizard.addons.empty')}</p>
        <button type="button" className="bw__modal-select" onClick={() => onConfirm([])}>
          {t('common.continue')} <ArrowRight />
        </button>
      </div>
    );
  }

  return (
    <div className="bw__addon-step">
      <div className="bw__addon-head">
        <span className="bw__cal-eyebrow"><Sparkle /> {t('wizard.addons.title')}</span>
        <h3>Boost your {facilityType?.name}</h3>
        <p>Optional extras - pick any you&rsquo;d like, or continue without.</p>
      </div>

      <div className="bw__addon-grid">
        {list.map((a) => {
          const on = picked.includes(a.id);
          return (
            <button key={a.id} type="button" className={`bw__addon${on ? ' is-on' : ''}`}
              onClick={() => toggle(a.id)} aria-pressed={on}>
              <span className="bw__addon-check">{on ? <Check /> : null}</span>
              {a.image && <span className="bw__addon-img"><img src={a.image} alt="" loading="lazy" /></span>}
              <span className="bw__addon-body">
                <strong>{a.name}</strong>
                {a.description && <span className="bw__addon-desc">{a.description}</span>}
              </span>
              <span className="bw__addon-price">
                + <Price amount={a.price} currency={currency} /> <VatNote inclusive={a.tax_inclusive} />
              </span>
            </button>
          );
        })}
      </div>

      <div className="bw__addon-foot">
        <button type="button" className="bw__modal-close-btn" onClick={() => onConfirm([])}>
          {t('wizard.addons.skip')}
        </button>
        <button type="button" className="bw__modal-select" onClick={() => onConfirm(picked)}>
          {t('common.continue')}
          {count ? ` · ${t('wizard.addons.addonCount', { count })}` : ''} <ArrowRight />
        </button>
      </div>
    </div>
  );
}

/**
 * The facility step: category filter plus the facility cards beneath it.
 *
 * Category used to be a whole step of its own. It is a filter, not a decision a
 * customer has to make, so it sits above the list and "All" is a valid answer.
 */
function FacilityBrowser({ categories, category, onCategory, list, currency, onPick }) {
  const { t } = useTranslation();
  return (
    <div className="bw__browse">
      {categories.length > 1 && (
        <div className="bw__filters" role="group" aria-label={t('wizard.facility.filter')}>
          <button type="button" aria-pressed={!category}
            className={`bw__filter${!category ? ' is-on' : ''}`}
            onClick={() => onCategory(null)}>{t('common.all')}</button>
          {categories.map((c) => (
            <button key={c.id} type="button" aria-pressed={category?.id === c.id}
              className={`bw__filter${category?.id === c.id ? ' is-on' : ''}`}
              onClick={() => onCategory(c)}>{c.name}</button>
          ))}
        </div>
      )}
      <FacilityTypes list={list} currency={currency} onPick={onPick}
        emptyKey={categories.length === 0
          ? 'wizard.facility.emptyClub' : 'wizard.facility.empty'} />
    </div>
  );
}

function Location({ clubs, query, setQuery, club, onChoose, city }) {
  const { t } = useTranslation();
  const place = city || 'your area';
  const [coords, setCoords] = useState(null);
  const [geo, setGeo] = useState('idle');   // idle | loading | ok | denied
  const [open, setOpen] = useState(false);   // search-suggestions dropdown

  const requestGeo = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setGeo('denied'); return; }
    setGeo('loading');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setGeo('ok'); },
      () => setGeo('denied'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
  };
  useEffect(() => { requestGeo(); /* eslint-disable-next-line */ }, []);

  // Clubes (already filtered by the club-only search) sorted nearest-first.
  const list = useMemo(() => {
    const arr = clubs.map((b) => ({ ...b, distance: haversine(coords, b) }));
    if (coords) arr.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
    return arr;
  }, [clubs, coords]);

  const dist = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

  // Keep it uncluttered: by default just the 2-3 nearest clubs. Typing opens
  // an autocomplete dropdown (clubs only) anchored to the search box.
  const searching = query.trim().length > 0;
  const shown = list.slice(0, 3);

  return (
    <div className="bw__loc">
      <div className="bw__loc-hero">
        <div className="bw__loc-herohead">
          <span className="bw__loc-pin"><Pin /></span>
          <h2>{t('wizard.club.title')}</h2>
        </div>
        <p>{t('wizard.club.pickInLead', { city: place })}</p>
      </div>

      <div className="bw__loc-search">
        <Pin />
        <input
          type="text" value={query} aria-label={t('wizard.club.search')}
          placeholder={`Search a club in ${place}`}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { if (query.trim()) setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
        />
        {open && searching && (
          <ul className="bw__loc-suggest" role="listbox">
            {list.length === 0 && <li className="bw__loc-suggest-empty">No clubs match “{query.trim()}”.</li>}
            {list.map((b) => (
              <li key={b.id}>
                <button type="button" className="bw__loc-suggest-item" role="option"
                  onMouseDown={(e) => { e.preventDefault(); setQuery(b.name); setOpen(false); onChoose(b); }}>
                  <Pin />
                  <span className="bw__loc-suggest-text">
                    <strong>{b.name}</strong>
                    <span>{[b.address, b.city].filter(Boolean).join(', ') || 'Address coming soon'}</span>
                  </span>
                  {b.distance != null && <span className="bw__club-dist">{dist(b.distance)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bw__loc-tools">
        {geo !== 'ok' && (
          <button type="button" className="bw__geo" onClick={requestGeo} disabled={geo === 'loading'}>
            <Pin /> {geo === 'loading' ? 'Finding you…' : 'Use my current location'}
          </button>
        )}
        {geo === 'ok' && <span className="bw__geo-ok"><Check /> {t('wizard.club.nearestFirst')}</span>}
        {geo === 'denied' && <span className="bw__geo-note">{t('wizard.club.allowLocation')}</span>}
      </div>

      {!searching && (
        <>
          <div className="bw__loc-listhead">
            <span>{t('wizard.club.nearest')}</span>
            {list.length > shown.length && <span className="bw__loc-listhint">Search to see all {list.length}</span>}
          </div>
          <div className="bw__loc-list">
            {shown.length === 0 && <p className="bw__empty">{t('wizard.club.empty')}</p>}
            {shown.map((b) => (
              <button
                key={b.id} type="button"
                className={`bw__club${club?.id === b.id ? ' is-active' : ''}`}
                onClick={() => onChoose(b)}
              >
                <span className="bw__club-pin"><Pin /></span>
                <span className="bw__club-info">
                  <strong>{b.name}</strong>
                  <span>{[b.address, b.city].filter(Boolean).join(', ') || 'Address coming soon'}</span>
                </span>
                {b.distance != null && <span className="bw__club-dist">{dist(b.distance)}</span>}
                <span className="bw__club-check" aria-hidden="true"><Check /></span>
              </button>
            ))}
          </div>
        </>
      )}

      <p className="bw__loc-note">We currently serve clubs across {place}.</p>
    </div>
  );
}

/** "Sat 19 Sep": enough to place a time, short enough for a chip. */
const shortDate = (iso, locale) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(
    intlLocale(locale), { weekday: 'short', day: 'numeric', month: 'short' });
};

/** Chosen slots as [{ date, times: [...] }], in order.
 *
 *  Both the summary and the basket read this, so the date is written once per
 *  day rather than repeated against every time, which is what made two slots
 *  on one evening fill the panel. */
function groupByDate(slots) {
  const order = [];
  const byDate = new Map();
  for (const slot of slots) {
    if (!byDate.has(slot.date)) {
      byDate.set(slot.date, []);
      order.push(slot.date);
    }
    byDate.get(slot.date).push(slot);
  }
  return order.map((date) => ({ date, times: byDate.get(date) }));
}

const longDate = (iso, locale) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(
    intlLocale(locale), { weekday: 'long', month: 'long', day: 'numeric' });
};

const Chevron = ({ dir }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d={dir === 'left' ? 'M15 18l-6-6 6-6' : 'M9 6l6 6-6 6'} />
  </svg>
);

// Session cache of availability responses (stale-while-revalidate): a cached
// date paints instantly, but we always refetch in the background so a slot
// another customer just took disappears within a moment. The server also
// re-checks the slot at booking time, so a stale view can never double-book.
const _availCache = new Map();
const _availKey = (club, facilityType, date) => `${club?.id}|${facilityType?.id}|${date}`;

// Month-level DATE availability, so a day the club cannot serve is greyed out
// before it is clicked rather than after. Cached per month for the session and
// dropped whenever a day's slots are known to have moved.
const _monthCache = new Map();
const _monthKey = (club, facilityType, from) => `${club?.id}|${facilityType?.id}|${from}`;

const availInvalidate = (club, facilityType, date) => {
  _availCache.delete(_availKey(club, facilityType, date));
  // The month summary said this date was bookable; something just proved
  // otherwise, so it must be re-read rather than trusted.
  if (date) _monthCache.delete(_monthKey(club, facilityType, `${date.slice(0, 7)}-01`));
};

/**
 * The price of ONE slot, decided by the backend.
 *
 * Both the date step and the checkout ask this, because two screens working
 * the price out separately is exactly how they came to disagree: the date
 * step was showing the bare catalogue price while the checkout showed the
 * same booking with its add-ons, its offer and VAT applied.
 *
 * The browser never computes a total here. It multiplies a backend figure by
 * how many slots were chosen, and the backend prices every slot again for
 * real when the booking is submitted.
 */
const fetchQuote = ({ club, facilityType, addons, coupon = '', slots = [] }) =>
  fetch('/api/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      facility_type: facilityType?.id, club: club?.id,
      add_ons: addons || [], coupon,
      // The dates matter: a rule limited to a date range or a time of day is
      // skipped entirely when the backend is asked to price "some booking,
      // no date". That is how an offer which ended in September came to be
      // quoted against a December booking at a price the real booking would
      // never have charged.
      slots: slots.map((slot) => ({ date: slot.date, time: slot.time })),
    }),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

/**
 * Shown where a price will be, until the backend has said what it is.
 *
 * The alternative was to show the catalogue price and swap it for the real
 * one a moment later, which a customer reads as the price changing while
 * they watch. A figure that has not arrived is better drawn as absent than
 * guessed at and corrected.
 */
const PriceSkeleton = () => (
  <span className="bw__price-wait" aria-hidden="true" />
);

/** What the whole selection costs: every slot priced on its own date. */
const orderTotal = (quote) => quote?.order_total
  ?? quote?.summary?.total ?? quote?.total_amount ?? null;

/** What ONE slot costs, for the line breakdown. */
const quoteTotal = (quote) => quote?.summary?.total ?? quote?.total_amount ?? null;

/** True when every chosen slot costs the same, so a per-slot figure and a
 *  saving may honestly be shown against the whole order. */
const slotsPriceAlike = (quote) => {
  const totals = quote?.slot_totals || [];
  return totals.length <= 1 || totals.every((value) => value === totals[0]);
};

const monthBounds = (view) => {
  const y = view.getFullYear();
  const m = view.getMonth();
  return { from: isoDate(new Date(y, m, 1)), to: isoDate(new Date(y, m + 1, 0)) };
};

const sameSlot = (a, b) => a.date === b.date && a.time === b.time;
const sortSlots = (list) => [...list].sort((a, b) => (a.date === b.date
  ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)));

/**
 * Should this time appear in the list at all?
 *
 * A slot nobody has booked, that somebody is merely part way through paying
 * for, is withdrawn rather than labelled. Calling it "fully booked" is untrue,
 * and it may well be free again within minutes: a customer who reads "booked"
 * writes that time off for good, whereas one who sees nothing simply picks
 * another and may find it back on the next visit.
 *
 * A slot that is genuinely booked keeps its place and its label, because that
 * one is not coming back today. A payload with no `held` (an older backend)
 * behaves exactly as it always did.
 */
export function slotIsVisible(slot) {
  return slot.available > 0 || !(slot.held > 0);
}

export function Schedule({ facilityType, category, club, currency, initialDate = null,
                   addons = [], values = [], onChange, onContinue }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const today = startOfToday();
  // Open on the day the customer asked for, never on one already past.
  const opening = (() => {
    if (!initialDate) return today;
    const asked = new Date(`${initialDate}T00:00:00`);
    return Number.isNaN(asked.getTime()) || asked < today ? today : asked;
  })();
  const [view, setView] = useState(() => new Date(opening.getFullYear(), opening.getMonth(), 1));
  const [date, setDate] = useState(() => isoDate(opening));
  const [data, setData] = useState(
    () => _availCache.get(_availKey(club, facilityType, isoDate(opening))) || null);
  const [loading, setLoading] = useState(true);

  // Show cached availability immediately, then always revalidate in the
  // background so the slot list stays fresh as other customers book.
  useEffect(() => {
    if (!club) return undefined;
    const key = _availKey(club, facilityType, date);
    const cached = _availCache.get(key);
    if (cached) { setData(cached); setLoading(false); } else { setLoading(true); }
    let cancelled = false;
    fetch(`/api/availability?club=${club.id}&date=${date}`
          + (facilityType ? `&facility_type=${facilityType.id}` : ''))
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { _availCache.set(key, d); setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled && !cached) { setData({ closed: true, slots: [], weekdays: {} }); setLoading(false); } });
    return () => { cancelled = true; };
  }, [club, facilityType, date]);

  // Which DATES are bookable this month, answered by the backend. The browser
  // must not decide this from the weekday pattern: a holiday, a maintenance
  // closure and a fully booked day all look open in a weekly schedule.
  const { from: monthFrom, to: monthTo } = monthBounds(view);
  const [month, setMonth] = useState(
    () => _monthCache.get(_monthKey(club, facilityType, monthFrom)) || null);
  const [monthLoading, setMonthLoading] = useState(true);
  const [monthFailed, setMonthFailed] = useState(false);
  // The closed date the customer is currently asking about, shown in a line
  // under the grid rather than a floating tooltip. A tooltip has to be
  // positioned, and near the edge of a phone it either overflows the viewport
  // or covers the dates either side of the one being explained. A line below
  // the calendar has neither problem, works on touch where there is no hover
  // at all, and can be announced.
  const [dayNote, setDayNote] = useState(null);

  useEffect(() => {
    if (!club) return undefined;
    const key = _monthKey(club, facilityType, monthFrom);
    const cached = _monthCache.get(key);
    if (cached) { setMonth(cached); setMonthLoading(false); } else { setMonthLoading(true); }
    setMonthFailed(false);
    let cancelled = false;
    fetch(`/api/availability-calendar?club=${club.id}&from=${monthFrom}&to=${monthTo}`
          + (facilityType ? `&facility_type=${facilityType.id}` : ''))
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        _monthCache.set(key, d);
        setMonth(d);
        setMonthLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // A failed summary must not silently disable the whole month. Say so,
        // and fall back to letting the customer open a day to find out.
        setMonthFailed(true);
        setMonthLoading(false);
      });
    return () => { cancelled = true; };
  }, [club, facilityType, monthFrom, monthTo]);

  const is24 = data?.time_format_24h;
  const weekdays = data?.weekdays || {};

  // How many times one booking may hold here, decided by the backend and
  // carried with availability. The browser never works this out for itself.
  const rules = data?.slot_rules || null;
  const multi = rules?.allow_multiple_slots === true;
  const maxSlots = Math.max(1, Number(rules?.max_slots_per_booking) || 1);
  const minSlots = Math.max(1, Number(rules?.min_slots_per_booking) || 1);
  const isPicked = (time) => values.some((v) => v.date === date && v.time === time);
  const atCapacity = multi && values.length >= maxSlots;

  const pick = (s) => {
    const entry = { date, time: s.time, end: s.end };
    if (!multi) { onChange([entry]); return; }
    if (values.some((v) => sameSlot(v, entry))) {
      onChange(values.filter((v) => !sameSlot(v, entry)));
      return;
    }
    // A club that does not allow several dates starts the selection again
    // rather than silently keeping a time the server would reject.
    const base = rules?.allow_multiple_dates
      ? values : values.filter((v) => v.date === entry.date);
    if (base.length >= maxSlots) return;
    onChange(sortSlots([...base, entry]));
  };

  // Month grid (leading blanks + days of the month).
  const y = view.getFullYear(), m = view.getMonth();
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(new Date(y, m, d));
  // The club's booking policy travels with availability: respect the lead time
  // and the booking horizon here so a customer is never offered a day the server
  // would refuse.
  const win = data?.window || null;
  const earliest = win?.earliest_date ? new Date(`${win.earliest_date}T00:00:00`) : today;
  const latest = win?.latest_date ? new Date(`${win.latest_date}T00:00:00`) : null;
  const firstAllowed = earliest > today ? earliest : today;

  const atMin = y === firstAllowed.getFullYear() && m === firstAllowed.getMonth();
  const horizonView = latest || new Date(today.getFullYear(), today.getMonth() + 6, 1);
  const atMax = y === horizonView.getFullYear() && m === horizonView.getMonth();
  // What one slot really costs, including its add-ons, any automatic offer
  // and VAT: the same figure the checkout shows, from the same endpoint, so
  // the two steps cannot disagree.
  const [priced, setPriced] = useState(null);
  // Re-quoted whenever the selection changes, because the price of a day can
  // differ from the price of the next one.
  const pricedKey = `${club?.id}|${facilityType?.id}|${addons.join(',')}`
    + `|${values.map((v) => `${v.date}T${v.time}`).join(',')}`;
  useEffect(() => {
    if (!facilityType) return undefined;
    let cancelled = false;
    fetchQuote({
      club, facilityType, addons,
      // Before anything is chosen, price the day being looked at, so the
      // figure shown is still the figure for that date.
      slots: values.length ? values : [{ date, time: '' }],
    }).then((quote) => { if (!cancelled) setPriced(quote); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricedKey, values.length ? '' : date]);

  // Falls back to the catalogue price only until the quote lands, so the
  // panel is never blank; the quoted figure replaces it a moment later.
  const chosenAddons = (facilityType?.add_ons || [])
    .filter((addon) => addons.includes(addon.id));

  // Only ever the backend's figure. `priced` is not cleared when the
  // selection changes, so the previous total stays on screen while the new
  // one is fetched and the number never blinks back to a placeholder.
  const runningTotal = orderTotal(priced);

  const days = month?.days || null;

  // The month summary is a snapshot taken when the month was opened. Another
  // customer can take the last slot in between, so a date it called bookable
  // can arrive empty. That is not "no times today", it is "not any more", and
  // the snapshot must be dropped so the date greys out.
  const dayFree = (data?.slots || []).some((s) => s.available > 0);
  // Held-but-not-booked slots are withdrawn from the list. `held` is the
  // backend's count of courts a live reservation is holding for this slot;
  // an older payload without it behaves exactly as before.
  const visibleSlots = (data?.slots || []).filter(slotIsVisible);
  const wentStale = Boolean(data && !loading && !data.closed
    && !dayFree && days?.[date]?.available);

  useEffect(() => {
    if (!wentStale) return;
    _monthCache.delete(_monthKey(club, facilityType, monthFrom));
    setMonth((current) => (current?.days?.[date]
      ? { ...current, days: { ...current.days,
          [date]: { ...current.days[date], available: false, slot_count: 0 } } }
      : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wentStale, date]);
  // Until the summary lands, and if it ever fails, fall back to the weekly
  // pattern. That is a guess, so it is used ONLY as a provisional state: the
  // slot list and the booking itself are still resolved by the backend.
  const provisional = (d) => weekdays[WK[d.getDay()]]?.closed;
  const dayState = (d) => {
    const outside = d < firstAllowed || (latest && d > latest);
    if (outside) return { off: true, count: 0 };
    const known = days ? days[isoDate(d)] : null;
    if (!known) return { off: Boolean(provisional(d)), count: 0, unknown: !days };
    return {
      off: !known.available,
      count: known.slot_count || 0,
      // Why a date is out, when the backend knows. A holiday looks exactly
      // like any other greyed day otherwise, and the customer is left to
      // guess whether it is worth ringing the club to ask.
      reason: known.available ? '' : (known.reason || ''),
      // The name the club gave the date, e.g. "National Day". Absent on a
      // summary cached by an older release, so never assumed.
      label: known.available ? '' : (known.label || ''),
      // Only a bookable date carries one. Advertising a discount on a day
      // nobody can book is an advert for a disappointment.
      offer: known.available ? known.offer || null : null,
    };
  };
  const dayOff = (d) => dayState(d).off;
  const todayIso = isoDate(today);

  // Nothing at all this month, once we actually know.
  const monthEmpty = Boolean(days) && !monthLoading
    && !cells.some((d) => d && !dayOff(d));
  const nextAvailable = month?.next_available || null;

  // Section 10: if the day the calendar opened on cannot be booked, move to
  // the first one that can. Only on the first summary for a month, so it never
  // fights a customer who has deliberately chosen a date.
  const settled = useRef('');
  useEffect(() => {
    if (!days || monthLoading) return;
    const key = `${club?.id}|${facilityType?.id}|${monthFrom}`;
    if (settled.current === key) return;
    settled.current = key;
    if (days[date]?.available) return;
    const firstOpen = Object.keys(days).sort().find((iso) => days[iso].available);
    if (firstOpen) setDate(firstOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, monthLoading, monthFrom]);

  /** Jump to the month holding the backend's next bookable date, and select it. */
  const goToNextAvailable = () => {
    if (!nextAvailable) return;
    const [ny, nm, nd] = nextAvailable.split('-').map(Number);
    setView(new Date(ny, nm - 1, 1));
    setDate(isoDate(new Date(ny, nm - 1, nd)));
  };

  return (
    <div className="bw__cal">
      {/* LEFT - your selection */}
      <div className="bw__cal-info">
        <span className="bw__cal-eyebrow">{t('wizard.when.yourBooking')}</span>
        <h3 className="bw__cal-title">{facilityType?.name || t('wizard.when.yourBooking')}</h3>
        {facilityType?.tagline && <p className="bw__cal-tagline">{facilityType.tagline}</p>}
        <ul className="bw__cal-meta">
          {facilityType?.duration_minutes ? <li><Clock /> {duration(facilityType.duration_minutes, t)}</li> : null}
          <li><Pin /> {club?.name}{club?.city ? `, ${club.city}` : ''}</li>
        </ul>

        {/* What was chosen on the previous step. Without this the add-ons are
            invisible from here on, and they are part of the price shown
            below. */}
        {chosenAddons.length > 0 && (
          <ul className="bw__cal-pills" aria-label={t('wizard.addons.title')}>
            {chosenAddons.map((addon) => (
              <li key={addon.id} className="bw__cal-pill">{addon.name}</li>
            ))}
          </ul>
        )}
        <div className="bw__cal-sep" />
        {values.length > 0 && (
          <div className="bw__cal-appt">
            <span className="bw__cal-appt-k">{t('wizard.when.appointment')}</span>
            <ul className="bw__cal-appt-list">
              {groupByDate(values).map((group) => (
                <li key={group.date}>
                  <span className="bw__cal-appt-d">
                    {longDate(group.date, locale)}
                  </span>
                  {group.times.map((slot) => (
                    <span className="bw__cal-appt-t" key={slot.time}>
                      <bdi>{fmtTime(slot.time, is24)} - {fmtTime(slot.end, is24)}</bdi>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="bw__cal-total">
          <span>{t('common.total')}</span>
          <div className="bw__cal-total-v">
            {/* The backend's figure for exactly these slots, or a placeholder
                until it arrives. Never the catalogue price: showing that
                first and correcting it is what made the total appear to
                change on its own. */}
            <strong>
              {runningTotal === null
                ? <PriceSkeleton />
                : <Price amount={runningTotal} currency={currency} />}
            </strong>
            {values.length > 1 && (
              <span className="bw__cal-total-n">
                {t('wizard.when.chosenCount', { count: values.length })}
              </span>
            )}
          </div>
        </div>

        <p className="bw__cal-pay"><Clock /> {t('wizard.when.payOnCompletion')}</p>
      </div>

      {/* CENTER - month calendar */}
      <div className="bw__cal-main">
        <div className="bw__cal-monthbar">
          <button type="button" disabled={atMin} aria-label={t('wizard.when.previousMonth')}
            onClick={() => setView(new Date(y, m - 1, 1))}><Chevron dir="left" /></button>
          <span className="bw__cal-month">
            {view.toLocaleDateString(intlLocale(locale), { month: 'long', year: 'numeric' })}
          </span>
          <button type="button" disabled={atMax} aria-label={t('wizard.when.nextMonth')}
            onClick={() => setView(new Date(y, m + 1, 1))}><Chevron dir="right" /></button>
        </div>
        <div className="bw__dow">
          {/* Built from Intl rather than hard-coded, so the column headings read
              in the same language as the month above them. 2024-01-07 is a
              Sunday, which is where this grid starts. */}
          {Array.from({ length: 7 }, (_, index) => {
            const day = new Date(2024, 0, 7 + index);
            return (
              <span key={index}>
                {day.toLocaleDateString(intlLocale(locale), { weekday: weekdayStyle(locale) })}
              </span>
            );
          })}
        </div>
        <div className="bw__month">
          {cells.map((d, i) => {
            if (!d) return <span key={`b${i}`} className="bw__day bw__day--blank" />;
            const iso = isoDate(d);
            const state = dayState(d);
            const off = state.off;
            const active = iso === date;
            const isToday = iso === todayIso;
            // A handful of slots left is worth a quiet mark; a full day is not
            // worth decorating, and every day carrying a badge would be noise.
            const limited = !off && state.count > 0 && state.count <= 2;
            const offer = state.offer;
            // A discount confined to part of the day says only that an offer
            // exists; claiming "-20%" for the whole date would be a lie.
            const offerText = offer
              ? (offer.time_limited ? t('wizard.when.offer') : offer.label)
              : '';
            // Why this date is out, in the customer's language. The club's own
            // name for the date wins when it gave one, because "National Day"
            // tells them more than "Closed" ever will.
            const whyOff = off ? reasonText(state, t) : '';
            const holiday = off && state.reason === 'holiday';
            // A date that can EXPLAIN itself stays focusable and tappable so it
            // can be asked. `disabled` would make it unreachable by keyboard
            // and inert to a tap, which on a phone means the explanation could
            // never be reached at all. The click is guarded instead.
            const askable = Boolean(whyOff);
            return (
              <button key={iso} type="button"
                disabled={off && !askable}
                aria-disabled={off || undefined}
                title={offer ? offer.name : (whyOff || undefined)}
                aria-label={longDate(iso, locale)
                  + (off ? `, ${whyOff || t('wizard.when.unavailable')}` : '')
                  + (!off && limited ? `, ${t('wizard.when.slotsLeft', { count: state.count })}` : '')
                  + (offer ? `, ${offer.name}` : '')}
                className={`bw__day${active ? ' is-active' : off ? ' is-off' : ' is-open'}${isToday && !active && !off ? ' is-today' : ''}${limited ? ' is-limited' : ''}${offer ? ' has-offer' : ''}${holiday ? ' is-holiday' : ''}`}
                onMouseEnter={askable ? () => setDayNote({ iso, text: whyOff }) : undefined}
                onMouseLeave={askable ? () => setDayNote(null) : undefined}
                onFocus={askable ? () => setDayNote({ iso, text: whyOff }) : undefined}
                onBlur={askable ? () => setDayNote(null) : undefined}
                onClick={() => {
                  // An unbookable date never becomes the selection, however it
                  // was reached. Tapping one only asks it why.
                  if (off) { if (askable) setDayNote({ iso, text: whyOff }); return; }
                  setDate(iso);
                }}>
                {d.getDate()}
                {offer && <span className="bw__day-offer"><bdi>{offerText}</bdi></span>}
                {limited && !offer && <span className="bw__day-dot" aria-hidden="true" />}
                {holiday && <span className="bw__day-mark" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        {/* Announced politely: a customer using a screen reader hears the
            reason when they arrow onto the date, which is the same moment a
            sighted customer sees it. */}
        <p className="bw__cal-why" role="status" aria-live="polite">
          {dayNote ? (
            <>
              <span className="bw__cal-why-day">{longDate(dayNote.iso, locale)}</span>
              <span className="bw__cal-why-text">{dayNote.text}</span>
            </>
          ) : ''}
        </p>

        {monthLoading && !days && (
          <p className="bw__cal-note">{t('wizard.when.checkingAvailability')}</p>
        )}
        {monthFailed && (
          <p className="bw__cal-note">{t('wizard.when.availabilityUnknown')}</p>
        )}
        {monthEmpty && (
          <div className="bw__cal-empty" role="status">
            <p>{t('wizard.when.noneThisMonth')}</p>
            {nextAvailable && (
              <>
                <p className="bw__cal-next">
                  {t('wizard.when.nextAvailable', {
                    date: longDate(nextAvailable, locale),
                  })}
                </p>
                <button type="button" className="bw__cal-jump"
                  onClick={goToNextAvailable}>
                  {t('wizard.when.goToNextAvailable')}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* A slot nobody has booked, that somebody is merely part way through
          paying for, is withdrawn rather than labelled. Calling it "fully
          booked" was untrue, and it may well be free again in a few minutes:
          a customer who reads "booked" writes that time off, and one who sees
          nothing simply picks another. A slot that is genuinely booked keeps
          its label, because that one is not coming back today. */}
      {/* RIGHT - times for the selected date */}
      <div className="bw__cal-times">
        <div className="bw__cal-timehead">{longDate(date, locale)}</div>
        <div className="bw__time-list">
          {loading ? <p className="bw__sch-loading">{t('common.loading')}</p>
            : data?.closed ? <p className="bw__cal-none">{t('wizard.when.closed')}</p>
              : wentStale ? (
                <p className="bw__cal-none">{t('wizard.when.noLongerAvailable')}</p>
              )
              : visibleSlots.length ? visibleSlots.map((s) => {
                const off = s.available <= 0;
                const sel = isPicked(s.time);
                const tone = off ? ' is-off' : ' is-cool';
                return (
                  <div key={s.time} className={`bw__time-row${sel ? ' is-sel' : ''}`}>
                    <button type="button" className={`bw__time${sel ? ' is-sel' : tone}`}
                      disabled={off || (atCapacity && !sel)}
                      aria-pressed={multi ? sel : undefined}
                      onClick={() => pick(s)}>
                      <span className="bw__time-t"><bdi>{fmtTime(s.time, is24)}</bdi></span>
                      {off ? <span className="bw__time-tag">{t('wizard.when.fullyBooked')}</span>
                        : null}
                      {/* Peak / off-peak, as classified on the business hours.
                          Shown to the customer in the words they price things
                          in, not in the admin's Hot/Cold wording. */}
                      {!off && s.period === 'hot' && (
                        <span className="bw__time-per bw__time-per--hot">
                          {t('wizard.when.peak')}
                        </span>
                      )}
                      {!off && s.period === 'cold' && (
                        <span className="bw__time-per bw__time-per--cold">
                          {t('wizard.when.offPeak')}
                        </span>
                      )}
                      {!off && s.offer && (
                        <span className="bw__time-offer" title={s.offer.name}>
                          <bdi>{s.offer.label}</bdi>
                        </span>
                      )}
                    </button>
                    {/* In multi-select the Continue lives once at the foot of
                        the list, so it is not repeated beside every chosen time. */}
                    {!multi && (
                      <button type="button" className="bw__time-go" tabIndex={sel ? 0 : -1}
                        aria-hidden={!sel} onClick={onContinue}>{t('common.continue')}</button>
                    )}
                  </div>
                );
              }) : <p className="bw__cal-none">{t('wizard.when.noTimes')}</p>}
        </div>

        {/* Everything chosen so far, including times on other days, so the
            customer is never asked to remember what is already in the basket. */}
        {multi && (
          <div className="bw__pick">
            {values.length === 0 ? (
              <p className="bw__pick-hint">
                {t('wizard.when.pickUpTo', { count: maxSlots })}
              </p>
            ) : (
              <>
                <ul className="bw__pick-list">
                  {groupByDate(values).map((group) => (
                    <li key={group.date} className="bw__pick-day">
                      <span className="bw__pick-date">
                        <bdi>{shortDate(group.date, locale)}</bdi>
                      </span>
                      <span className="bw__pick-chips">
                        {group.times.map((v) => (
                          <button
                            key={v.time}
                            type="button"
                            className="bw__pick-chip"
                            title={t('wizard.when.removeTime')}
                            aria-label={`${longDate(v.date, locale)} ${fmtTime(v.time, is24)}, ${t('wizard.when.removeTime')}`}
                            onClick={() => onChange(values.filter((x) => !sameSlot(x, v)))}
                          >
                            <bdi>{fmtTime(v.time, is24)}</bdi>
                            <span className="bw__pick-x" aria-hidden="true">&times;</span>
                          </button>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="bw__pick-hint">
                  {atCapacity
                    ? t('wizard.when.maxReached', { count: maxSlots })
                    : t('wizard.when.chosenOf', { chosen: values.length, max: maxSlots })}
                </p>
              </>
            )}
            <button type="button" className="bw__pick-go"
              disabled={values.length < minSlots}
              onClick={onContinue}>
              {values.length < minSlots
                ? t('wizard.when.chooseAtLeast', { count: minSlots })
                : t('common.continue')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * How long the courts are held for, and what to do when that runs out.
 *
 * Deliberately not a modal and not a scary red box until it matters. A
 * countdown is information while there is time and an instruction once there
 * is not, so the tone changes at the one minute mark and the whole thing turns
 * into a way back to the calendar when it reaches zero.
 *
 * `role="status"` rather than `role="timer"`: a screen reader should hear that
 * the reservation exists, not every passing second. `aria-live="off"` on the
 * ticking value keeps the number from being announced sixty times a minute,
 * and the expiry message is the one thing that does get announced.
 */
export function HoldBanner({ reservation, onPickAgain }) {
  const { t } = useTranslation();
  if (!reservation) return null;

  const { secondsLeft, expired, pending, error, showCountdown } = reservation;

  // The courts could not be held and the server said why, which almost always
  // means somebody has taken one of these times. Saying so here is the whole
  // point: the alternative is the customer filling in their details, pressing
  // Pay, and being refused at the last step. Silence used to be the outcome of
  // every failure, so the checkout simply had no timer and no explanation.
  if (error) {
    return (
      <div className="ck__hold ck__hold--over" role="alert">
        <span className="ck__hold-tx">{error}</span>
        <button type="button" className="ck__hold-btn" onClick={onPickAgain}>
          {t('hold.pickAgain')}
        </button>
      </div>
    );
  }

  // Claiming takes a round trip. Holding the space stops the banner popping
  // in and shoving the form down as the customer starts typing.
  if (pending && secondsLeft === null) {
    return (
      <div className="ck__hold" role="status">
        <span className="ck__hold-tx">{t('hold.holding')}</span>
      </div>
    );
  }

  // No reservation and no error: the request could not be made at all. The
  // backend revalidates availability before it writes anything, so checkout
  // still works and inventing a warning would only frighten people.
  if (secondsLeft === null) return null;

  if (expired) {
    return (
      <div className="ck__hold ck__hold--over" role="alert">
        <span className="ck__hold-tx">{t('hold.expired')}</span>
        <button type="button" className="ck__hold-btn" onClick={onPickAgain}>
          {t('hold.pickAgain')}
        </button>
      </div>
    );
  }

  // A club may switch the clock off: some would rather not put a timer in
  // front of somebody entering their card details. The court is still held
  // and the expiry message above still appears, because a customer whose
  // reservation ran out has to be told SOMETHING rather than meeting an
  // unexplained refusal at the Pay button. Only the ticking number goes.
  if (showCountdown === false) return null;

  const urgent = secondsLeft <= 60;
  const time = formatCountdown(secondsLeft);
  return (
    <div className={`ck__hold${urgent ? ' ck__hold--soon' : ''}`} role="status">
      <span className="ck__hold-tx">
        <strong>{t('hold.heading')}</strong>{' '}
        <span aria-live="off">
          {t(urgent ? 'hold.soon' : 'hold.remaining', { time })}
        </span>
      </span>
    </div>
  );
}

function Money({ amount, currency }) {
  const n = Number(amount);
  // Whole numbers drop the ".00"; fractional amounts keep 2 decimals.
  const hasFrac = Number.isFinite(n) && Math.abs(n % 1) > 1e-9;
  const v = Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: hasFrac ? 2 : 0, maximumFractionDigits: 2 })
    : amount;
  const sym = currency === 'AED' ? <span className="aed-symbol">AED</span> : <>{currency}</>;
  return <bdi>{sym} {v}</bdi>;
}

function Details({ facilityType, category, club, slot, slots = [], currency, country = '', addons = [], reservation, details, setDetails, pay, setPay, done, setDone, onReset, onEditBooking }) {
  // One checkout may hold several times. Everything priced or paid for below
  // is the whole selection, never just the first slot.
  const chosen = slots.length ? slots : (slot ? [slot] : []);
  const slotCount = Math.max(1, chosen.length);
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const selectedAddons = (facilityType?.add_ons || []).filter((a) => addons.includes(a.id));
  // Form + payment state live in the parent so they survive navigating away
  // and back to this step (until the booking is completed).
  const form = details;
  const { method, coupon, applied, card, split } = pay;   // applied = { code, discount }
  const set = (k) => (e) => setDetails((f) => ({ ...f, [k]: e.target.value }));
  const setMethod = (m) => setPay((p) => ({ ...p, method: m }));
  const setCoupon = (v) => setPay((p) => ({ ...p, coupon: v }));
  const setApplied = (a) => setPay((p) => ({ ...p, applied: a }));
  // `setCard`/`setSplit` take an updater so the child can patch one field
  // without the parent having to know the shape of the rest.
  const setCard = (next) => setPay((p) => ({
    ...p, card: typeof next === 'function' ? next(p.card) : next }));
  const setSplit = (next) => setPay((p) => ({
    ...p, split: typeof next === 'function' ? next(p.split) : next }));
  const [couponMsg, setCouponMsg] = useState('');
  const [couponBusy, setCouponBusy] = useState(false);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showErrors, setShowErrors] = useState(false);   // reveal field errors on submit

  // Contact rules (Booking Configuration → Website). Default to required so the
  // form stays strict until the live config loads.
  const [cfg, setCfg] = useState({ email_required: true, phone_required: true, email_unique: false, phone_unique: false });
  // What payment methods are actually available. Defaults to card-off so a
  // checkout that cannot reach the backend offers paying at the venue rather
  // than a card form that would fail, and to cash-on for the same reason: the
  // fallback has to be a method that still works when nothing is known.
  const [payCfg, setPayCfg] = useState({
    card_enabled: false, demo_mode: false, test_cards: [],
    split_enabled: false, cash_enabled: true });
  // Re-asked per club, because taking cash at the desk and allowing a bill to
  // be split are the club's decisions, not the organization's alone.
  useEffect(() => {
    const scope = club?.id ? `&club=${encodeURIComponent(club.id)}` : '';
    let current = true;
    fetch(`/api/split?scope=config${scope}`).then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (current && c) setPayCfg(c); }).catch(() => {});
    return () => { current = false; };
  }, [club?.id]);

  // The details block collapses to a one-line summary once it is done with, the
  // way a checkout should: the payment step is what the customer came here for.
  const [detailsOpen, setDetailsOpen] = useState(true);
  useEffect(() => {
    fetch('/api/booking-config').then((r) => (r.ok ? r.json() : null))
      .then((c) => c && setCfg(c)).catch(() => {});
  }, []);

  // Duplicate → OTP reuse state.
  const [dup, setDup] = useState(null);        // { field, masked } when a unique contact already exists
  const [otpCode, setOtpCode] = useState('');  // code being typed
  const [token, setToken] = useState('');      // signed verification token, sent with the booking
  const [verified, setVerified] = useState(null);  // { email, phone } the token was issued for
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpMsg, setOtpMsg] = useState('');

  // Validation - email/phone required per config; format always checked when present.
  const emailFilled = !!form.email.trim();
  const phoneFilled = !!form.phone.trim();
  const emailOk = cfg.email_required ? (emailFilled && emailLooksReal(form.email)) : emailLooksReal(form.email);
  // Strict, per-country MOBILE validation - a UAE selection only accepts a real
  // UAE mobile (+971 5X), not a landline or any arbitrary digit string.
  const phoneOk = cfg.phone_required ? isValidMobile(form.phone) : (!phoneFilled || isValidMobile(form.phone));
  const valid = form.name.trim() && phoneOk && emailOk
;
  const reqErr = (k) => showErrors && !form[k].trim();   // required text field empty?
  const phoneErr = showErrors && !phoneOk;
  const emailErr = showErrors && !emailOk;

  // A verification stays valid while the verified UNIQUE field(s) are unchanged -
  // so editing the name (or any non-unique field) keeps it, while changing the
  // verified email/phone invalidates it and forces re-verification. We DERIVE this
  // by comparing values rather than clearing the token on every keystroke, which is
  // robust against the phone input re-emitting its value on prefill / re-render.
  // Verification is for ONE field (email has priority). The token stays valid while
  // THAT field is unchanged; comparison is tolerant (email case/space-insensitive,
  // phone by digits) so the phone input re-formatting the prefilled number never
  // spuriously invalidates a good verification.
  const _ne = (s) => (s || '').trim().toLowerCase();
  const _np = (s) => (s || '').replace(/\D/g, '');
  const tokenValid = !!token && !!verified && (
    verified.field === 'email'
      ? _ne(verified.value) === _ne(form.email)
      : _np(verified.value) === _np(form.phone)
  );

  // Editing a contact just hides any stale duplicate prompt; token validity is
  // derived above, so a good verification is never wiped by accident.
  const onEmail = (e) => { setDetails((f) => ({ ...f, email: e.target.value })); setDup(null); };
  const onPhone = (phone) => { setDetails((f) => ({ ...f, phone })); setDup(null); };

  async function verifyOtp() {
    const code = otpCode.trim();
    if (!code || otpBusy) return;
    setOtpBusy(true); setOtpMsg('');
    try {
      const res = await fetch('/api/contact-verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, phone: form.phone, otp: code }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const p = data.prefill || {};
        // Prefill with the existing customer's details, OVERWRITING whatever was
        // typed (the verified record is the source of truth). Fields the record
        // doesn't have fall back to what the customer entered. After this, the
        // customer can edit fields and those edits stand (the token persists, so
        // editing won't re-trigger OTP or re-prefill).
        setDetails((f) => ({
          ...f,
          name: p.name || f.name || '',
          email: p.email || f.email || '',
          phone: p.phone || f.phone || '',

        }));
        // Remember WHICH contact was verified so the token stays valid while it's
        // unchanged (bound to the canonical record + what the user entered).
        setToken(data.token || '');
        setVerified({
          field: data.field || 'email',
          value: data.field === 'phone' ? (p.phone || form.phone) : (p.email || form.email),
        });
        setDup(null); setError('');
      } else {
        setOtpMsg(data?.detail || 'Incorrect code - please try again');
      }
    } catch {
      setOtpMsg('Couldn’t verify the code - please try again');
    } finally { setOtpBusy(false); }
  }

  const loadQuote = (code) => fetchQuote({
    club, facilityType, addons, coupon: code || '', slots: chosen,
  });

  // Initial price breakdown (re-applies a coupon kept from before navigating away).
  useEffect(() => { loadQuote(applied?.code || '').then((q) => q && setQuote(q)); /* eslint-disable-next-line */ }, []);

  async function applyCoupon() {
    const code = coupon.trim();
    if (!code || couponBusy) return;
    setCouponBusy(true); setCouponMsg('');
    const q = await loadQuote(code);
    setCouponBusy(false);
    if (!q) { setCouponMsg(t('errors.couponCheck')); return; }
    setQuote(q);
    if (q.coupon?.applied) { setApplied({ code: q.coupon.code, discount: q.coupon.discount }); setCouponMsg(''); }
    else { setApplied(null); setCouponMsg(q.coupon?.message || t('errors.couponInvalid')); }
  }
  function removeCoupon() {
    setApplied(null); setCoupon(''); setCouponMsg('');
    loadQuote('').then((q) => q && setQuote(q));
  }

  // Does a unique contact need OTP verification? (checked before the rest of the
  // form is filled, so verification starts as soon as Book is clicked).
  const precheck = () => fetch('/api/contact-precheck', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: form.email, phone: form.phone }),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  // The Book / Complete button (either payment method): trigger OTP early if a
  // unique contact is entered and not yet verified - BEFORE requiring the rest of
  // the form; only then enforce all mandatory fields and submit.
  async function onBook(mode) {
    if (busy) return;
    setError('');
    if (!tokenValid && ((cfg.phone_unique && phoneOk) || (cfg.email_unique && emailOk))) {
      setBusy(true);
      const pc = await precheck();
      setBusy(false);
      if (pc?.requires_otp) {
        setDup({ field: pc.field, masked: pc.masked });
        setOtpCode(''); setOtpMsg('');
        return;                       // show OTP first - don't require the rest yet
      }
    }
    setShowErrors(true);
    if (!valid) {
      setDetailsOpen(true);
      setError(t('errors.completeFields'));
      return;
    }
    setError('');
    if (mode === 'card' || mode === 'split') {
      if (!payCfg.card_enabled) {
        setError(t('errors.paymentUnavailable'));
        return;
      }
      const missing = !card.number.trim() || !card.holder.trim()
        || !card.expiry.trim() || !card.cvv.trim();
      // A split only needs a card up front when the organizer is paying their
      // own share right now; otherwise the links do the collecting.
      const needsCard = mode === 'card' || split.payMyShareNow;
      if (needsCard && missing) {
        setError(t('errors.enterCard'));
        return;
      }
      if (mode === 'split') {
        const problem = splitProblem();
        if (problem) { setError(problem); return; }
      }
    }
    book(mode);
  }

  /**
   * Why a split cannot be submitted yet, or '' when it can.
   *
   * This is a courtesy, not a control: the backend performs the same check
   * against its own outstanding balance and refuses anything that does not add
   * up, whatever the browser believes.
   */
  /**
   * Which backend flow this checkout submits.
   *
   * The instrument and the arrangement are separate choices now: you can split
   * a booking and still pay your own share by card, so the method tiles answer
   * "how do I pay" and the split switch answers "who pays".
   */
  const payMode = split.on ? 'split' : (method === 'venue' ? 'cash' : 'card');

  const tiles = paymentTiles({ config: payCfg, country, splitOn: split.on });
  useEffect(() => {
    if (tiles.length && !tiles.some((tile) => tile.key === method)) {
      setMethod(tiles[0].key);
    }
  }, [tiles, method]);

  function splitProblem() {
    const total = Number(quote?.summary?.total ?? quote?.total_amount ?? 0) * slotCount;
    if (split.mode === 'custom') {
      if (!split.custom.length) return t('errors.addOnePerson');
      const allocated = split.custom.reduce(
        (sum, row) => sum + Math.round(Number(row.amount || 0) * 100), 0);
      const target = Math.round(total * 100);
      if (allocated !== target) {
        return t('errors.sharesMustAddUp',
          { amount: formatMoney(total.toFixed(2), cur) });
      }
      return '';
    }
    const people = Number(split.people) || 0;
    if (people < 2) return t('errors.chooseTwoPeople');
    if (Math.round(total * 100) < people) return t('errors.tooManyForAmount');
    return '';
  }

  /**
   * The payment section of the submission.
   *
   * Amounts are never included. The backend prices the booking and decides what
   * each participant owes, so the only thing travelling from here is the
   * customer's INTENT: which method, how many ways, and who the friends are.
   */
  function paymentRequest(mode) {
    if (mode === 'cash') return { method: 'cash' };
    if (mode === 'split') {
      return {
        method: 'split',
        split: splitRequest(split),
        ...(split.payMyShareNow ? { card: cardRequest(card) } : {}),
      };
    }
    return { method: 'card', card: cardRequest(card) };
  }

  async function book(mode = method) {
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      // One time keeps the original endpoint, so nothing about the existing
      // single-slot checkout changes. Several times go to the order endpoint.
      const many = chosen.length > 1;
      const common = {
        facility_type: facilityType?.id, club: club?.id, add_ons: addons,
        name: form.name, phone: form.phone, email: form.email, notes: form.notes,
        coupon: applied?.code || '', verification_token: tokenValid ? token : undefined,
        payment: paymentRequest(mode),
        // The reservation this checkout is completing. Sending it is what
        // stops the customer's own hold reporting their slot as taken, and
        // what converts the hold into the booking on the way through.
        reservation: reservation?.token || undefined,
      };
      const res = await fetch(many ? '/api/order' : '/api/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(many
          ? { ...common, slots: chosen.map((c) => ({ date: c.date, time: c.time })) }
          : { ...common, date: slot?.date, time: slot?.time }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && (data?.reference || data?.order_reference)) {
        setDone(data);
        // A booking is always created; the payment is a separate outcome the
        // confirmation screen reports honestly rather than hiding.
        const outcome = data.payment || {};
        if (outcome.status === 'failed' || outcome.status === 'unavailable') {
          setError(outcome.detail || t('errors.paymentFailed'));
        }
      }
      else if (res.status === 409 && data?.needs_otp) {
        // A unique contact already exists - ask to verify and reuse it.
        setDup(data.duplicate || { field: 'contact', masked: '' });
        setOtpCode(''); setOtpMsg('');
      }
      else if (res.status === 409) {
        // Slot was taken between viewing and booking, or the reservation ran
        // out. Either way the cached view of that date is now wrong, so drop
        // it and ask them to pick again from the truth.
        chosen.forEach((c) => availInvalidate(club, facilityType, c.date));
        setError(data?.code === 'hold_expired'
          ? t('errors.holdExpired')
          : (data?.detail || t('errors.slotTaken')));
      } else setError(data?.detail || t('errors.generic'));
    } catch {
      setError(t('errors.unreachable'));
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="bw__success">
        <div className="bw__success-head">
          <div className="bw__success-burst">
            <svg className="bw__check" viewBox="0 0 52 52" aria-hidden="true">
              <circle className="bw__check-c" cx="26" cy="26" r="24" />
              <path className="bw__check-k" d="M14 27l8 8 16-18" />
            </svg>
            <span className="bw__success-ring" />
            <span className="bw__success-ring bw__success-ring--2" />
          </div>
          <div className="bw__success-htext">
            <h2 className="bw__success-title">{t('success.title')}</h2>
            <p className="bw__success-sub">
              {t('success.subtitle',
                { name: form.name ? `, ${form.name.split(' ')[0]}` : '' })}
            </p>
            <span className="bw__success-ref">{t('success.reference')}&nbsp;<strong>{done.reference || done.order_reference}</strong></span>
          </div>
        </div>

        <div className="bw__success-card">
          <div className="bw__success-grid">
            <div className="bw__sx-item"><span className="bw__sx-ic"><Droplet /></span><div><span>{t('success.facility')}</span><strong>{facilityType?.name}</strong></div></div>
            {(done.bookings?.length > 1 ? done.bookings : null) ? (
              <div className="bw__sx-item">
                <span className="bw__sx-ic"><Clock /></span>
                <div>
                  <span>{t('success.times', { count: done.bookings.length })}</span>
                  <ul className="bw__sx-times">
                    {done.bookings.map((b) => (
                      <li key={b.reference}>
                        <strong>{longDate(b.scheduled_date, locale)}</strong>
                        {' '}
                        <em><bdi>{fmtTime(b.scheduled_time)} - {fmtTime(b.end_time)}</bdi></em>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : slot && <div className="bw__sx-item"><span className="bw__sx-ic"><Clock /></span><div><span>{t('success.dateTime')}</span><strong>{longDate(slot.date, locale)}</strong><em><bdi>{fmtTime(slot.time)} - {fmtTime(slot.end)}</bdi></em></div></div>}
            <div className="bw__sx-item"><span className="bw__sx-ic"><Pin /></span><div><span>{t('success.club')}</span><strong>{club?.name}</strong><em>{[club?.address, club?.city].filter(Boolean).join(', ')}</em></div></div>
          </div>
          <div className="bw__success-foot">
            <div><span className="bw__success-fk">{t('common.total')}</span><strong className="bw__success-total"><Money amount={done.total_amount} currency={done.currency} /></strong></div>
            <PaidBadge payment={done.payment} currency={done.currency} />
          </div>
        </div>

        {/* A split hands back the links here and nowhere else: the raw tokens are
            never stored on the server, so this screen is the organizer's one
            chance to keep them. It saves them to this browser so the progress
            page can show them again. */}
        {done.payment?.method === 'split' && done.payment.status === 'started' && (
          <SplitHandoff result={done.payment} currency={done.currency} />
        )}

        {/* A declined card must not dead-end the customer. Their slot is held, so
            the honest thing is to let them try again right here. */}
        {['failed', 'partial'].includes(done.payment?.status) && done.checkout_token && (
          <RetryCard checkoutToken={done.checkout_token} config={payCfg}
            amount={done.payment.outstanding} currency={done.currency} />
        )}

        <button className="bw__success-cta" type="button" onClick={onReset}>{t('success.bookAnother')} <ArrowRight /></button>
      </div>
    );
  }

  const cur = quote?.currency || currency;
  const num = (v) => Number(v || 0);

  // The quote prices one slot; a checkout may hold several of them. The
  // backend remains authoritative and recomputes every slot on submit, so this
  // is what the customer is about to agree to, not what they will be charged
  // by some separate calculation.
  // The order total comes from the backend, which priced each slot on its own
  // date. Multiplying the first slot's price would be wrong the moment a
  // selection straddles the end of an offer.
  const perSlotTotal = quote?.summary?.total ?? quote?.total_amount ?? null;
  // Null until the backend answers. The catalogue price was standing in here
  // too, so the total moved once on arriving at this step.
  const bookingTotal = orderTotal(quote);
  const priceReady = bookingTotal !== null && bookingTotal !== undefined;
  const uniformPricing = slotsPriceAlike(quote);
  const shares = split.on && split.mode === 'equal'
    ? previewEqualSplit(bookingTotal, split.people)
    : split.custom.map((row) => row.amount);
  const myShare = split.on ? (shares[0] ?? 0) : bookingTotal;
  const pendingFromFriends = split.on
    ? Math.max(0, num(bookingTotal) - num(myShare)).toFixed(2)
    : '0.00';
  // A split where the organizer defers their own share collects nothing now, so
  // the button must not promise a payment that is not about to happen.
  const paysNow = !split.on || split.payMyShareNow;
  const needsCard = payMode === 'card' || (split.on && split.payMyShareNow);
  const contactLine = [form.name, form.phone, form.email].filter(Boolean).join(' · ');
  // Everything the promo, the rules and the loyalty discount took off the price,
  // so the customer can see the offer worked.
  // Stated only when every slot costs the same. With mixed prices the
  // per-slot adjustment cannot be multiplied out, and a wrong saving is worse
  // than none.
  const savings = uniformPricing
    ? (quote?.summary?.adjustments || [])
      .filter((a) => a.kind !== 'surcharge')
      .reduce((total, a) => total + num(a.amount), 0) * slotCount
    : 0;

  return (
    <div className="ck">
      <div className="ck__main">
        <HoldBanner reservation={reservation} onPickAgain={onEditBooking} />
        {/* 1. Your details. Collapses to a single line once it is done with, so
            the payment step is what the page is actually about. */}
        <section className="ck__sec">
          {detailsOpen ? (
            <form className="ck__form" onSubmit={(e) => e.preventDefault()}>
              <header className="ck__sec-head">
                <span className="ck__step">1</span>
                <h3 className="ck__sec-h">{t('checkout.detailsTitle')}</h3>
              </header>

              <div className="ck__field">
                <label htmlFor="ck-name">{t('checkout.fullName')} <i aria-hidden="true">*</i></label>
                <input id="ck-name" className={`ck__input${reqErr('name') ? ' is-invalid' : ''}`}
                  value={form.name} onChange={set('name')} placeholder={t('checkout.namePlaceholder')}
                  autoComplete="name" />
                {reqErr('name') && <span className="ck__field-err">{t('common.required')}</span>}
              </div>
              <div className="ck__field">
                <label htmlFor="ck-phone">
                  {t('checkout.mobile')}{' '}
                  {cfg.phone_required
                    ? <i aria-hidden="true">*</i>
                    : <em>{t('common.optional')}</em>}
                </label>
                <PhoneField value={form.phone} onChange={onPhone} invalid={phoneErr}
                  defaultCountry={phoneCountryFor(country)} />
                {phoneErr && (
                  <span className="ck__field-err">{t('checkout.invalidMobile')}</span>
                )}
              </div>
              <div className="ck__field">
                <label htmlFor="ck-email">
                  {t('checkout.email')}{' '}
                  {cfg.email_required
                    ? <i aria-hidden="true">*</i>
                    : <em>{t('common.optional')}</em>}
                </label>
                <input id="ck-email" className={`ck__input${emailErr ? ' is-invalid' : ''}`}
                  type="email" value={form.email} onChange={onEmail}
                  placeholder={t('checkout.emailPlaceholder')} autoComplete="email" />
                {emailErr && <span className="ck__field-err">{t('checkout.invalidEmail')}</span>}
              </div>

              <div className="ck__field">
                <label htmlFor="ck-notes">
                  {t('checkout.notes')} <em>{t('common.optional')}</em>
                </label>
                <textarea id="ck-notes" className="ck__input ck__textarea" rows={2}
                  value={form.notes} onChange={set('notes')}
                  placeholder={t('checkout.notesPlaceholder')} />
              </div>

              {dup && !token && (
                <div className="ck__otp">
                  <p className="ck__otp-h">
                    {t(dup.field === 'phone' ? 'otp.titlePhone' : 'otp.titleEmail')}
                  </p>
                  <p className="ck__otp-sub">
                    {t('otp.subtitle', { masked: dup.masked })}
                  </p>
                  <div className="ck__otp-row">
                    <input className="ck__input" value={otpCode} inputMode="numeric"
                      aria-label={t('otp.code')}
                      onChange={(e) => setOtpCode(e.target.value)} placeholder={t('otp.placeholder')} />
                    <button className="ck__otp-btn" type="button" onClick={verifyOtp}
                      disabled={otpBusy}>
                      {t(otpBusy ? 'otp.checking' : 'otp.verify')}
                    </button>
                  </div>
                  {otpMsg && <span className="ck__field-err">{otpMsg}</span>}
                </div>
              )}

              <button type="button" className="ck__continue"
                onClick={() => {
                  setShowErrors(true);
                  if (valid) { setDetailsOpen(false); setError(''); }
                }}>
                {t('checkout.continueToPayment')}
              </button>
            </form>
          ) : (
            <div className="ck__done-row">
              <span className="ck__tick" aria-hidden="true"><CheckIcon /></span>
              <div className="ck__done-tx">
                <strong>{t('checkout.detailsTitle')}</strong>
                <span>{contactLine}</span>
              </div>
              <button type="button" className="ck__edit"
                onClick={() => setDetailsOpen(true)}>{t('common.edit')}</button>
            </div>
          )}
        </section>

        {/* 2. Payment. */}
        <section className="ck__sec ck__sec--pay">
          <header className="ck__sec-head">
            <span className="ck__step">2</span>
            <h3 className="ck__sec-h">{t('checkout.paymentTitle')}</h3>
            <span className="ck__secure"><LockIcon /> {t('checkout.secure')}</span>
          </header>

          {/* Switched on, the split configuration leads: it decides how much the
              card below is about to be charged. */}
          {split.on && (
            <SplitPanel
              split={split}
              setSplit={setSplit}
              total={bookingTotal}
              currency={cur}
              disabled={busy}
              organizerName={form.name}
              holdMinutes={payCfg.split_minutes || 60}
            />
          )}

          <PaymentMethods
            method={method}
            config={payCfg}
            country={country}
            splitOn={split.on}
            heading={split.on ? 'Pay your share with' : undefined}
            onPick={(next) => { setMethod(next); setError(''); }}
          />

          {needsCard && payCfg.card_enabled && (
            <CardForm card={card} setCard={setCard} config={payCfg}
              disabled={busy} compact={split.on} />
          )}

          {payMode === 'cash' && (
            <p className="ck__venue-note">
              <ClockIcon /> {t('checkout.venueNote')}
            </p>
          )}

          {/* Switched off, the offer sits quietly at the foot of the section. */}
          {!split.on && payCfg.split_enabled && payCfg.card_enabled && (
            <SplitToggle on={false} disabled={busy}
              onChange={(next) => { setSplit((c) => ({ ...c, on: next })); setError(''); }} />
          )}

          {error && <p className="ck__error" role="alert">{error}</p>}
        </section>
      </div>

      <aside className="ck__rail">
        <div className="ck__sum">
          <div className="ck__sum-head">
            <span className="ck__sum-ic" aria-hidden="true"><Droplet /></span>
            <div className="ck__sum-title">
              <span className="ck__sum-eyebrow">{t('checkout.summary')}</span>
              <h3>{facilityType?.name || t('checkout.yourBooking')}</h3>
            </div>
            <button type="button" className="ck__edit" onClick={onEditBooking}>{t('common.edit')}</button>
          </div>

          <ul className="ck__sum-meta">
            <li><Pin /> <span>{club?.name}{club?.city ? `, ${club.city}` : ''}</span></li>
            {chosen.map((c) => (
              <li key={`${c.date}T${c.time}`}>
                <ClockIcon />
                <span>
                  <bdi>{longDate(c.date, locale)}</bdi>
                  {', '}
                  <bdi>{fmtTime(c.time)} - {fmtTime(c.end)}</bdi>
                  {facilityType?.duration_minutes
                    ? ` (${duration(facilityType.duration_minutes, t)})` : ''}
                </span>
              </li>
            ))}
            {/* The add-ons are not listed here: the price breakdown below
                names every one of them with its own amount, and saying them
                twice made the summary longer without saying anything more.
                They are only named here when there is no breakdown to fall
                back on. */}
            {selectedAddons.length > 0 && !quote?.summary && (
              <li><Sparkle /> <span>{selectedAddons.map((a) => a.name).join(', ')}</span></li>
            )}
          </ul>

          {/* Price breakdown: VAT-inclusive line prices, then the adjustments
              that moved the total, then the total itself. */}
          {quote?.summary ? (() => {
            const sm = quote.summary;
            return (
              <div className="ck__lines">
                {sm.items.map((it, i) => (
                  <div key={i} className="ck__line">
                    <span>{it.label}</span>
                    <span><Money amount={it.amount} currency={cur} /></span>
                  </div>
                ))}
                {sm.adjustments.map((a, i) => {
                  const off = a.kind !== 'surcharge';
                  return (
                    <div key={i} className={`ck__line${off ? ' ck__line--offer' : ''}`}>
                      <span>
                        {a.label}
                        {a.adjustment ? <em> ({a.adjustment})</em> : null}
                      </span>
                      <span>{off ? '- ' : '+ '}<Money amount={a.amount} currency={cur} /></span>
                    </div>
                  );
                })}
                {/* The lines above price one time. Saying so, and showing the
                    multiplier, is honest; restating every line N times is not. */}
                {slotCount > 1 && (
                  <div className="ck__line ck__line--sub">
                    <span>{t('checkout.perTime')}</span>
                    <span>&times; {slotCount}</span>
                  </div>
                )}
              </div>
            );
          })() : (
            <div className="ck__lines">
              <div className="ck__line">
                <span>{t('common.subtotal')}</span>
                <span><Money amount={quote?.subtotal ?? facilityType?.price} currency={cur} /></span>
              </div>
            </div>
          )}

          <PromoField
            applied={applied} coupon={coupon} setCoupon={setCoupon}
            onApply={applyCoupon} onRemove={removeCoupon}
            busy={couponBusy} message={couponMsg} currency={cur}
          />

          {split.on ? (
            <>
              <div className="ck__line ck__line--sub">
                <span>{t('checkout.bookingTotal')}</span>
                <span>
                  {priceReady
                    ? <Money amount={bookingTotal} currency={cur} />
                    : <PriceSkeleton />}
                </span>
              </div>
              <div className="ck__total">
                <div>
                  <span className="ck__total-k">{t('checkout.yourShare')}</span>
                  <span className="ck__total-sub">{t('checkout.playersOf', { count: split.people })}</span>
                </div>
                <div className="ck__total-v">
                  <strong><Money amount={myShare} currency={cur} /></strong>
                  <span className="ck__total-sub">
                    {t('checkout.pendingFromFriends',
                      { amount: `${cur} ${pendingFromFriends}` })}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="ck__total">
              <span className="ck__total-k">{t('common.total')}</span>
              <div className="ck__total-v">
                <strong>
                  {priceReady
                    ? <Money amount={bookingTotal} currency={cur} />
                    : <PriceSkeleton />}
                </strong>
                {quote?.summary && (
                  <span className="ck__total-sub">
                    {t('checkout.includesVat', {
                      percent: quote.summary.vat_percent,
                      amount: `${cur} ${quote.summary.vat_amount}`,
                    })}
                  </span>
                )}
                {savings > 0 && (
                  <span className="ck__total-save">
                    {t('checkout.youSave', { amount: `${cur} ${savings.toFixed(2)}` })}
                  </span>
                )}
              </div>
            </div>
          )}

          <button type="button" className="ck__pay" disabled={busy}
            onClick={() => onBook(payMode)}>
            {busy ? t('checkout.working') : (
              <>
                <LockIcon />
                {payMode === 'cash'
                  ? t('checkout.confirmBooking')
                  : split.on
                    ? (paysNow
                      ? t('checkout.payMyShare', { amount: `${cur} ${Number(myShare).toFixed(2)}` })
                      : t('checkout.createSplit'))
                    : priceReady
                      ? t('checkout.payAmount', { amount: `${cur} ${Number(bookingTotal).toFixed(2)}` })
                      : t('checkout.working')}
              </>
            )}
          </button>

          <p className="ck__legal">
            {t(split.on ? 'checkout.legalSplit'
              : payMode === 'cash' ? 'checkout.legalBook' : 'checkout.legalPay')}
          </p>
        </div>
      </aside>
    </div>
  );
}

/**
 * The promo code, behind a disclosure link.
 *
 * Most customers do not have one, and an always-open input invites them to go
 * looking for a code instead of finishing the booking. Once applied it stays
 * visible, because a discount the customer cannot see is a discount they will
 * ask about.
 */
function PromoField({ applied, coupon, setCoupon, onApply, onRemove, busy, message, currency }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (applied) {
    return (
      <div className="ck__promo-on">
        <span className="ck__promo-tag"><TagIcon /> {applied.code}</span>
        <span className="ck__promo-save">- <Money amount={applied.discount} currency={currency} /></span>
        <button type="button" className="ck__promo-x" onClick={onRemove}
          aria-label={t('checkout.removePromo')}>✕</button>
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" className="ck__promo-link" onClick={() => setOpen(true)}>
        {t('checkout.promoAsk')}
      </button>
    );
  }
  return (
    <div className="ck__promo">
      <div className="ck__promo-row">
        <input className="ck__input" value={coupon} placeholder={t('checkout.promoPlaceholder')}
          aria-label={t('checkout.promoPlaceholder')} autoFocus
          onChange={(e) => setCoupon(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onApply(); } }} />
        <button type="button" className="ck__promo-apply" onClick={onApply}
          disabled={!coupon.trim() || busy}>
          {busy ? '…' : t('common.apply')}
        </button>
      </div>
      {message && <p className="ck__promo-msg">{message}</p>}
    </div>
  );
}

/**
 * How the booking was settled, on the confirmation screen.
 *
 * Reports what actually happened rather than assuming success: a booking exists
 * either way, and telling somebody "paid" when their card was declined is the
 * one thing this screen must never do.
 */
function PaidBadge({ payment, currency }) {
  const { t } = useTranslation();
  const outcome = payment || {};
  if (outcome.status === 'paid') {
    // The card line is one text node rather than a bare string beside the
    // icon: as two flex items the label could be squeezed a word at a time
    // into a narrow column, which is how "Paid . visa ....4242" ended up
    // stacked on three lines.
    const brand = outcome.card_brand
      ? outcome.card_brand.charAt(0).toUpperCase() + outcome.card_brand.slice(1)
      : t('success.card');
    return (
      <span className="bw__success-pay is-paid">
        <CardIconSm aria-hidden="true" />
        <span className="bw__success-payt">
          {t('success.paid')}
          {outcome.card_last4 ? ` · ${brand} ····${outcome.card_last4}` : ''}
        </span>
      </span>
    );
  }
  if (outcome.status === 'started') {
    return (
      <span className="bw__success-pay is-split">
        <SplitIcon aria-hidden="true" />
        <span className="bw__success-payt">{t('success.splitInProgress')}</span>
      </span>
    );
  }
  if (outcome.status === 'partial') {
    // Some slots were charged and some were not. Calling this "failed" would
    // invite a second payment for times that are already settled.
    return (
      <span className="bw__success-pay is-failed">
        <span className="bw__success-payt">
          {t('success.partlyPaid', { paid: outcome.slots_paid, total: outcome.slots_total })}
        </span>
      </span>
    );
  }
  if (outcome.status === 'failed' || outcome.status === 'unavailable') {
    return (
      <span className="bw__success-pay is-failed">
        <span className="bw__success-payt">{t('success.notCompleted')}</span>
      </span>
    );
  }
  return (
    <span className="bw__success-pay">
      <CashIcon aria-hidden="true" />
      <span className="bw__success-payt">{t('success.cash')}</span>
    </span>
  );
}

const CardIconSm = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...p}>
    <rect x="2" y="5" width="20" height="14" rx="2.5" /><path d="M2 10h20" />
  </svg>
);

/**
 * The split links, handed over once.
 *
 * `localStorage` is the right home for these and a runtime store would be the
 * wrong one: they are bearer credentials that belong to this person on this
 * device, and the server deliberately keeps only digests. Wrapped in try/catch
 * because a private window can refuse storage outright, and a customer who
 * cannot save them must still be able to copy them off the screen.
 */
function SplitHandoff({ result, currency }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState('');
  const shares = result.split?.shares || [];
  const links = result.links || {};
  const countdown = useCountdown(result.split?.expires_at);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        `split:${result.manage_token}`,
        JSON.stringify({ links, saved: Date.now() }));
    } catch { /* private window: the links are still on screen */ }
  }, [result.manage_token, links]);

  const onShare = async (shareId, name, amount) => {
    const url = links[String(shareId)];
    if (!url) return;
    const message = t('handoff.shareMessage',
      { name: name || '', amount: formatMoney(amount, currency) });
    const outcome = await shareLink(url, message);
    if (outcome === 'copied') {
      setCopied(String(shareId));
      setTimeout(() => setCopied(''), 2000);
    }
  };

  return (
    <div className="bw__handoff">
      <div className="bw__handoff-head">
        <h3>{t('handoff.title')}</h3>
        {countdown && <span className="bw__handoff-clock">{t('handoff.within', { time: countdown })}</span>}
      </div>
      <p className="bw__handoff-note">
        {t('handoff.note')}
      </p>
      <ul className="bw__handoff-list">
        {shares.map((share) => {
          const tone = shareTone(share.status);
          const url = links[String(share.id)];
          return (
            <li key={share.id} className="bw__handoff-row">
              <div className="bw__handoff-who">
                <strong>{share.is_organizer ? 'You' : share.name}</strong>
                <span>{formatMoney(share.amount, currency)}</span>
              </div>
              <span className={`bw__handoff-state ${tone.className}`}>{tone.label}</span>
              {url ? (
                <div className="bw__handoff-acts">
                  <button type="button" onClick={async () => {
                    const outcome = await copyLink(url);
                    if (outcome === 'copied') {
                      setCopied(String(share.id));
                      setTimeout(() => setCopied(''), 2000);
                    }
                  }}>
                    {t(copied === String(share.id) ? 'handoff.copied' : 'handoff.copyLink')}
                  </button>
                  <button type="button"
                    onClick={() => onShare(share.id, share.name, share.amount)}>
                    {t('handoff.share')}
                  </button>
                </div>
              ) : <span className="bw__handoff-acts-none">{t('handoff.settled')}</span>}
            </li>
          );
        })}
      </ul>
      <a className="bw__handoff-manage" href={`/pay/split/manage/${result.manage_token}`}>
        {t('handoff.track')}
      </a>
      {result.organizer_payment?.status === 'failed' && (
        <p className="bw__det-error" role="alert">
          {t('handoff.organizerFailed', { detail: result.organizer_payment.detail })}
        </p>
      )}
    </div>
  );
}

/** Retry a declined card against the booking that was just created. */
function RetryCard({ checkoutToken, config, amount, currency }) {
  const { t } = useTranslation();
  const [card, setCard] = useState(blankCard());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [paid, setPaid] = useState(null);

  if (paid) {
    return (
      <div className="bw__retry is-done">
        <strong>{t('retry.received')}</strong>
        <span>{t('retry.receipt', { amount: formatMoney(paid.amount, currency), reference: paid.reference })}</span>
      </div>
    );
  }

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/split?scope=booking', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkout_token: checkoutToken, card: cardRequest(card) }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.status === 'paid') setPaid(data);
      else setError(data?.detail || t('errors.paymentFailed'));
    } catch {
      setError(t('errors.paymentUnreachable'));
    } finally { setBusy(false); }
  };

  return (
    <div className="bw__retry">
      <h3>{t('retry.title')}</h3>
      <p>{t('retry.body', { amount: formatMoney(amount, currency) })}</p>
      <CardForm card={card} setCard={setCard} config={config} disabled={busy} />
      {error && <p className="bw__det-error" role="alert">{error}</p>}
      <button type="button" className="bw__det-submit" disabled={busy} onClick={submit}>
        {busy ? t('retry.paying') : t('retry.pay', { amount: formatMoney(amount, currency) })}
      </button>
    </div>
  );
}
