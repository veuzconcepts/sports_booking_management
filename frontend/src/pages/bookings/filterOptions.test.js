import { describe, it, expect } from 'vitest';

import bookingsEn from '../../i18n/locales/en/bookings.json';
import commonEn from '../../i18n/locales/en/common.json';

import { bookingSources, bookingStatuses } from '../../services/bookingsService.js';

/**
 * The labels in the Bookings filter drawer.
 *
 * The page used to re-translate what these helpers had already translated,
 * with a different key. For status the second key happened to exist; for
 * source it did not, because `bookings:source` is the column heading
 * "Source", a plain string. Asking for a child of a string gives back the key,
 * so the filter listed "source.admin", "source.phone" and the rest.
 *
 * These pin the helpers as the one place those labels come from.
 */
const CATALOGUES = { bookings: bookingsEn, common: commonEn };

/**
 * i18next's resolution, against the REAL catalogues.
 *
 * A stub with a handful of known keys would pass while the translation was
 * missing, which is the whole bug. Reading the shipped files means the test
 * fails for the same reason the screen did: the key is not there, or it leads
 * to a string rather than an object.
 */
const t = (key) => {
  const [namespace, path] = key.includes(':') ? key.split(':') : ['bookings', key];
  let node = CATALOGUES[namespace];
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return key;   // a leaf, not a branch
    node = node[part];
    if (node === undefined) return key;
  }
  return typeof node === 'string' ? node : key;
};

describe('booking filter options', () => {
  it('would have caught the bug it was written for', () => {
    // SABOTAGE CHECK: exactly what the page used to do.
    const broken = bookingSources(t).map((o) => ({ ...o, label: t(`source.${o.value}`) }));
    expect(broken.some((o) => /^source\./.test(o.label))).toBe(true);
  });

  it('gives every source a real label, not a key', () => {
    for (const option of bookingSources(t)) {
      expect(option.label, option.value).not.toMatch(/^(bookings|common|source)[.:]/);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it('names the sources the operator recognises', () => {
    const byValue = Object.fromEntries(
      bookingSources(t).map((o) => [o.value, o.label]));
    expect(byValue.admin).toBe('Admin');
    expect(byValue.phone).toBe('Phone');
    expect(byValue.walk_in).toBe('Walk-in');
  });

  it('keeps the stored value stable while the label translates', () => {
    // The API keeps receiving 'walk_in' whatever language the page is in.
    expect(bookingSources(t).map((o) => o.value))
      .toEqual(['admin', 'website', 'phone', 'walk_in', 'other']);
  });

  it('gives every status a real label too', () => {
    for (const option of bookingStatuses(t)) {
      expect(option.label, option.value).not.toMatch(/^(bookings|status)[.:]/);
    }
  });

  it('offers draft among the statuses', () => {
    expect(bookingStatuses(t).map((o) => o.value)).toContain('draft');
  });
});
