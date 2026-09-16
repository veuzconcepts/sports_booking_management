import { describe, it, expect } from 'vitest';

import {
  CLOSED_DAY, DAY_KEYS, TEMPLATES, WEEKDAYS, WEEKEND,
  copyDayTo, normalizeDay, openDay, setEveryDay, spansMidnight,
  summarizeDay, validateWeek, windowMinutes,
} from './schedule.js';
import { displayTime, fromMinutes, parseTimeInput, toMinutes } from '../components/TimePicker.jsx';

// --------------------------------------------------------------------------- //
describe('parseTimeInput', () => {
  it('accepts the shapes people actually type', () => {
    expect(parseTimeInput('9')).toBe('09:00');
    expect(parseTimeInput('930')).toBe('09:30');
    expect(parseTimeInput('9:30')).toBe('09:30');
    expect(parseTimeInput('9.30')).toBe('09:30');
    expect(parseTimeInput('21:30')).toBe('21:30');
    expect(parseTimeInput('2130')).toBe('21:30');
  });

  it('understands am and pm', () => {
    expect(parseTimeInput('9pm')).toBe('21:00');
    expect(parseTimeInput('9:30 pm')).toBe('21:30');
    expect(parseTimeInput('12am')).toBe('00:00');
    expect(parseTimeInput('12pm')).toBe('12:00');
  });

  it('reads a bare hour literally rather than guessing', () => {
    // Guessing "6" means 18:00 would silently set the wrong opening time.
    expect(parseTimeInput('6')).toBe('06:00');
    expect(parseTimeInput('6pm')).toBe('18:00');
  });

  it('treats 24:00 as midnight', () => {
    expect(parseTimeInput('24:00')).toBe('00:00');
  });

  it('rejects nonsense instead of inventing a time', () => {
    expect(parseTimeInput('')).toBeNull();
    expect(parseTimeInput('abc')).toBeNull();
    expect(parseTimeInput('25:00')).toBeNull();
    expect(parseTimeInput('9:75')).toBeNull();
  });
});

describe('displayTime', () => {
  it('follows the organization 12/24-hour preference', () => {
    expect(displayTime('17:00', false)).toBe('5:00 PM');
    expect(displayTime('17:00', true)).toBe('17:00');
    expect(displayTime('00:00', false)).toBe('12:00 AM');
    expect(displayTime('12:00', false)).toBe('12:00 PM');
  });

  it('is blank for an empty value', () => {
    expect(displayTime('', false)).toBe('');
    expect(displayTime(null, false)).toBe('');
  });
});

describe('minutes helpers', () => {
  it('round-trips', () => {
    expect(toMinutes('08:30')).toBe(510);
    expect(fromMinutes(510)).toBe('08:30');
    expect(fromMinutes(1500)).toBe('01:00');   // wraps past midnight
  });
});

// --------------------------------------------------------------------------- //
describe('overnight handling', () => {
  it('recognises a window that runs past midnight', () => {
    expect(spansMidnight('18:00', '02:00')).toBe(true);
    expect(spansMidnight('08:00', '22:00')).toBe(false);
    // Equal times mean a full 24 hours, which also crosses midnight.
    expect(spansMidnight('00:00', '00:00')).toBe(true);
  });

  it('measures an overnight window correctly', () => {
    expect(windowMinutes('18:00', '02:00')).toBe(8 * 60);
    expect(windowMinutes('08:00', '22:00')).toBe(14 * 60);
    expect(windowMinutes('00:00', '00:00')).toBe(24 * 60);
  });
});

// --------------------------------------------------------------------------- //
describe('validateWeek', () => {
  const full = (day) => DAY_KEYS.reduce((acc, d) => ({ ...acc, [d]: day }), {});

  it('accepts an ordinary week', () => {
    expect(validateWeek(full(openDay('08:00', '22:00'))).ok).toBe(true);
  });

  it('rejects overlapping shifts', () => {
    const { ok, errors } = validateWeek({
      mon: { closed: false, shifts: [
        { open: '08:00', close: '13:00' }, { open: '12:00', close: '18:00' }] },
    }, { partial: true });
    expect(ok).toBe(false);
    expect(errors.mon).toMatch(/overlap/i);
  });

  it('rejects a duplicate shift', () => {
    const { errors } = validateWeek({
      mon: { closed: false, shifts: [
        { open: '08:00', close: '13:00' }, { open: '08:00', close: '13:00' }] },
    }, { partial: true });
    expect(errors.mon).toMatch(/duplicate/i);
  });

  it('rejects a break outside the operating hours', () => {
    const { errors } = validateWeek({
      mon: openDayWithBreak('08:00', '12:00', '14:00', '15:00'),
    }, { partial: true });
    expect(errors.mon).toMatch(/inside/i);
  });

  it('rejects overlapping breaks', () => {
    const { errors } = validateWeek({
      mon: { closed: false,
        shifts: [{ open: '08:00', close: '20:00' }],
        breaks: [{ open: '12:00', close: '14:00' }, { open: '13:00', close: '15:00' }] },
    }, { partial: true });
    expect(errors.mon).toMatch(/overlap/i);
  });

  it('accepts a break that sits inside a shift', () => {
    const { ok } = validateWeek({
      mon: openDayWithBreak('08:00', '20:00', '13:00', '14:00'),
    }, { partial: true });
    expect(ok).toBe(true);
  });

  it('accepts an overnight shift', () => {
    expect(validateWeek({ mon: openDay('18:00', '02:00') }, { partial: true }).ok).toBe(true);
  });

  it('rejects an open day with no hours', () => {
    const { errors } = validateWeek({ mon: { closed: false, shifts: [] } },
                                    { partial: true });
    expect(errors.mon).toBeTruthy();
  });

  it('accepts a closed day', () => {
    expect(validateWeek({ mon: CLOSED_DAY }, { partial: true }).ok).toBe(true);
  });

  it('only checks the days present when partial', () => {
    // An override names only the days that differ; the rest are inherited.
    expect(validateWeek({ fri: openDay('14:00', '23:00') }, { partial: true }).ok).toBe(true);
  });

  it('rejects a 24-hour shift combined with another', () => {
    const { errors } = validateWeek({
      mon: { closed: false, shifts: [
        { open: '00:00', close: '00:00' }, { open: '10:00', close: '12:00' }] },
    }, { partial: true });
    expect(errors.mon).toBeTruthy();
  });
});

