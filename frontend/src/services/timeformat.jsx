import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { organizationApi } from './settingsService.js';

// Module-level singletons so formatTime() works outside React too (mirrors the
// currency module). Defaults match the Organization model defaults.
let _format24 = false;            // false = 12-hour (5:00 PM); true = 17:00
let _timezone = 'Asia/Dubai';

const pad = (n) => String(n).padStart(2, '0');

export function is24Hour() { return _format24; }
export function orgTimezone() { return _timezone; }

/**
 * Format a time-of-day per the Organization preference.
 * Accepts "HH:MM" / "HH:MM:SS" strings or a Date. Returns "" for empty input.
 *   formatTime('17:00') -> "5:00 PM"   (12-hour)   or "17:00" (24-hour)
 */
export function formatTime(value, { format24 = _format24 } = {}) {
  if (value === null || value === undefined || value === '') return '';
  let h;
  let m;
  if (value instanceof Date) {
    h = value.getHours();
    m = value.getMinutes();
  } else {
    const [hh, mm] = String(value).split(':');
    h = parseInt(hh, 10);
    m = parseInt(mm || '0', 10);
    if (Number.isNaN(h)) return String(value);
  }
  if (format24) return `${pad(h)}:${pad(m)}`;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${period}`;
}

/**
 * Format a full date + time per the Organization preference (12/24-hour and
 * timezone). Use this instead of `new Date(x).toLocaleString()` so timestamps
 * everywhere follow the Organization Information settings.
 *   formatDateTime('2026-06-18T09:05:00Z') -> "18 Jun 2026, 1:05 PM" (12-hour)
 *                                              "18 Jun 2026, 13:05"   (24-hour)
 */
export function formatDateTime(value, { format24 = _format24, timezone = _timezone } = {}) {
  if (value === null || value === undefined || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: !format24,
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

/**
 * Format a DATE (no time) per the Organization timezone - the professional, app-wide
 * date format. Use this instead of `new Date(x).toLocaleDateString()` so dates match
 * everywhere ("18 Jun 2026").
 */
export function formatDate(value, { timezone = _timezone } = {}) {
  if (value === null || value === undefined || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

const TimeFormatContext = createContext(null);

export function TimeFormatProvider({ children }) {
  const [format24, setFormat24] = useState(_format24);

  const reload = useCallback(async () => {
    try {
      const d = await organizationApi.get();
      _format24 = Boolean(d.time_format_24h);
      _timezone = d.timezone || _timezone;
      setFormat24(_format24);   // re-render the subtree with the new preference
    } catch {
      /* keep the 12-hour default if the user can't read organization settings */
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <TimeFormatContext.Provider value={{ format24, timezone: _timezone, formatTime, reload }}>
      {children}
    </TimeFormatContext.Provider>
  );
}

export function useTimeFormat() {
  return useContext(TimeFormatContext)
    || { format24: _format24, timezone: _timezone, formatTime, reload: () => {} };
}

/** Render a time-of-day per the org preference: <Time value="17:00" /> */
export function Time({ value }) {
  const { format24 } = useTimeFormat();
  return <>{formatTime(value, { format24 })}</>;
}

/** Render a full date + time per the org preference: <DateTime value={iso} /> */
export function DateTime({ value }) {
  const { format24, timezone } = useTimeFormat();
  return <>{formatDateTime(value, { format24, timezone })}</>;
}
