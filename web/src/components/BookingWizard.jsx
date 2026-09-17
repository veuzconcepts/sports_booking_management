import { useEffect, useMemo, useState } from 'react';
import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js/max';
import PhoneField from './PhoneField.jsx';
import { phoneCountryFor } from '../utils/countries.js';

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
const STEPS = ['Category', 'Facility', 'Club', 'Schedule', 'Confirm'];
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
  return <>{sym} {v}</>;
}
// Distance between the visitor and a club (km), for "nearest" sorting.
function haversine(a, b) {
  if (!a || b.latitude == null || b.longitude == null) return null;
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.lat), dLng = toRad(b.longitude - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function duration(mins) {
  if (!mins) return '';
  if (mins < 60) return `${mins} min`;
  const h = Math.round((mins / 60) * 10) / 10;
  return `${h} hr${h > 1 ? 's' : ''}`;
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
const Shield = (p) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
);
const Warn = (p) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>
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
const CardIcon = (p) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/></svg>
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

export default function BookingWizard({ categories = [], facilityTypes = [], clubs = [], currency = '', city = '', country = '', placeholderLogo = '' }) {
  PLACEHOLDER_LOGO = placeholderLogo || '/logo.svg';
  const [step, setStep] = useState(0);
  const [category, setCategory] = useState(null);
  const [facilityType, setFacilityType] = useState(null);
  const [club, setClub] = useState(null);
  const [slot, setSlot] = useState(null);      // { date, time, end }
  const [addons, setAddons] = useState([]);    // selected add-on ids
  const [addonModal, setAddonModal] = useState(null);  // facility type whose add-ons modal is open
  const [query, setQuery] = useState('');
  const [restored, setRestored] = useState(false);
  // Confirm & Pay state lives here so it survives stepping back and forth.
  const [details, setDetails] = useState({ ...BLANK_DETAILS });
  const [pay, setPay] = useState({ method: 'card', coupon: '', applied: null });
  const [bookingDone, setBookingDone] = useState(null);

  // Start a brand-new booking after a confirmed one.
  const reset = () => {
    setCategory(null); setFacilityType(null); setClub(null); setSlot(null); setAddons([]);
    setDetails({ ...BLANK_DETAILS }); setPay({ method: 'card', coupon: '', applied: null });
    setBookingDone(null); setQuery(''); go(0);
  };

  const catFacilityTypes = useMemo(
    () => (category ? facilityTypes.filter((s) => (s.category_ids || []).includes(category.id)) : []),
    [category, facilityTypes],
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
    if (sd && st && se) { restoredSlot = { date: sd, time: st, end: se }; setSlot(restoredSlot); }
    // Clamp the requested step to what the restored selections actually unlock.
    const maxReach = cat ? (svc ? (br ? (restoredSlot ? 4 : 3) : 2) : 1) : 0;
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
    if (category && step >= 1) params.set('category', String(category.id));
    if (facilityType && step >= 2) params.set('facilityType', String(facilityType.id));
    if (addons.length && step >= 2) params.set('a', addons.join(','));
    if (club && step >= 3) params.set('club', String(club.id));
    if (slot && step >= 4) {
      params.set('d', slot.date); params.set('t', slot.time); params.set('e', slot.end);
    }
    if (step > 0) params.set('step', String(step));
    const qs = params.toString();
    window.history.replaceState({}, '', qs ? `?${qs}` : window.location.pathname);
  }, [step, category, facilityType, addons, club, slot, restored, bookingDone]);

  const go = (n) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));
  const pickCategory = (c) => { setCategory(c); setFacilityType(null); setSlot(null); setAddons([]); go(1); };
  // Picking a facility type opens the add-ons modal (if any), else goes to the club step.
  const pickFacilityType = (s) => {
    setFacilityType(s); setSlot(null); setAddons([]); setBookingDone(null);
    if (s.add_ons?.length) setAddonModal(s); else go(2);
  };
  const confirmAddons = (ids) => { setAddons(ids); setAddonModal(null); go(2); };
  // Selecting a club auto-advances to scheduling.
  const pickClub = (b) => { setClub(b); setSlot(null); go(3); };

  // Which timeline steps the user may jump to (only ones already unlocked).
  const reachable = (i) => i === 0 || (i === 1 && !!category) || (i === 2 && !!facilityType)
    || (i === 3 && !!club) || (i === 4 && !!slot);
  const jump = (i) => { if (reachable(i)) go(i); };

  const TITLES = {
    1: ['Select Facility', `Pick the ${category?.name?.toLowerCase() || 'facility'} you want to book`],
    2: ['Choose a Club', 'Where would you like to play?'],
    3: ['Pick a Date & Time', "Choose a slot that suits you - we'll be there."],
    4: ['Confirm & Pay', 'Add your details, review the price and choose how to pay.'],
  };

  return (
    <div className="bw">
      {step > 0 && !bookingDone && (
        <div className="bw__head">
          <button className="bw__back" type="button" onClick={() => go(step - 1)} aria-label="Back">
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
        {step === 0 && (
          <Categories categories={categories} onPick={pickCategory} />
        )}
        {step === 1 && (
          <FacilityTypes list={catFacilityTypes} currency={currency} onPick={pickFacilityType} />
        )}
        {step === 2 && (
          <Location
            clubs={filteredClubes} query={query} setQuery={setQuery}
            club={club} onChoose={pickClub} city={country || city}
          />
        )}
        {step === 3 && (
          <Schedule
            facilityType={facilityType} category={category} club={club} currency={currency}
            value={slot} onChange={setSlot} onContinue={() => go(4)}
          />
        )}
        {step === 4 && (
          <Details
            facilityType={facilityType} category={category} club={club} slot={slot} currency={currency}
            addons={addons}
            details={details} setDetails={setDetails} pay={pay} setPay={setPay}
            done={bookingDone} setDone={setBookingDone} onReset={reset}
          />
        )}
      </div>

      {addonModal && (
        <AddOnsModal facilityType={addonModal} currency={currency}
          onClose={() => setAddonModal(null)} onConfirm={confirmAddons} />
      )}
    </div>
  );
}

function Progress({ step, reachable, onJump }) {
  return (
    <ol className="bw__steps" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
      {STEPS.map((label, i) => {
        const state = i < step ? 'done' : i === step ? 'active' : 'todo';
        const can = reachable(i) && i !== step;
        return (
          <li key={label} className={`bw__step bw__step--${state}`}>
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

function Categories({ categories, onPick }) {
  return (
    <div className="bw__cats-wrap">
      <h1 className="bw__cats-title">What would you like to book?</h1>
      <div className="bw__cats">
        {categories.map((c) => (
          <button key={c.id} type="button" className="bw__cat" onClick={() => onPick(c)}>
            {c.banner || c.icon
              ? <img src={c.banner || c.icon} alt={c.name} loading="lazy" />
              : <span className="bw__cat-ph"><img src={PLACEHOLDER_LOGO} alt={c.name} /></span>}
            <span className="bw__cat-overlay" />
            {c.badge && <span className="bw__cat-badge">{c.badge}</span>}
            <span className="bw__cat-name">{c.name}</span>
            <span className="bw__cat-hover">
              <span className="bw__cat-htitle">{c.name}</span>
              {c.description && <span className="bw__cat-desc bw__rte" dangerouslySetInnerHTML={{ __html: c.description }} />}
              {c.kind_display && (
                <span className="bw__cat-meta"><Droplet /> {c.kind_display}</span>
              )}
              <span className="bw__cat-action">Explore facilities <Arrow /></span>
            </span>
          </button>
        ))}
      </div>
      <p className="bw__hint">Tap a category to explore our facilities</p>
    </div>
  );
}

function FacilityMedia({ s }) {
  if (s.video) return <video src={s.video} muted loop autoPlay playsInline preload="metadata" />;
  if (s.image) return <img src={s.image} alt={s.name} loading="lazy" />;
  return <span className="bw__fac-ph"><img src={PLACEHOLDER_LOGO} alt={s.name} /></span>;
}

function Chips({ s, currency }) {
  return (
    <>
      {s.available_in_rta_parking
        ? <span className="bw__chip bw__chip--ok"><Check /> Available in RTA Parking Zones</span>
        : <span className="bw__chip bw__chip--warn"><Warn /> Not Available in RTA Parking Zones</span>}
      {Number(s.damage_cover_amount) > 0 && (
        <span className="bw__chip"><Shield /> <Price amount={s.damage_cover_amount} currency={currency} /> damage cover</span>
      )}
    </>
  );
}

function FacilityCard({ s, currency, onPick, onMore }) {
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
            
            {s.duration_minutes ? <span className="bw__tag"><Clock /> {duration(s.duration_minutes)}</span> : null}
          </div>
          <div className="bw__fac-price"><strong><Price amount={s.from_price} currency={currency} /></strong> <VatNote inclusive={s.tax_inclusive} /></div>
          {(s.description || s.whats_included) && (
            <div className="bw__fac-descrow">
              {s.description && <p className="bw__fac-desc">{s.description}</p>}
              {s.whats_included && (
                <button className="bw__fac-more" type="button"
                  onClick={(e) => { e.stopPropagation(); onMore(s); }}>
                  <Sparkle /> What's Included <Arrow />
                </button>
              )}
            </div>
          )}
        </div>
        <span className="bw__fac-cta" aria-hidden="true"><ArrowRight /></span>
      </div>
      <div className="bw__fac-foot"><Chips s={s} currency={currency} /></div>
    </article>
  );
}

// "Where it's performed" groups - At your location first, then center options;
// facility types with no club set are shown last, under a separator.
const PERFORMED_GROUPS = [
  { key: 'at_location', label: 'At your location', icon: Pin },
  { key: 'both', label: 'Center or your location', icon: Pin },

];

function FacilityTypes({ list, currency, onPick }) {
  const [detail, setDetail] = useState(null);
  if (list.length === 0) {
    return <p className="bw__empty">No facilities available in this category yet.</p>;
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
              <div className="bw__fac-sep"><span>More facilities</span></div>
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
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  return (
    <div className="bw__modal" role="dialog" aria-modal="true" aria-label={s.name} onClick={onClose}>
      <div className="bw__modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="bw__modal-close" type="button" onClick={onClose} aria-label="Close"><Close /></button>
        <div className="bw__modal-media">
          <FacilityMedia s={s} />
          <div className="bw__modal-media-tag">
            <strong><Price amount={s.from_price} currency={currency} /></strong><VatNote inclusive={s.tax_inclusive} />
          </div>
        </div>
        <div className="bw__modal-right">
          <div className="bw__modal-scroll">
            <h3 className="bw__modal-title">{s.name}{s.tagline && <em> - {s.tagline}</em>}</h3>
            <div className="bw__modal-meta">
              {s.duration_minutes ? <span className="bw__time"><Clock /> {duration(s.duration_minutes)}</span> : null}
              {s.badge_display && <span className="bw__time"><Bolt /> {s.badge_display}</span>}
              
            </div>
            <div className="bw__modal-chips"><Chips s={s} currency={currency} /></div>
            <h4 className="bw__modal-sub"><Sparkle /> What's Included</h4>
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
            <button className="bw__modal-close-btn" type="button" onClick={onClose}>Close</button>
            <button className="bw__modal-select" type="button" onClick={() => onSelect(s)}>Select Facility <ArrowRight /></button>
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

function AddOnsModal({ facilityType, currency, onClose, onConfirm }) {
  const list = facilityType?.add_ons || [];
  const [selected, setSelected] = useState([]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);
  const toggle = (id) => setSelected(
    selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id],
  );
  const count = selected.length;
  return (
    <div className="bw__modal" role="dialog" aria-modal="true" aria-label="Add-ons" onClick={onClose}>
      <div className="bw__modal-card bw__addon-modal" onClick={(e) => e.stopPropagation()}>
        <button className="bw__modal-close" type="button" onClick={onClose} aria-label="Close"><Close /></button>
        <div className="bw__addon-head">
          <span className="bw__cal-eyebrow"><Sparkle /> Recommended add-ons</span>
          <h3>Boost your {facilityType?.name}</h3>
          <p>Optional extras - pick any you'd like, or continue without.</p>
        </div>
        <div className="bw__addon-scroll">
          <div className="bw__addon-grid">
            {list.map((a) => {
              const on = selected.includes(a.id);
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
        </div>
        <div className="bw__modal-foot">
          <button type="button" className="bw__modal-close-btn" onClick={() => onConfirm([])}>Skip</button>
          <button type="button" className="bw__modal-select" onClick={() => onConfirm(selected)}>
            Continue{count ? ` · ${count} add-on${count > 1 ? 's' : ''}` : ''} <ArrowRight />
          </button>
        </div>
      </div>
    </div>
  );
}

function Location({ clubs, query, setQuery, club, onChoose, city }) {
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
          <h2>Let's bring the shine to your doorstep</h2>
        </div>
        <p>Tell us where you are in <strong>{place}</strong> and we'll match you with the nearest club.</p>
      </div>

      <div className="bw__loc-search">
        <Pin />
        <input
          type="text" value={query} aria-label="Search club"
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
        {geo === 'ok' && <span className="bw__geo-ok"><Check /> Nearest clubs first</span>}
        {geo === 'denied' && <span className="bw__geo-note">Allow location access to see the closest club.</span>}
      </div>

      {!searching && (
        <>
          <div className="bw__loc-listhead">
            <span>Nearest clubs</span>
            {list.length > shown.length && <span className="bw__loc-listhint">Search to see all {list.length}</span>}
          </div>
          <div className="bw__loc-list">
            {shown.length === 0 && <p className="bw__empty">No clubs available yet.</p>}
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
                <span className="bw__club-check" aria-hidden="true">✓</span>
              </button>
            ))}
          </div>
        </>
      )}

      <p className="bw__loc-note">ⓘ We currently serve across {place}</p>
    </div>
  );
}

const longDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
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
const availInvalidate = (club, facilityType, date) =>
  _availCache.delete(_availKey(club, facilityType, date));

function Schedule({ facilityType, category, club, currency, value, onChange, onContinue }) {
  const today = startOfToday();
  const [view, setView] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [date, setDate] = useState(() => isoDate(today));
  const [data, setData] = useState(
    () => _availCache.get(_availKey(club, facilityType, isoDate(today))) || null);
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

  const is24 = data?.time_format_24h;
  const weekdays = data?.weekdays || {};
  const selectedTime = value && value.date === date ? value.time : null;

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
  const dayOff = (d) => d < firstAllowed
    || (latest && d > latest)
    || weekdays[WK[d.getDay()]]?.closed;
  const todayIso = isoDate(today);

  return (
    <div className="bw__cal">
      {/* LEFT - your selection */}
      <div className="bw__cal-info">
        <span className="bw__cal-eyebrow">Your booking</span>
        <h3 className="bw__cal-title">{facilityType?.name || 'Your booking'}</h3>
        {facilityType?.tagline && <p className="bw__cal-tagline">{facilityType.tagline}</p>}
        <ul className="bw__cal-meta">
          {facilityType?.duration_minutes ? <li><Clock /> {duration(facilityType.duration_minutes)}</li> : null}
          <li><Pin /> {club?.name}{club?.city ? `, ${club.city}` : ''}</li>
        </ul>
        <div className="bw__cal-sep" />
        {value && (
          <div className="bw__cal-appt">
            <span>Appointment</span>
            <strong>{longDate(value.date)}<br />{fmtTime(value.time, is24)} – {fmtTime(value.end, is24)}</strong>
          </div>
        )}
        <div className="bw__cal-total">
          <span>Total</span>
          <strong><Price amount={facilityType?.from_price} currency={currency} /></strong>
        </div>

        <p className="bw__cal-pay"><Clock /> Payment upon completion</p>
      </div>

      {/* CENTER - month calendar */}
      <div className="bw__cal-main">
        <div className="bw__cal-monthbar">
          <button type="button" disabled={atMin} aria-label="Previous month"
            onClick={() => setView(new Date(y, m - 1, 1))}><Chevron dir="left" /></button>
          <span className="bw__cal-month">{view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
          <button type="button" disabled={atMax} aria-label="Next month"
            onClick={() => setView(new Date(y, m + 1, 1))}><Chevron dir="right" /></button>
        </div>
        <div className="bw__dow">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <span key={d}>{d}</span>)}
        </div>
        <div className="bw__month">
          {cells.map((d, i) => {
            if (!d) return <span key={`b${i}`} className="bw__day bw__day--blank" />;
            const iso = isoDate(d);
            const off = dayOff(d);
            const active = iso === date;
            const isToday = iso === todayIso;
            return (
              <button key={iso} type="button" disabled={off}
                className={`bw__day${active ? ' is-active' : off ? ' is-off' : ' is-open'}${isToday && !active && !off ? ' is-today' : ''}`}
                onClick={() => setDate(iso)}>{d.getDate()}</button>
            );
          })}
        </div>
      </div>

      {/* RIGHT - times for the selected date */}
      <div className="bw__cal-times">
        <div className="bw__cal-timehead">{longDate(date)}</div>
        <div className="bw__time-list">
          {loading ? <p className="bw__sch-loading">Loading…</p>
            : data?.closed ? <p className="bw__cal-none">Closed on this day - pick another date.</p>
              : data?.slots?.length ? data.slots.map((s) => {
                const off = s.available <= 0;
                const sel = selectedTime === s.time;
                const tone = off ? ' is-off' : ' is-cool';
                return (
                  <div key={s.time} className={`bw__time-row${sel ? ' is-sel' : ''}`}>
                    <button type="button" className={`bw__time${sel ? ' is-sel' : tone}`} disabled={off}
                      onClick={() => onChange({ date, time: s.time, end: s.end })}>
                      <span className="bw__time-t">{fmtTime(s.time, is24)}</span>
                      {off ? <span className="bw__time-tag">Fully booked</span>
                        : null}
                    </button>
                    <button type="button" className="bw__time-go" tabIndex={sel ? 0 : -1}
                      aria-hidden={!sel} onClick={onContinue}>Continue</button>
                  </div>
                );
              }) : <p className="bw__cal-none">No times available - pick another date.</p>}
        </div>
      </div>
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
  return <>{sym} {v}</>;
}

function Details({ facilityType, category, club, slot, currency, addons = [], details, setDetails, pay, setPay, done, setDone, onReset }) {
  const selectedAddons = (facilityType?.add_ons || []).filter((a) => addons.includes(a.id));
  // Form + payment state live in the parent so they survive navigating away
  // and back to this step (until the booking is completed).
  const form = details;
  const { method, coupon, applied } = pay;          // applied = { code, discount }
  const set = (k) => (e) => setDetails((f) => ({ ...f, [k]: e.target.value }));
  const setMethod = (m) => setPay((p) => ({ ...p, method: m }));
  const setCoupon = (v) => setPay((p) => ({ ...p, coupon: v }));
  const setApplied = (a) => setPay((p) => ({ ...p, applied: a }));
  const [couponMsg, setCouponMsg] = useState('');
  const [couponBusy, setCouponBusy] = useState(false);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showErrors, setShowErrors] = useState(false);   // reveal field errors on submit

  // Contact rules (Booking Configuration → Website). Default to required so the
  // form stays strict until the live config loads.
  const [cfg, setCfg] = useState({ email_required: true, phone_required: true, email_unique: false, phone_unique: false });
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

  const loadQuote = (code) => fetch('/api/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility_type: facilityType?.id, club: club?.id, add_ons: addons, coupon: code || '' }),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  // Initial price breakdown (re-applies a coupon kept from before navigating away).
  useEffect(() => { loadQuote(applied?.code || '').then((q) => q && setQuote(q)); /* eslint-disable-next-line */ }, []);

  async function applyCoupon() {
    const code = coupon.trim();
    if (!code || couponBusy) return;
    setCouponBusy(true); setCouponMsg('');
    const q = await loadQuote(code);
    setCouponBusy(false);
    if (!q) { setCouponMsg('Couldn’t check that code - please try again'); return; }
    setQuote(q);
    if (q.coupon?.applied) { setApplied({ code: q.coupon.code, discount: q.coupon.discount }); setCouponMsg(''); }
    else { setApplied(null); setCouponMsg(q.coupon?.message || 'This coupon can’t be applied.'); }
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
    if (!valid) { setError('Please complete the highlighted fields'); return; }
    setError('');
    if (mode === 'card') {
      setError('Online card payment is coming soon - choose Cash to confirm your booking now.');
      return;
    }
    book();
  }

  async function book() {
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facility_type: facilityType?.id, club: club?.id, add_ons: addons, date: slot?.date, time: slot?.time,
          name: form.name, phone: form.phone, email: form.email, notes: form.notes,
          coupon: applied?.code || '', verification_token: tokenValid ? token : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.reference) setDone(data);
      else if (res.status === 409 && data?.needs_otp) {
        // A unique contact already exists - ask to verify and reuse it.
        setDup(data.duplicate || { field: 'contact', masked: '' });
        setOtpCode(''); setOtpMsg('');
      }
      else if (res.status === 409) {
        // Slot was taken between viewing and booking - drop the stale cache so
        // re-opening the date shows the truth, and ask them to pick again.
        availInvalidate(club, facilityType, slot?.date);
        setError(data?.detail || 'That time was just booked by someone else - please go back and pick another slot');
      } else setError(data?.detail || 'Something went wrong - please try again');
    } catch {
      setError('Couldn’t reach the booking service - please try again');
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
            <h2 className="bw__success-title">Booking Confirmed</h2>
            <p className="bw__success-sub">Thank you{form.name ? `, ${form.name.split(' ')[0]}` : ''} - our team will reach out shortly to confirm.</p>
            <span className="bw__success-ref">Reference&nbsp;<strong>{done.reference}</strong></span>
          </div>
        </div>

        <div className="bw__success-card">
          <div className="bw__success-grid">
            <div className="bw__sx-item"><span className="bw__sx-ic"><Droplet /></span><div><span>Facility</span><strong>{facilityType?.name}</strong></div></div>
            {slot && <div className="bw__sx-item"><span className="bw__sx-ic"><Clock /></span><div><span>Date &amp; time</span><strong>{longDate(slot.date)}</strong><em>{fmtTime(slot.time)} – {fmtTime(slot.end)}</em></div></div>}
            <div className="bw__sx-item"><span className="bw__sx-ic"><Pin /></span><div><span>Club</span><strong>{club?.name}</strong><em>{[club?.address, club?.city].filter(Boolean).join(', ')}</em></div></div>
          </div>
          <div className="bw__success-foot">
            <div><span className="bw__success-fk">Total</span><strong className="bw__success-total"><Money amount={done.total_amount} currency={done.currency} /></strong></div>
            <span className="bw__success-pay"><CashIcon /> Cash · pay on completion</span>
          </div>
        </div>


        <button className="bw__success-cta" type="button" onClick={onReset}>Book another facility <ArrowRight /></button>
      </div>
    );
  }

  const cur = quote?.currency || currency;
  const num = (v) => Number(v || 0);

  return (
    <div className="bw__det">
      <form className="bw__det-form" onSubmit={(e) => e.preventDefault()}>
        <section className="bw__det-sec">
          <h4 className="bw__det-h"><Pin /> Your details</h4>
          <div className="bw__field">
            <label>Full name <i>*</i></label>
            <input className={`bw__input${reqErr('name') ? ' is-invalid' : ''}`} value={form.name}
              onChange={set('name')} placeholder="e.g. Layla Ahmed" />
            {reqErr('name') && <span className="bw__field-err">Required</span>}
          </div>
          <div className="bw__field">
            <label>Mobile number {cfg.phone_required ? <i>*</i> : <em>(optional)</em>}</label>
            <PhoneField value={form.phone} onChange={onPhone} invalid={phoneErr}
              defaultCountry={phoneCountryFor(country)} />
            {phoneErr && <span className="bw__field-err">Enter a valid mobile number for the selected country</span>}
          </div>
          <div className="bw__field">
            <label>Email {cfg.email_required ? <i>*</i> : <em>(optional)</em>}</label>
            <input className={`bw__input${emailErr ? ' is-invalid' : ''}`} type="email" value={form.email}
              onChange={onEmail} placeholder="you@example.com" />
            {emailErr && <span className="bw__field-err">Enter a valid email address</span>}
          </div>

          {dup && !token && (
            <div className="bw__otp">
              <p className="bw__otp-h">We already have an account for this {dup.field === 'phone' ? 'mobile number' : 'email'}</p>
              <p className="bw__otp-sub">
                Enter the code we sent to <em>{dup.masked}</em> to continue with your existing details.
              </p>
              <div className="bw__otp-row">
                <input className="bw__input" value={otpCode} inputMode="numeric"
                  onChange={(e) => setOtpCode(e.target.value)} placeholder="6-digit code" />
                <button className="bw__otp-btn" type="button" onClick={verifyOtp} disabled={otpBusy}>
                  {otpBusy ? 'Checking…' : 'Verify'}
                </button>
              </div>
              {otpMsg && <span className="bw__field-err">{otpMsg}</span>}
            </div>
          )}
        </section>

        <section className="bw__det-sec">
          <h4 className="bw__det-h"><Clock /> Anything we should know?</h4>
          <div className="bw__field">
            <label>Notes <em>(optional)</em></label>
            <textarea className="bw__input bw__textarea" rows={3} value={form.notes} onChange={set('notes')}
              placeholder="Coaching request, equipment needed, accessibility…" />
          </div>
        </section>
      </form>

      <aside className="bw__pay">
        <span className="bw__cal-eyebrow">Booking summary</span>
        <h3 className="bw__cal-title">{facilityType?.name || 'Your booking'}</h3>
        <ul className="bw__cal-meta">
          {facilityType?.duration_minutes ? <li><Clock /> {duration(facilityType.duration_minutes)}</li> : null}
          <li><Pin /> {club?.name}{club?.city ? `, ${club.city}` : ''}</li>
          {slot ? <li><Sun /> {longDate(slot.date)}, {fmtTime(slot.time)}–{fmtTime(slot.end)}</li> : null}
          {selectedAddons.length > 0 && <li><Sparkle /> {selectedAddons.map((a) => a.name).join(', ')}</li>}
        </ul>

        {/* Coupon */}
        <div className="bw__coupon">
          {applied ? (
            <div className="bw__coupon-on">
              <span className="bw__coupon-tag"><TagIcon /> {applied.code}</span>
              <span className="bw__coupon-save">− <Money amount={applied.discount} currency={cur} /></span>
              <button type="button" className="bw__coupon-x" onClick={removeCoupon} aria-label="Remove coupon">✕</button>
            </div>
          ) : (
            <div className="bw__coupon-row">
              <span className="bw__coupon-ic"><TagIcon /></span>
              <input className="bw__coupon-in" value={coupon} placeholder="Promo code"
                onChange={(e) => setCoupon(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); } }} />
              <button type="button" className="bw__coupon-apply" onClick={applyCoupon} disabled={!coupon.trim() || couponBusy}>
                {couponBusy ? '…' : 'Apply'}
              </button>
            </div>
          )}
          {couponMsg && <p className="bw__coupon-msg">{couponMsg}</p>}
        </div>

        {/* Price breakdown - enterprise B2C order summary: VAT-inclusive line
            prices, then Subtotal → Discounts → Total, with VAT disclosed. */}
        {quote?.summary ? (() => {
          const sm = quote.summary;
          const savings = sm.adjustments
            .filter((a) => a.kind !== 'surcharge')
            .reduce((t, a) => t + num(a.amount), 0);
          return (
            <div className="bw__bd">
              {sm.items.map((it, i) => (
                <div key={i} className="bw__bd-row bw__bd-item">
                  <span>{it.label}</span><span><Money amount={it.amount} currency={cur} /></span>
                </div>
              ))}
              <div className="bw__bd-row bw__bd-sub">
                <span>Subtotal</span><span><Money amount={sm.items_subtotal} currency={cur} /></span>
              </div>
              {sm.adjustments.map((a, i) => {
                const off = a.kind !== 'surcharge';
                return (
                  <div key={i} className={`bw__bd-row${off ? ' bw__bd-row--offer' : ''}`}>
                    <span>{off ? <TagIcon /> : null} {a.label}{a.adjustment ? <em className="bw__bd-adj"> ({a.adjustment})</em> : null}</span>
                    <span>{off ? '− ' : '+ '}<Money amount={a.amount} currency={cur} /></span>
                  </div>
                );
              })}
              <div className="bw__bd-total">
                <span>Total <em className="bw__bd-vatin">(incl. VAT)</em></span>
                <strong><Money amount={sm.total} currency={cur} /></strong>
              </div>
              <div className="bw__bd-foot">
                <span className="bw__bd-vatnote">Includes VAT ({sm.vat_percent}%) · <Money amount={sm.vat_amount} currency={cur} /></span>
                {savings > 0 && <span className="bw__bd-save">You save <Money amount={savings} currency={cur} /></span>}
              </div>
            </div>
          );
        })() : (
          <div className="bw__bd">
            <div className="bw__bd-row"><span>Subtotal</span><span><Money amount={quote?.subtotal ?? facilityType?.from_price} currency={cur} /></span></div>
            <div className="bw__bd-total"><span>Total</span><strong><Money amount={quote?.total_amount ?? facilityType?.from_price} currency={cur} /></strong></div>
          </div>
        )}

        {/* Payment method */}
        <div className="bw__pm">
          <span className="bw__pm-h">Payment method</span>
          <div className="bw__pm-grid">
            <button type="button" className={`bw__pm-opt${method === 'card' ? ' is-on' : ''}`} onClick={() => { setMethod('card'); setError(''); }}>
              <CardIcon /><span>Card</span>
            </button>
            <button type="button" className={`bw__pm-opt${method === 'cash' ? ' is-on' : ''}`} onClick={() => { setMethod('cash'); setError(''); }}>
              <CashIcon /><span>Cash</span>
            </button>
          </div>
        </div>

        {error && <p className="bw__det-error">{error}</p>}

        {method === 'card' ? (
          <button type="button" className="bw__det-submit" disabled={busy} onClick={() => onBook('card')}>
            {busy ? 'Checking…' : <>Complete Payment <ArrowRight /></>}
          </button>
        ) : (
          <>
            <button type="button" className="bw__det-submit" disabled={busy} onClick={() => onBook('cash')}>
              {busy ? 'Booking…' : <>Book Now <ArrowRight /></>}
            </button>
            <p className="bw__pay-note"><Clock /> Pay cash upon completion.</p>
          </>
        )}
      </aside>
    </div>
  );
}
