import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { bookingsApi } from '../../services/bookingsService.js';
import { formatTime, useTimeFormat } from '../../services/timeformat.jsx';
import { isInactive, statusClass, statusLabel } from './bookingStatus.js';
import { BookingPeek } from './BookingPeek.jsx';
import { CalendarRail } from './CalendarRail.jsx';

// --------------------------------------------------------------------------- //
// Dates. Everything here is LOCAL calendar arithmetic on `YYYY-MM-DD` strings,
// deliberately not UTC: a booking on the 18th belongs in the 18th's column
// regardless of the viewer's offset.
// --------------------------------------------------------------------------- //
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const startOfWeek = (d) => addDays(d, -d.getDay());          // weeks start Sunday
const sameDay = (a, b) => iso(a) === iso(b);

/** How many bookings fall on this day, for the "1 booking / Free" header. */
const countFor = (byDay, day) => (byDay.get(iso(day)) || []).length;

/** ISO week number, so the toolbar can say which week is on screen. */
function weekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday decides the week's year, which is what makes this ISO rather than
  // an approximation that drifts around New Year.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/** Minutes past midnight for "HH:MM[:SS]"; null when unparseable. */
export function minutesOf(value) {
  if (!value) return null;
  const [h, m] = String(value).split(':');
  const hh = parseInt(h, 10);
  if (Number.isNaN(hh)) return null;
  return hh * 60 + (parseInt(m, 10) || 0);
}

export function rangeOf(row) {
  const start = minutesOf(row.scheduled_time);
  if (start == null) return null;
  let end = minutesOf(row.end_time);
  // A booking with no stored end still occupies its duration; a zero-length one
  // would be invisible, so give it a floor.
  if (end == null || end <= start) end = start + (row.duration_minutes || 30);
  return { start, end: Math.max(end, start + 15) };
}

/**
 * Side-by-side lanes for bookings that overlap in time. Two courts booked at
 * 10:00 are both real - stacking them would hide one, so they share the column.
 * Greedy first-fit, which is what every calendar does and is stable to read.
 */
