import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { HoldCountdown, formatCountdown, secondsLeft } from './HoldCountdown.jsx';
import { slotSummary } from './ReservationsListPage.jsx';

/**
 * The reservations screen.
 *
 * What matters here is not the layout. It is that the countdown is anchored on
 * the SERVER's figure rather than on this machine's clock, and that a
 * reservation which is no longer holding a court does not claim to be.
 *
 * A reception PC with a wrong clock is not a hypothetical: it is the ordinary
 * state of a shared machine nobody administers. Reading `expires_at` against
 * `Date.now()` would tell staff a live reservation had expired, and they would
 * tell the customer on the phone that their court had gone.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, vars) => (vars?.time ? `${vars.time} left` : key),
  }),
}));

vi.mock('../../services/timeformat.jsx', () => ({
  formatTime: (value) => `T:${String(value || '')}`,
  formatDate: (value) => `D:${String(value || '')}`,
  formatDateTime: (value) => `DT:${String(value || '')}`,
  useTimeFormat: () => ({ format24: true }),
}));

describe('anchoring the countdown', () => {
  it('counts down from what the server said, not from the browser clock', () => {
    const receivedAt = 1_000_000;
    // 600s were left when the response arrived; 90s of real time have passed.
    expect(secondsLeft(600, receivedAt, receivedAt + 90_000)).toBe(510);
  });

  it('ignores a browser clock that is wildly wrong', () => {
    // The anchor and "now" come from the same clock, so only the INTERVAL
    // between them matters. A machine twenty minutes fast counts down the
    // same, which is the entire point of not reading `expires_at`.
    const skewed = Date.now() + 20 * 60_000;
    expect(secondsLeft(300, skewed, skewed + 60_000)).toBe(240);
  });

  it('never goes below zero', () => {
    expect(secondsLeft(30, 1_000_000, 1_000_000 + 120_000)).toBe(0);
  });

  it('falls back to the raw figure when nothing stamped the response', () => {
    expect(secondsLeft(420, undefined)).toBe(420);
  });

  it('treats a missing figure as nothing left rather than as NaN', () => {
    expect(secondsLeft(null, 1_000_000, 1_000_000)).toBe(0);
    expect(secondsLeft(undefined, 1_000_000, 1_000_000)).toBe(0);
  });
});

describe('reading the countdown', () => {
  it('pads the seconds so the width does not jump each tick', () => {
    expect(formatCountdown(545)).toBe('9:05');
    expect(formatCountdown(600)).toBe('10:00');
    expect(formatCountdown(9)).toBe('0:09');
  });

  it('shows zero rather than a negative time', () => {
    expect(formatCountdown(-30)).toBe('0:00');
  });
});

describe('the countdown cell', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the time left on a live reservation', () => {
    const now = Date.now();
    render(<HoldCountdown secondsRemaining={545} receivedAt={now} live />);
    expect(screen.getByText('9:05')).toBeTruthy();
  });

  it('ticks down on its own', () => {
    const now = Date.now();
    render(<HoldCountdown secondsRemaining={545} receivedAt={now} live />);
    // The tick is a state update, so React has to be allowed to flush it.
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByText('9:00')).toBeTruthy();
  });

  it('warns when under a minute is left', () => {
    const now = Date.now();
    const { container } = render(
      <HoldCountdown secondsRemaining={45} receivedAt={now} live />);
    expect(container.querySelector('.badge-warning')).toBeTruthy();
  });

  it('says a reservation has ended rather than showing 0:00', () => {
    render(<HoldCountdown secondsRemaining={0} receivedAt={Date.now()} live />);
    expect(screen.getByText('reservations.ended')).toBeTruthy();
  });

  it('says ended for a row the sweep has not reached yet', () => {
    // `is_live` asks the clock; the row may still read ACTIVE in the table.
    render(<HoldCountdown secondsRemaining={300} receivedAt={Date.now()} live={false} />);
    expect(screen.getByText('reservations.ended')).toBeTruthy();
  });
});

describe('summarising the courts a reservation holds', () => {
  const slot = (id, facility) => ({
    id, facility_name: facility, scheduled_date: '2026-09-25',
    scheduled_time: '19:00', end_time: '20:00',
  });

  it('returns nothing when the reservation holds no courts', () => {
    expect(slotSummary([])).toBeNull();
    expect(slotSummary()).toBeNull();
  });

  it('names the first court and counts the rest', () => {
    const summary = slotSummary([slot(1, 'Padel 1'), slot(2, 'Padel 2'), slot(3, 'Padel 3')]);
    expect(summary.facility).toBe('Padel 1');
    expect(summary.extra).toBe(2);
  });

  it('counts no extras for a single court', () => {
    expect(slotSummary([slot(1, 'Padel 1')]).extra).toBe(0);
  });
});
