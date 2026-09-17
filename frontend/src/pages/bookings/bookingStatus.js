import { bookingStatuses } from '../../services/bookingsService.js';
import i18n from '../../i18n/index.js';

/**
 * One colour per booking status, shared by the card and calendar views so a
 * booking reads the same whichever view you are in. The actual colours live in
 * `bookingViews.css` as `.bk-st--<status>` so they stay themeable; this module
 * only decides which class and label a status gets.
 *
 * Green = confirmed and done. Amber = needs attention (pending). Red = off.
 */
export function statusClass(status) {
  return `bk-st--${status || 'unknown'}`;
}

/**
 * The reader-facing name of a status. Resolved at call time, so it follows the
 * active language; the code itself is never translated.
 */
export function statusLabel(status) {
  if (!status) return '';
  const key = `bookings:status.${status}`;
  const text = i18n.t(key);
  return text === key ? String(status).replace(/_/g, ' ') : text;
}

// Statuses that no longer occupy their slot - drawn faded in the calendar so a
// cancelled booking never looks like a live one.
const INACTIVE = new Set(['cancelled', 'no_show']);

export function isInactive(status) {
  return INACTIVE.has(status);
}

/** The legend under the calendar - only the statuses actually in view. */
export function legendFor(rows) {
  const seen = [];
  rows.forEach((r) => { if (!seen.includes(r.status)) seen.push(r.status); });
  const order = bookingStatuses(i18n.t).map((s) => s.value);
  return seen
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((s) => ({ status: s, label: statusLabel(s), className: statusClass(s) }));
}
