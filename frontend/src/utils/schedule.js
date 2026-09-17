import { displayTime, fromMinutes, toMinutes } from '../components/TimePicker.jsx';

/**
 * Client-side helpers for the weekly schedule. These mirror the rules in
 * `apps/settings_app/schedule.py` so the UI can mark a bad row before saving -
 * the BACKEND remains authoritative and re-validates everything. Nothing here
 * decides availability; it only decides what the form shows.
 */

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const DAY_LABELS = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
export const DAY_SHORT = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const WEEKEND = ['sat', 'sun'];

const DAY = 24 * 60;

export const SLOT_OPTIONS = [15, 30, 45, 60, 90, 120];

/** A day in the shape the API stores: {closed, shifts, breaks}. */
export function normalizeDay(cfg) {
  if (!cfg) return { closed: false, shifts: [], breaks: [] };
  if (cfg.closed) return { closed: true, shifts: [], breaks: [] };
  let shifts = cfg.shifts;
  if (!shifts && cfg.open && cfg.close) shifts = [{ open: cfg.open, close: cfg.close }];
  return { closed: false, shifts: shifts || [], breaks: cfg.breaks || [] };
}

export const CLOSED_DAY = { closed: true, shifts: [], breaks: [] };

export function openDay(open = '08:00', close = '20:00') {
  return { closed: false, shifts: [{ open, close }], breaks: [] };
}

/** True when this window runs into the next day (close <= open). */
export function spansMidnight(open, close) {
  const o = toMinutes(open);
  const c = toMinutes(close);
  return o !== null && c !== null && c <= o;
}

/** Window length in minutes, counting an overnight window correctly. */
export function windowMinutes(open, close) {
  const o = toMinutes(open);
  const c = toMinutes(close);
  if (o === null || c === null) return 0;
  return c > o ? c - o : c + DAY - o;
}

/**
 * Validate a week the way the server will. Returns { ok, errors: {day: msg} }.
 * `partial` checks only the days present, which is what an override is.
 */
export function validateWeek(week, { partial = false } = {}) {
  const errors = {};
  const keys = partial ? DAY_KEYS.filter((d) => d in (week || {})) : DAY_KEYS;

  for (const key of keys) {
    const day = normalizeDay((week || {})[key]);
    if (day.closed) continue;

    const shifts = [];
    let bad = null;
    for (const s of day.shifts) {
      const o = toMinutes(s.open);
      const c = toMinutes(s.close);
      if (o === null || c === null) { bad = 'Enter a valid start and end time.'; break; }
      if (c === o) {
        if (day.shifts.length > 1) {
          bad = 'A 24-hour shift cannot be combined with another shift.';
          break;
        }
        shifts.push([o, o + DAY]);
      } else {
        shifts.push([o, c > o ? c : c + DAY]);
      }
    }
    if (bad) { errors[key] = bad; continue; }
    if (!shifts.length) { errors[key] = 'Add at least one shift, or mark the day closed.'; continue; }

    shifts.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < shifts.length; i += 1) {
      if (shifts[i][0] === shifts[i - 1][0] && shifts[i][1] === shifts[i - 1][1]) {
        errors[key] = 'Remove the duplicate shift.'; break;
      }
      if (shifts[i][0] < shifts[i - 1][1]) {
        errors[key] = 'Shifts on the same day must not overlap.'; break;
      }
    }
    if (errors[key]) continue;
    if (shifts.length > 1 && shifts[shifts.length - 1][1] > DAY + shifts[0][0]) {
      errors[key] = 'The overnight shift runs into the next day.'; continue;
    }

    const breaks = [];
    for (const b of day.breaks) {
      const o = toMinutes(b.open);
      const c = toMinutes(b.close);
      if (o === null || c === null) { bad = 'Enter a valid break start and end time.'; break; }
      const end = c > o ? c : c + DAY;
      if (end - o >= DAY) { bad = 'A break cannot cover the whole day.'; break; }
      if (!shifts.some(([s, e]) => s <= o && end <= e)) {
        bad = 'A break must fall inside the operating hours.'; break;
      }
      breaks.push([o, end]);
    }
    if (bad) { errors[key] = bad; continue; }

    breaks.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < breaks.length; i += 1) {
      if (breaks[i][0] < breaks[i - 1][1]) {
        errors[key] = 'Breaks on the same day must not overlap.'; break;
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** A one-line summary of a day: "08:00 AM - 10:00 PM" or "Closed". */
export function summarizeDay(cfg, format24) {
  const day = normalizeDay(cfg);
  if (day.closed || !day.shifts.length) return 'Closed';
  return day.shifts
    .map((s) => `${displayTime(s.open, format24)} - ${displayTime(s.close, format24)}`)
    .join(', ');
}

/** Copy one day onto others. Date-specific exceptions are NOT part of a day. */
export function copyDayTo(week, from, targets) {
  const source = normalizeDay((week || {})[from]);
  const next = { ...(week || {}) };
  targets.filter((d) => d !== from).forEach((d) => {
    next[d] = {
      closed: source.closed,
      shifts: source.shifts.map((s) => ({ ...s })),
      breaks: source.breaks.map((b) => ({ ...b })),
    };
  });
  return next;
}

export function setEveryDay(week, cfg) {
  return DAY_KEYS.reduce((acc, d) => ({ ...acc, [d]: { ...cfg } }), { ...(week || {}) });
}

/**
 * Ready-made weeks. Applying one is a starting point, still fully editable.
 * The copy lives in the `schedule` bundle, so only the keys are held here.
 */
export const TEMPLATES = [
  {
    key: 'same-every-day',
    labelKey: 'presets.sameEveryDay',
    detailKey: 'presets.sameEveryDayDetail',
    build: () => setEveryDay({}, openDay('08:00', '22:00')),
  },
  {
    key: 'standard-week',
    labelKey: 'presets.standardWeek',
    detailKey: 'presets.standardWeekDetail',
    build: () => {
      const week = {};
      WEEKDAYS.forEach((d) => { week[d] = openDay('08:00', '22:00'); });
      WEEKEND.forEach((d) => { week[d] = openDay('09:00', '23:00'); });
      return week;
    },
  },
  {
    key: 'weekdays-only',
    labelKey: 'presets.weekdaysOnly',
    detailKey: 'presets.weekdaysOnlyDetail',
    build: () => {
      const week = {};
      WEEKDAYS.forEach((d) => { week[d] = openDay('08:00', '22:00'); });
      WEEKEND.forEach((d) => { week[d] = { ...CLOSED_DAY }; });
      return week;
    },
  },
  {
    key: 'always-open',
    labelKey: 'presets.alwaysOpen',
    detailKey: 'presets.alwaysOpenDetail',
    build: () => setEveryDay({}, openDay('00:00', '00:00')),
  },
  {
    key: 'closed',
    labelKey: 'presets.closedAllWeek',
    detailKey: 'presets.closedAllWeekDetail',
    build: () => setEveryDay({}, { ...CLOSED_DAY }),
  },
];

/** How a day's source reads on a badge. Returns a translation key. */
export function sourceLabelKey(source, parentLabel) {
  if (source === 'facility') return 'source.custom';
  if (source === 'club') return parentLabel === 'club' ? 'source.custom' : 'source.club';
  return parentLabel === 'organization' ? 'source.custom' : 'source.organization';
}

export { displayTime, fromMinutes, toMinutes };