export function assignLanes(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const laneEnds = [];
  sorted.forEach((it) => {
    let lane = laneEnds.findIndex((end) => end <= it.start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = it.end;
    it.lane = lane;
  });
  // Width is decided per overlapping cluster, so a single booking at 8am is not
  // squeezed narrow just because 09:00 is busy.
  sorted.forEach((it) => {
    const cluster = sorted.filter((o) => o.start < it.end && it.start < o.end);
    it.lanes = Math.max(...cluster.map((o) => o.lane)) + 1;
  });
  return sorted;
}

// --------------------------------------------------------------------------- //

const MODES = [
  { key: 'day', labelKey: 'calendar.day' },
  { key: 'week', labelKey: 'calendar.week' },
  { key: 'month', labelKey: 'calendar.month' },
];

const HOUR_PX = 56;            // height of one hour band in the time grid
const GUTTER = 62;             // width of the hour column
// A day column below this is unreadable: the time, the customer and the
// facility all wrap to one word per line. Past it the grid scrolls sideways
// inside itself rather than squeezing every day into the space left over.
const MIN_DAY_PX = 116;

/**
 * Bookings on a calendar: day and week as a time grid (as in the reference),
 * month as a cell grid of chips. Colour carries the status in every mode -
 * green for confirmed, amber for pending, red for cancelled.
 *
 * Fetches its own range rather than reusing the paginated list: a calendar must
 * show every booking in view, not the first page of them.
 */
export function BookingCalendar({ filters, onOpen, reloadKey, onReschedule, onReviewInList }) {
  const { t } = useTranslation('bookings');
  const [mode, setMode] = useState('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);   // month cell showing all chips
  const [peek, setPeek] = useState(null);           // booking shown in the popover
  // Rail filters. These hide rows already fetched rather than re-querying: the
  // range is one request and the counts must stay stable while you toggle.
  const [hiddenStatuses, setHiddenStatuses] = useState([]);
  const [hiddenClubs, setHiddenClubs] = useState([]);
  const { format24 } = useTimeFormat();
  const gridRef = useRef(null);

  // The days currently on screen.
  const days = useMemo(() => {
    if (mode === 'day') return [new Date(anchor)];
    if (mode === 'week') {
      const s = startOfWeek(anchor);
      return Array.from({ length: 7 }, (_, i) => addDays(s, i));
    }
    // Month: whole weeks, so the grid is always a clean 7 x N.
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const from = startOfWeek(first);
    const to = addDays(startOfWeek(last), 6);
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(new Date(d));
    return out;
  }, [mode, anchor]);

  const from = days.length ? iso(days[0]) : null;
  const to = days.length ? iso(days[days.length - 1]) : null;

  // Only the filters the calendar should honour; `page`/`ordering` are the
  // list view's business and would fight the range query.
  const { status, source, search } = filters || {};

  const load = useCallback(() => {
    if (!from || !to) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    bookingsApi.list({
      date_from: from,
      date_to: to,
      page_size: 500,          // a month of bookings in one go
      ordering: 'scheduled_time',
      ...(status ? { status } : {}),
      ...(source ? { source } : {}),
      ...(search ? { search } : {}),
    })
      .then((d) => { if (!cancelled) setRows(d.results || d || []); })
      .catch((e) => { if (!cancelled) { setError(e); setRows([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to, status, source, search]);

  useEffect(() => {
    const cancel = load();
    return cancel;
  }, [load, reloadKey]);

  const statusCounts = useMemo(() => {
    const seen = new Map();
    rows.forEach((r) => seen.set(r.status, (seen.get(r.status) || 0) + 1));
    return [...seen.entries()].map(([status, count]) => ({ status, count }));
  }, [rows]);

  const clubCounts = useMemo(() => {
    const seen = new Map();
    rows.forEach((r) => {
      const name = r.club_name || '';
      if (name) seen.set(name, (seen.get(name) || 0) + 1);
    });
    return [...seen.entries()].map(([name, count]) => ({ name, count }));
  }, [rows]);

  const visible = useMemo(() => rows.filter(
    (r) => !hiddenStatuses.includes(r.status) && !hiddenClubs.includes(r.club_name || ''),
  ), [rows, hiddenStatuses, hiddenClubs]);

  // Bookings bucketed by day, so each column only walks its own.
  const byDay = useMemo(() => {
    const map = new Map();
    visible.forEach((r) => {
      const key = r.scheduled_date;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    return map;
  }, [visible]);

  // The hour window actually worth showing: tight around real bookings, with a
  // sensible default when the range is empty.
  const [hourFrom, hourTo] = useMemo(() => {
    let lo = 24 * 60;
    let hi = 0;
    rows.forEach((r) => {
      const t = rangeOf(r);
      if (!t) return;
      lo = Math.min(lo, t.start);
      hi = Math.max(hi, t.end);
    });
    if (lo > hi) return [7, 22];
    return [Math.max(0, Math.floor(lo / 60) - 1), Math.min(24, Math.ceil(hi / 60) + 1)];
  }, [rows]);

  const hours = useMemo(
    () => Array.from({ length: Math.max(1, hourTo - hourFrom) }, (_, i) => hourFrom + i),
    [hourFrom, hourTo],
  );

  const today = new Date();
  const isTimeGrid = mode !== 'month';

  // Bring the first booking into view rather than opening at the top of the day.
  useEffect(() => {
    if (!isTimeGrid || !gridRef.current || loading) return;
    gridRef.current.scrollTop = 0;
  }, [isTimeGrid, loading, from]);

  function step(dir) {
    if (mode === 'day') setAnchor((d) => addDays(d, dir));
    else if (mode === 'week') setAnchor((d) => addDays(d, dir * 7));
    else setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + dir, 1));
  }

  const title = (() => {
    if (mode === 'day') {
      return anchor.toLocaleDateString(undefined, {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });
    }
    if (mode === 'week') {
      const a = days[0];
      const b = days[6];
      const sameMonth = a.getMonth() === b.getMonth();
      const left = a.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const right = b.toLocaleDateString(undefined, {
        day: 'numeric', month: sameMonth ? undefined : 'short', year: 'numeric',
      });
      return `${left} - ${right}`;
    }
    return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
  })();


  const toggle = (list, setList, value) => setList(
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value],
  );

  return (
    <div className="bk-cal">
      <div className="bk-cal__bar">
        <div className="bk-cal__nav">
          <button className="icon-btn" onClick={() => step(-1)} aria-label={t('calendar.previous')}>
            <ChevronLeft size={16} />
          </button>
          <button className="btn btn-secondary" onClick={() => setAnchor(new Date())}>{t('calendar.today')}</button>
          <button className="icon-btn" onClick={() => step(1)} aria-label={t('calendar.next')}>
            <ChevronRight size={16} />
          </button>
        </div>
        <h3 className="bk-cal__title">{title}</h3>
        <span className="bk-cal__summary">
          {mode === 'week' && `${t('calendar.weekNo', { number: weekNumber(days[0]) })} · `}
          {t('calendar.inRange', { count: visible.length })}
        </span>
        <div style={{ marginInlineStart: 'auto' }}>
          <div className="bk-views" role="group" aria-label={t('calendar.range')}>
            {MODES.map((m) => (
              <button key={m.key} className={mode === m.key ? 'is-on' : ''}
                aria-pressed={mode === m.key}
                onClick={() => setMode(m.key)}>{t(m.labelKey)}</button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="bk-cal__empty">{t('calendar.loadFailed')}</div>
      )}

      {!error && (
      <div className="bk-cal__split">
      <CalendarRail
        anchor={anchor}
        onAnchor={(d) => setAnchor(d)}
        rows={rows}
        days={days}
        today={today}
        statuses={statusCounts}
        hiddenStatuses={hiddenStatuses}
        onToggleStatus={(v) => toggle(hiddenStatuses, setHiddenStatuses, v)}
        clubs={clubCounts}
        hiddenClubs={hiddenClubs}
        onToggleClub={(v) => toggle(hiddenClubs, setHiddenClubs, v)}
        onReviewInList={onReviewInList}
      />

      <div className="bk-cal__main">
      {isTimeGrid && (
        <TimeGrid
          t={t}
          gridRef={gridRef}
          days={days}
          hours={hours}
          hourFrom={hourFrom}
          byDay={byDay}
          today={today}
          format24={format24}
          onOpen={setPeek}
        />
      )}

      {!isTimeGrid && (
        <MonthGrid
          t={t}
          days={days}
          month={anchor.getMonth()}
          byDay={byDay}
          today={today}
          format24={format24}
          expanded={expanded}
          setExpanded={setExpanded}
          onOpen={onOpen}
        />
      )}

      {!loading && visible.length === 0 && (
        <div className="bk-cal__empty">{t('calendar.noneInRange')}</div>
      )}
      </div>
      </div>
      )}

      {/* The popover is anchored to the grid, not the clicked block: a block
          near the bottom of a scrolled column would otherwise open off-screen. */}
      {peek && (
        <div className="bk-peek__scrim" onClick={() => setPeek(null)}>
          <BookingPeek
            row={peek}
            onClose={() => setPeek(null)}
            onOpen={(r) => { setPeek(null); onOpen(r); }}
            onReschedule={onReschedule}
          />
        </div>
      )}

    </div>
  );
}

// --------------------------------------------------------------------------- //
// Day / week: absolute-positioned blocks over an hour grid.
// --------------------------------------------------------------------------- //
function TimeGrid({ t, gridRef, days, hours, hourFrom, byDay, today, format24, onOpen }) {
  const columns = `${GUTTER}px repeat(${days.length}, minmax(${MIN_DAY_PX}px, 1fr))`;
  const height = hours.length * HOUR_PX;
  const top = (minutes) => ((minutes - hourFrom * 60) / 60) * HOUR_PX;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const showNow = nowMinutes >= hourFrom * 60 && nowMinutes <= (hourFrom + hours.length) * 60;

  return (
    <div className="bk-cal__grid" ref={gridRef}>
      <div className="bk-cal__head" style={{ gridTemplateColumns: columns }}>
        <div className="bk-cal__gutter-head" />
        {days.map((d) => (
          <div key={iso(d)}
            className={`bk-cal__day${sameDay(d, today) ? ' bk-cal__day--today' : ''}`}>
            <div className="bk-cal__day-name">{DAY_NAMES[d.getDay()]}</div>
            <div className="bk-cal__day-line">
              <span className="bk-cal__day-num">{d.getDate()}</span>
              <span className="bk-cal__day-load">
                {countFor(byDay, d)
                  ? t('calendar.dayCount', { count: countFor(byDay, d) })
                  : t('calendar.dayFree')}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="bk-cal__body" style={{ gridTemplateColumns: columns, height }}>
        <div className="bk-cal__gutter">
          {hours.map((h, i) => (
            <div key={h} className="bk-cal__hour" style={{ height: HOUR_PX }}>
              {i === 0 ? null : <span>{formatTime(`${String(h).padStart(2, '0')}:00`, { format24 })}</span>}
            </div>
          ))}
        </div>

        {days.map((d) => {
          const key = iso(d);
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          const isToday = sameDay(d, today);
          const items = assignLanes(
            (byDay.get(key) || [])
              .map((r) => ({ row: r, ...(rangeOf(r) || {}) }))
              .filter((it) => it.start != null),
          );

          return (
            <div key={key}
              className={`bk-cal__col${isToday ? ' bk-cal__col--today' : weekend ? ' bk-cal__col--weekend' : ''}`}>
              {hours.map((h, i) => (
                <div key={h}>
                  <div className="bk-cal__line" style={{ top: i * HOUR_PX }} />
                  <div className="bk-cal__line bk-cal__line--half"
                    style={{ top: i * HOUR_PX + HOUR_PX / 2 }} />
                </div>
              ))}

              {isToday && showNow && (
                <div className="bk-cal__now" style={{ top: top(nowMinutes) }}>
                  <span className="bk-cal__now-time">
                    {formatTime(
                      `${String(now.getHours()).padStart(2, '0')}:`
                      + `${String(now.getMinutes()).padStart(2, '0')}`,
                      { format24 },
                    )}
                  </span>
                </div>
              )}

              {items.map((it) => {
                const r = it.row;
                const blockTop = top(it.start);
                const blockHeight = Math.max(18, ((it.end - it.start) / 60) * HOUR_PX - 2);
                const width = 100 / it.lanes;
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={`bk-cal__event ${statusClass(r.status)}`
                      + `${isInactive(r.status) ? ' bk-cal__event--inactive' : ''}`
                      + `${blockHeight < 40 ? ' bk-cal__event--tiny' : ''}`}
                    style={{
                      top: blockTop,
                      height: blockHeight,
                      left: `calc(${it.lane * width}% + 2px)`,
                      width: `calc(${width}% - 4px)`,
                    }}
                    title={`${r.reference} - ${statusLabel(r.status)}\n`
                      + `${r.facility_type_name || ''}${r.facility_name ? ` (${r.facility_name})` : ''}\n`
                      + `${formatTime(r.scheduled_time, { format24 })}`
                      + `${r.end_time ? ` - ${formatTime(r.end_time, { format24 })}` : ''}\n`
                      + `${r.customer_label || ''}`}
                    onClick={() => onOpen(r)}
                  >
                    <div className="bk-cal__event-when">
                      <span className="bk-cal__event-pip" aria-hidden="true" />
                      {formatTime(r.scheduled_time, { format24 })}
                      {r.end_time ? ` - ${formatTime(r.end_time, { format24 })}` : ''}
                    </div>
                    <div className="bk-cal__event-title">
                      {r.customer_label || r.reference}
                    </div>
                    <div className="bk-cal__event-sub">
                      {r.facility_name || r.facility_type_name || ''}
                    </div>
                    <span className={`bk-cal__event-chip ${statusClass(r.status)}`}>
                      {statusLabel(r.status)}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Month: one cell per day, chips inside, "+N more" rather than an endless cell.
// --------------------------------------------------------------------------- //
const MONTH_CHIP_LIMIT = 3;

function MonthGrid({ days, month, byDay, today, format24, expanded, setExpanded, onOpen, t }) {
  return (
    <div className="bk-cal__grid">
      {/* responsive-ok: a week has seven columns; the grid scrolls on a phone. */}
      <div className="bk-cal__head" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
        {DAY_NAMES.map((n) => (
          <div key={n} className="bk-cal__day"><div className="bk-cal__day-name">{n}</div></div>
        ))}
      </div>

      <div className="bk-cal__month">
        {days.map((d) => {
          const key = iso(d);
          const dayRows = (byDay.get(key) || [])
            .slice()
            .sort((a, b) => String(a.scheduled_time).localeCompare(String(b.scheduled_time)));
          const isOpen = expanded === key;
          const shown = isOpen ? dayRows : dayRows.slice(0, MONTH_CHIP_LIMIT);
          const hidden = dayRows.length - shown.length;

          return (
            <div key={key}
              className={`bk-cal__mcell${d.getMonth() !== month ? ' bk-cal__mcell--out' : ''}`
                + `${sameDay(d, today) ? ' bk-cal__mcell--today' : ''}`}>
              <div className="bk-cal__mnum">{d.getDate()}</div>

              {shown.map((r) => (
                <button key={r.id} type="button"
                  className={`bk-cal__chip ${statusClass(r.status)}`
                    + `${isInactive(r.status) ? ' bk-cal__chip--inactive' : ''}`}
                  title={`${r.reference} - ${statusLabel(r.status)}\n${r.customer_label || ''}`}
                  onClick={() => onOpen(r)}>
                  <time>{formatTime(r.scheduled_time, { format24 })}</time>
                  <span>{r.facility_type_name || r.reference}</span>
                </button>
              ))}

              {hidden > 0 && (
                <button className="bk-cal__mmore" onClick={() => setExpanded(key)}>
                  {t('calendar.more', { count: hidden })}
                </button>
              )}
              {isOpen && dayRows.length > MONTH_CHIP_LIMIT && (
                <button className="bk-cal__mmore" onClick={() => setExpanded(null)}>
                  {t('calendar.showLess')}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
