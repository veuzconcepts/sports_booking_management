import { describe, it, expect } from 'vitest';

import { assignLanes, iso, minutesOf, rangeOf, startOfWeek } from './BookingCalendar.jsx';
import { isInactive, legendFor, statusClass, statusLabel } from './bookingStatus.js';

describe('minutesOf', () => {
  it('reads the HH:MM:SS the API actually sends', () => {
    expect(minutesOf('09:00:00')).toBe(540);
    expect(minutesOf('13:45')).toBe(825);
    expect(minutesOf('00:00:00')).toBe(0);
  });

  it('returns null for missing or unparseable values', () => {
    expect(minutesOf(null)).toBeNull();
    expect(minutesOf('')).toBeNull();
    expect(minutesOf('not-a-time')).toBeNull();
  });
});

describe('rangeOf', () => {
  it('uses the server-computed end time', () => {
    expect(rangeOf({ scheduled_time: '10:00:00', end_time: '11:30:00' }))
      .toEqual({ start: 600, end: 690 });
  });

  it('falls back to the duration when no end time is stored', () => {
    expect(rangeOf({ scheduled_time: '10:00:00', duration_minutes: 90 }))
      .toEqual({ start: 600, end: 690 });
  });

  it('gives a zero-length booking a floor so it stays visible', () => {
    // Without this a 0-minute booking renders as an invisible sliver.
    const r = rangeOf({ scheduled_time: '10:00:00', end_time: '10:00:00', duration_minutes: 0 });
    expect(r.end).toBeGreaterThan(r.start);
  });

  it('ignores an end time that precedes the start', () => {
    const r = rangeOf({ scheduled_time: '10:00:00', end_time: '09:00:00', duration_minutes: 60 });
    expect(r).toEqual({ start: 600, end: 660 });
  });

  it('returns null when there is no start at all', () => {
    expect(rangeOf({ scheduled_time: null })).toBeNull();
  });
});

describe('assignLanes', () => {
  const at = (start, end) => ({ start, end });

  it('keeps non-overlapping bookings full width', () => {
    const out = assignLanes([at(540, 600), at(600, 660)]);
    expect(out.map((i) => i.lane)).toEqual([0, 0]);
    expect(out.map((i) => i.lanes)).toEqual([1, 1]);
  });

  it('puts two courts booked at the same time side by side', () => {
    // The bug this prevents: one booking drawn on top of the other, hiding it.
    const out = assignLanes([at(600, 660), at(600, 660)]);
    expect(out.map((i) => i.lane).sort()).toEqual([0, 1]);
    expect(out.every((i) => i.lanes === 2)).toBe(true);
  });

  it('reuses a lane once the earlier booking has ended', () => {
    const out = assignLanes([at(600, 660), at(600, 660), at(660, 720)]);
    const last = out[out.length - 1];
    expect(last.lane).toBe(0);
  });

  it('widths are per overlapping cluster, not per day', () => {
    // A lone 08:00 booking should not be squeezed narrow because 10:00 is busy.
    const out = assignLanes([at(480, 540), at(600, 660), at(600, 660)]);
    const lonely = out.find((i) => i.start === 480);
    expect(lonely.lanes).toBe(1);
    expect(out.filter((i) => i.start === 600).every((i) => i.lanes === 2)).toBe(true);
  });

  it('handles a partially overlapping chain', () => {
    const out = assignLanes([at(540, 600), at(570, 630), at(615, 675)]);
    const byStart = Object.fromEntries(out.map((i) => [i.start, i]));
    expect(byStart[540].lane).not.toBe(byStart[570].lane);   // these two overlap
    expect(byStart[615].lane).not.toBe(byStart[570].lane);   // so do these
  });

  it('does not mutate the caller array order', () => {
    const input = [at(660, 720), at(540, 600)];
    const copy = [...input];
    assignLanes(input);
    expect(input[0]).toBe(copy[0]);
  });

  it('copes with an empty day', () => {
    expect(assignLanes([])).toEqual([]);
  });
});

describe('iso / startOfWeek', () => {
  it('formats a local date without drifting through UTC', () => {
    // A late-evening date must not roll back a day in a positive offset.
    expect(iso(new Date(2026, 8, 18, 23, 30))).toBe('2026-09-18');
    expect(iso(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
  });

  it('starts the week on Sunday', () => {
    // 2026-09-16 is a Wednesday.
    expect(iso(startOfWeek(new Date(2026, 8, 16)))).toBe('2026-09-13');
  });

  it('leaves a Sunday where it is', () => {
    expect(iso(startOfWeek(new Date(2026, 8, 13)))).toBe('2026-09-13');
  });

  it('crosses a month boundary correctly', () => {
    expect(iso(startOfWeek(new Date(2026, 9, 1)))).toBe('2026-09-27');
  });
});

describe('booking status colours', () => {
  it('gives every status its own class', () => {
    expect(statusClass('confirmed')).toBe('bk-st--confirmed');
    expect(statusClass('booked')).toBe('bk-st--booked');
    expect(statusClass(null)).toBe('bk-st--unknown');
  });

  it('labels `booked` as Pending, matching the rest of the UI', () => {
    expect(statusLabel('booked')).toBe('Pending');
    expect(statusLabel('confirmed')).toBe('Confirmed');
    expect(statusLabel('no_show')).toBe('No-show');
  });

  it('treats cancelled and no-show as no longer occupying the slot', () => {
    expect(isInactive('cancelled')).toBe(true);
    expect(isInactive('no_show')).toBe(true);
    expect(isInactive('confirmed')).toBe(false);
  });

  it('legend covers only the statuses on screen, in workflow order', () => {
    const legend = legendFor([
      { status: 'cancelled' }, { status: 'booked' }, { status: 'booked' },
    ]);
    expect(legend.map((l) => l.status)).toEqual(['booked', 'cancelled']);
    expect(legend[0].label).toBe('Pending');
  });

  it('legend of an empty range is empty', () => {
    expect(legendFor([])).toEqual([]);
  });
});
