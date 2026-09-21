import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * How long a reservation has left, counted down live.
 *
 * Anchored on the server's own `seconds_remaining` as of the instant the
 * response arrived, never on `expires_at` compared against the browser clock.
 * A receptionist's PC whose clock is twenty minutes fast would otherwise show
 * a live reservation as already gone, and staff would tell the customer on the
 * phone that their court had been released when it had not. This is the same
 * rule the customer-facing countdown follows.
 *
 * The clock is the authority on whether a reservation is still holding a
 * court, not the status: the expiry sweep runs every few minutes, so rows sit
 * ACTIVE past their deadline in between.
 */

// One interval for the whole page rather than one per row. A listing shows 25
// reservations by default, and 25 timers all redrawing one cell each is 25
// times the work for the same second.
const subscribers = new Set();
let ticking = null;

function subscribe(fn) {
  subscribers.add(fn);
  if (!ticking) {
    ticking = setInterval(() => { subscribers.forEach((s) => s()); }, 1000);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && ticking) {
      clearInterval(ticking);
      ticking = null;
    }
  };
}

/** Seconds left now, from the server's figure and how long ago it was given. */
export function secondsLeft(secondsRemaining, receivedAt, now = Date.now()) {
  const granted = Number(secondsRemaining);
  if (!Number.isFinite(granted)) return 0;
  if (!receivedAt) return Math.max(0, Math.round(granted));
  const elapsed = Math.max(0, (now - receivedAt) / 1000);
  return Math.max(0, Math.round(granted - elapsed));
}

/** `m:ss`, so a glance answers "is it worth waiting?" without arithmetic. */
export function formatCountdown(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function HoldCountdown({ secondsRemaining, receivedAt, live }) {
  const { t } = useTranslation('bookings');
  const [left, setLeft] = useState(() => secondsLeft(secondsRemaining, receivedAt));

  useEffect(() => {
    setLeft(secondsLeft(secondsRemaining, receivedAt));
    if (!live) return undefined;
    return subscribe(() => setLeft(secondsLeft(secondsRemaining, receivedAt)));
  }, [secondsRemaining, receivedAt, live]);

  if (!live || left <= 0) {
    return <span className="muted">{t('reservations.ended')}</span>;
  }
  return (
    <span
      className={left <= 60 ? 'badge badge-warning' : 'badge badge-info'}
      style={{ fontVariantNumeric: 'tabular-nums' }}
      // Read out as a duration rather than as a bare "4:32", which a screen
      // reader would otherwise announce as a time of day.
      aria-label={t('reservations.minutesLeft', { time: formatCountdown(left) })}
    >
      {formatCountdown(left)}
    </span>
  );
}
