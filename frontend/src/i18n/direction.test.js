import { describe, it, expect } from 'vitest';

import { directionFor } from './index.js';

/**
 * Which way a language reads, when the interface has to guess.
 *
 * The catalogue is authoritative: an administrator sets `direction` on each
 * Language row. But the remembered language is applied BEFORE the catalogue
 * loads, and at that moment only the code is known. Guessing "left to right"
 * for everything is what put Arabic text in a left-to-right document.
 */
describe('direction from a language code', () => {
  it('knows the languages that read right to left', () => {
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('he')).toBe('rtl');
    expect(directionFor('fa')).toBe('rtl');
    expect(directionFor('ur')).toBe('rtl');
  });

  it('treats everything else as left to right', () => {
    expect(directionFor('en')).toBe('ltr');
    expect(directionFor('fr')).toBe('ltr');
    expect(directionFor('hi')).toBe('ltr');
  });

  it('ignores the region, which never changes the direction', () => {
    expect(directionFor('ar-SA')).toBe('rtl');
    expect(directionFor('ar_EG')).toBe('rtl');
    expect(directionFor('en-GB')).toBe('ltr');
  });

  it('is not fooled by case', () => {
    expect(directionFor('AR')).toBe('rtl');
    expect(directionFor('Ar-SA')).toBe('rtl');
  });

  it('answers something usable for nonsense', () => {
    // Called during boot with whatever was in storage, which may be anything.
    expect(directionFor('')).toBe('ltr');
    expect(directionFor(null)).toBe('ltr');
    expect(directionFor(undefined)).toBe('ltr');
    expect(directionFor('not-a-language')).toBe('ltr');
  });
});
