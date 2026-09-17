import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME,
  applyTheme,
  contrastRatio,
  isHexColour,
  normaliseColour,
  readableTextOn,
} from './tokens.js';

/**
 * The client half of the theme contract.
 *
 * The backend decides what may be stored; this decides what it paints. The
 * cases that matter are the ones where a theme is incomplete or wrong, because
 * those must still produce a usable interface rather than blank variables.
 */

function element() {
  return document.createElement('div');
}

describe('applyTheme', () => {
  it('writes a variable for every token', () => {
    const el = element();
    applyTheme(el, DEFAULT_THEME);
    expect(el.style.getPropertyValue('--color-primary-600')).toBe('#6f4a9e');
    expect(el.style.getPropertyValue('--sidebar-bg')).toBe('#ffffff');
    expect(el.style.getPropertyValue('--header-bg')).toBe('#201b50');
    expect(el.style.getPropertyValue('--table-header-bg')).toBe('#fafbfd');
  });

  it('fills the gaps in a partial theme from the defaults', () => {
    // The API sends only the tokens that differ, so this is the normal case.
    const el = element();
    applyTheme(el, { primary: '#2563eb' });
    expect(el.style.getPropertyValue('--color-primary-600')).toBe('#2563eb');
    expect(el.style.getPropertyValue('--color-danger-600')).toBe(DEFAULT_THEME.danger);
  });

  it('derives the soft tints from the brand colour', () => {
    // Without this the hover and badge fills stay on the previous palette.
    const el = element();
    applyTheme(el, { primary: '#000000' });
    const tint = el.style.getPropertyValue('--color-primary-50');
    expect(tint).toMatch(/^#[0-9a-f]{6}$/);
    expect(tint).not.toBe('#000000');
  });

  it('publishes rgb channels for the colours used at partial opacity', () => {
    const el = element();
    applyTheme(el, { primary: '#2563eb' });
    expect(el.style.getPropertyValue('--color-primary-600-rgb')).toBe('37, 99, 235');
  });

  it('maps the corner style onto the radius scale', () => {
    const el = element();
    applyTheme(el, { cornerStyle: 'square' });
    expect(el.style.getPropertyValue('--radius-md')).toBe('3px');

    applyTheme(el, { cornerStyle: 'rounded' });
    expect(el.style.getPropertyValue('--radius-md')).toBe('16px');
  });

  it('falls back to the soft radius for a corner style it does not know', () => {
    const el = element();
    applyTheme(el, { cornerStyle: 'spiky' });
    expect(el.style.getPropertyValue('--radius-md')).toBe('10px');
  });

  it('does nothing without an element rather than throwing', () => {
    // Called from an effect, where the ref can be null on the first pass.
    expect(() => applyTheme(null, DEFAULT_THEME)).not.toThrow();
  });

  it('scopes to the element it is given', () => {
    // This is what keeps the settings preview out of everyone else's session.
    const preview = element();
    applyTheme(preview, { primary: '#ff0000' });
    expect(preview.style.getPropertyValue('--color-primary-600')).toBe('#ff0000');
    expect(document.documentElement.style.getPropertyValue('--color-primary-600')).toBe('');
  });
});

describe('contrast', () => {
  it('scores the extremes correctly', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
  });

  it('does not depend on the order of the pair', () => {
    expect(contrastRatio('#123456', '#abcdef'))
      .toBe(contrastRatio('#abcdef', '#123456'));
  });

  it('agrees with the backend on the shipped palette', () => {
    // Both halves run the same WCAG formula; if they diverge, the warning an
    // administrator sees would not match the one that gates the save.
    expect(contrastRatio(DEFAULT_THEME.headerText, DEFAULT_THEME.headerBg))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(DEFAULT_THEME.buttonPrimaryText, DEFAULT_THEME.buttonPrimaryBg))
      .toBeGreaterThanOrEqual(4.5);
  });

  it('suggests the legible text colour for a background', () => {
    expect(readableTextOn('#ffffff')).toBe('#1c1a36');
    expect(readableTextOn('#111111')).toBe('#ffffff');
  });
});

describe('colour parsing', () => {
  it.each(['#abc', '#AABBCC', '#2563eb'])('accepts %s', (value) => {
    expect(isHexColour(value)).toBe(true);
  });

  it.each(['red', 'rgb(1,2,3)', '#12', '', null, 'javascript:alert(1)'])(
    'rejects %s', (value) => {
      expect(isHexColour(value)).toBe(false);
    },
  );

  it('expands and lowercases shorthand', () => {
    expect(normaliseColour('#ABC')).toBe('#aabbcc');
    expect(normaliseColour('#2563EB')).toBe('#2563eb');
  });

  it('leaves an invalid value alone so the field can show the error', () => {
    expect(normaliseColour('nope')).toBe('nope');
  });
});