function openDayWithBreak(open, close, bOpen, bClose) {
  return { closed: false, shifts: [{ open, close }],
    breaks: [{ open: bOpen, close: bClose }] };
}

// --------------------------------------------------------------------------- //
describe('copyDayTo', () => {
  const week = {
    mon: { closed: false, shifts: [{ open: '08:00', close: '12:00' }],
      breaks: [{ name: 'Lunch', open: '10:00', close: '10:30' }] },
    tue: openDay('09:00', '17:00'),
  };

  it('copies hours AND breaks', () => {
    const next = copyDayTo(week, 'mon', ['tue']);
    expect(next.tue.shifts).toEqual([{ open: '08:00', close: '12:00' }]);
    expect(next.tue.breaks).toEqual([{ name: 'Lunch', open: '10:00', close: '10:30' }]);
  });

  it('copies the open/closed status', () => {
    const next = copyDayTo({ mon: CLOSED_DAY, tue: openDay() }, 'mon', ['tue']);
    expect(next.tue.closed).toBe(true);
  });

  it('never copies a day onto itself', () => {
    const next = copyDayTo(week, 'mon', DAY_KEYS);
    expect(next.mon).toEqual(week.mon);
  });

  it('copies to weekdays without touching the weekend', () => {
    const next = copyDayTo(week, 'mon', WEEKDAYS);
    expect(next.fri.shifts).toEqual([{ open: '08:00', close: '12:00' }]);
    expect(next.sat).toBeUndefined();
  });

  it('copies to the weekend only', () => {
    const next = copyDayTo(week, 'mon', WEEKEND);
    expect(next.sat.shifts).toEqual([{ open: '08:00', close: '12:00' }]);
    expect(next.wed).toBeUndefined();
  });

  it('deep-copies so editing the copy does not change the source', () => {
    const next = copyDayTo(week, 'mon', ['tue']);
    next.tue.shifts[0].open = '06:00';
    expect(next.mon.shifts[0].open).toBe('08:00');
  });
});

describe('setEveryDay', () => {
  it('covers all seven days', () => {
    const next = setEveryDay({}, CLOSED_DAY);
    expect(Object.keys(next).sort()).toEqual([...DAY_KEYS].sort());
    expect(DAY_KEYS.every((d) => next[d].closed)).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
describe('templates', () => {
  it('every template produces a valid full week', () => {
    for (const template of TEMPLATES) {
      const week = template.build();
      expect(Object.keys(week).sort(), template.key).toEqual([...DAY_KEYS].sort());
      expect(validateWeek(week).ok, template.key).toBe(true);
    }
  });

  it('the standard week differs at the weekend', () => {
    const week = TEMPLATES.find((t) => t.key === 'standard-week').build();
    expect(week.mon.shifts[0]).toEqual({ open: '08:00', close: '22:00' });
    expect(week.sat.shifts[0]).toEqual({ open: '09:00', close: '23:00' });
  });

  it('closed-all-week really closes every day', () => {
    const week = TEMPLATES.find((t) => t.key === 'closed').build();
    expect(DAY_KEYS.every((d) => week[d].closed)).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
describe('summarizeDay', () => {
  it('reads a single shift', () => {
    expect(summarizeDay(openDay('08:00', '22:00'), true)).toBe('08:00 - 22:00');
  });

  it('reads split shifts', () => {
    const day = { closed: false, shifts: [
      { open: '08:00', close: '12:00' }, { open: '16:00', close: '22:00' }] };
    expect(summarizeDay(day, true)).toBe('08:00 - 12:00, 16:00 - 22:00');
  });

  it('says Closed for a closed day', () => {
    expect(summarizeDay(CLOSED_DAY, true)).toBe('Closed');
  });
});

describe('normalizeDay', () => {
  it('upgrades the legacy single-shift shape', () => {
    expect(normalizeDay({ open: '08:00', close: '20:00' })).toEqual({
      closed: false, shifts: [{ open: '08:00', close: '20:00' }], breaks: [],
    });
  });

  it('a closed day carries neither shifts nor breaks', () => {
    expect(normalizeDay({ closed: true, shifts: [{ open: '1', close: '2' }] }))
      .toEqual({ closed: true, shifts: [], breaks: [] });
  });

  it('an absent day is open-but-unset rather than a crash', () => {
    expect(normalizeDay(undefined)).toEqual({ closed: false, shifts: [], breaks: [] });
  });
});
