import { describe, it, expect } from 'vitest';

import { countryCodeFromName, countryOptions } from './countries.js';

describe('countryCodeFromName', () => {
  it('resolves the display names the country picker actually stores', () => {
    // Organization.country holds a NAME, so this is the exact round-trip that
    // decides which flag a phone field starts on.
    const names = countryOptions().map((o) => o.value);
    expect(names).toContain('United Arab Emirates');
    expect(countryCodeFromName('United Arab Emirates')).toBe('ae');
    expect(countryCodeFromName('India')).toBe('in');
    expect(countryCodeFromName('Saudi Arabia')).toBe('sa');
  });

  it('every option the picker offers resolves to a code', () => {
    const unresolved = countryOptions()
      .map((o) => o.value)
      .filter((n) => !countryCodeFromName(n));
    expect(unresolved).toEqual([]);
  });

  it('accepts the shorthand people type by hand', () => {
    expect(countryCodeFromName('UAE')).toBe('ae');
    expect(countryCodeFromName('uk')).toBe('gb');
    expect(countryCodeFromName('USA')).toBe('us');
  });

  it('is case and whitespace insensitive', () => {
    expect(countryCodeFromName('  india  ')).toBe('in');
    expect(countryCodeFromName('INDIA')).toBe('in');
  });

  it('accepts a bare ISO2 code', () => {
    expect(countryCodeFromName('IN')).toBe('in');
  });

  it('returns empty for blank or unknown, so callers can fall back', () => {
    expect(countryCodeFromName('')).toBe('');
    expect(countryCodeFromName(null)).toBe('');
    expect(countryCodeFromName(undefined)).toBe('');
    expect(countryCodeFromName('Atlantis')).toBe('');
  });
});
