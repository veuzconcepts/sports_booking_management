import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { I18n } from '../i18n/client.jsx';

/**
 * A live look at what is actually free, on the homepage.
 *
 * It reads the same availability endpoint the booking wizard uses, through the
 * same same-origin proxy, so a slot shown here is a slot the booking engine
 * will honour. Nothing is computed in the browser: opening hours, breaks,
 * closures, special dates, lead time and the booking horizon are all resolved
 * server-side, and this only renders the answer.
 *
 * Choosing a slot hands off to the existing wizard with the club, facility type
 * and slot already filled in. It never books anything itself.
 */

const DAYS_SHOWN = 7;
const MAX_SLOTS = 8;

function isoDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
}

function nextDays(count) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(today);
    day.setDate(today.getDate() + i);
    return day;
  });
}

/** "14:30" -> "2:30 pm", unless the organization works in 24-hour time. */
function label(time, is24) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  if (is24) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

export default function AvailabilityPreview({ locale, ...props }) {
  return <I18n locale={locale}><Availability {...props} /></I18n>;
}

function Availability({ clubs = [], facilityTypes = [] }) {
  const { t } = useTranslation();
  const days = useMemo(() => nextDays(DAYS_SHOWN), []);
  const [club, setClub] = useState(clubs[0]?.id ? String(clubs[0].id) : '');
  const [type, setType] = useState(facilityTypes[0]?.id ? String(facilityTypes[0].id) : '');
  const [date, setDate] = useState(() => isoDate(days[0]));
  const [data, setData] = useState(null);
  const [state, setState] = useState('idle');     // idle | loading | ready | error

  useEffect(() => {
    if (!club) { setState('idle'); return undefined; }
    let cancelled = false;
    setState('loading');
    const query = new URLSearchParams({ club, date });
    if (type) query.set('facility_type', type);
    fetch(`/api/availability?${query.toString()}`)
      .then((response) => response.json())
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setState('ready');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [club, type, date]);

  // `available` is the number of free facilities, not a flag: a slot with none
  // left is fully booked and must not be offered. Number() handles both a count
  // and a plain boolean.
  const slots = (data?.slots || [])
    .filter((slot) => Number(slot.available) > 0)
    .slice(0, MAX_SLOTS);
  const is24 = data?.time_format_24h;
  const weekdays = data?.weekdays || {};
  // The club's booking policy travels with availability, so a day the server
  // would refuse (too soon, or past the horizon) is never offered here either.
  const bookingWindow = data?.window || null;

  /** Hand the whole selection to the wizard rather than half of it. */
  function bookingHref(slot) {
    const chosen = facilityTypes.find((t) => String(t.id) === String(type));
    const category = chosen ? (chosen.category_ids || [])[0] : null;
    const params = new URLSearchParams({ club, d: date });
    if (chosen) params.set('facilityType', String(chosen.id));
    if (category) params.set('category', String(category));
    if (slot?.time) params.set('t', slot.time);
    if (slot?.end) params.set('e', slot.end);
    // The wizard clamps this to what the selections unlock: with a sport, a
    // facility type and a club it can open straight on Date & Time, and a whole
    // slot takes it to the summary.
    if (category && chosen && club) params.set('step', slot?.time ? '4' : '3');
    return `/book?${params.toString()}`;
  }

  if (!clubs.length) return null;

  return (
    <div className="avail">
      <div className="avail__bar">
        <label className="sr-only" htmlFor="av-club">Club</label>
        <select className="avail__select" id="av-club" value={club}
          onChange={(e) => setClub(e.target.value)}>
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.city ? `${c.name} - ${c.city}` : c.name}
            </option>
          ))}
        </select>

        {facilityTypes.length > 0 && (
          <>
            <label className="sr-only" htmlFor="av-type">{t('availability.facility')}</label>
            <select className="avail__select" id="av-type" value={type}
              onChange={(e) => setType(e.target.value)}>
              {facilityTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </>
        )}
      </div>

      <div className="avail__panel">
        <div className="avail__days" role="group" aria-label={t('availability.chooseDay')}>
          {days.map((day) => {
            const iso = isoDate(day);
            // The endpoint reports which weekdays the venue opens at all, so a
            // closed day is visibly closed rather than silently empty.
            const key = day.toLocaleDateString('en', { weekday: 'short' }).toLowerCase();
            const shut = weekdays[key]?.closed === true
              || (bookingWindow?.earliest_date && iso < bookingWindow.earliest_date)
              || (bookingWindow?.latest_date && iso > bookingWindow.latest_date);
            return (
              <button
                key={iso}
                type="button"
                className={`avail__day${iso === date ? ' is-on' : ''}`}
                aria-pressed={iso === date}
                disabled={shut}
                onClick={() => setDate(iso)}
              >
                <small>{day.toLocaleDateString('en', { weekday: 'short' })}</small>
                <b>{day.getDate()}</b>
              </button>
            );
          })}
        </div>

        {state === 'loading' && <p className="avail__note">{t('availability.checking')}</p>}

        {state === 'error' && (
          <p className="avail__note">
            Availability is not reachable right now. You can still start a booking
            and pick a time there.
          </p>
        )}

        {state === 'ready' && data?.closed && (
          <p className="avail__note">{t('availability.clubClosed')}</p>
        )}

        {state === 'ready' && !data?.closed && slots.length === 0 && (
          <p className="avail__note">{t('availability.allTaken')}</p>
        )}

        {state === 'ready' && slots.length > 0 && (
          <div className="avail__slots">
            {slots.map((slot) => (
              <a className="avail__slot" key={`${slot.time}-${slot.end}`}
                href={bookingHref(slot)}>
                {label(slot.time, is24)}
              </a>
            ))}
          </div>
        )}

        <a className="btn btn-primary" href={bookingHref(null)} style={{ justifySelf: 'start' }}>
          {t('availability.seeAll')}
        </a>
      </div>
    </div>
  );
}
