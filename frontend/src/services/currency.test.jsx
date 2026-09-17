import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { formatMoney, currencySymbol, setCurrencyForTests } from './currency.jsx';

/**
 * Money follows the organization's configured currency, everywhere.
 *
 * The dashboard once showed a dollar-sign icon beside a Saudi riyal figure, and
 * money rendered with `$` for the first paint of every session because the
 * module defaulted to USD before the real currency arrived. Neither was caught
 * by anything: both look like ordinary code.
 */

const SRC = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name) && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

const files = walk(SRC)
  .map((file) => ({
    name: path.relative(SRC, file).split(path.sep).join('/'),
    source: fs.readFileSync(file, 'utf8'),
  }))
  // The currency service is the one place a symbol may legitimately appear.
  .filter(({ name }) => name !== 'services/currency.jsx');

describe('currency is never hard-coded', () => {
  it('no component renders a currency-specific icon', () => {
    // A dollar glyph asserts a currency the organization may not use.
    const offenders = files
      .filter(({ source }) => /\bDollarSign\b|\bCurrencyDollar\b|\bEuro\b|\bPoundSterling\b/
        .test(source))
      .map(({ name }) => name);
    expect(offenders, 'use a currency-neutral icon such as Wallet').toEqual([]);
  });

  it('no component prints a currency code as literal UI text', () => {
    const offenders = files
      .filter(({ name }) => !name.startsWith('utils/countries'))
      .filter(({ source }) => />\s*(USD|AED|SAR|EUR|GBP)\s*[<{]/.test(source))
      .map(({ name }) => name);
    expect(offenders, 'render money through Money / formatMoney').toEqual([]);
  });
});

describe('formatting', () => {
  it('uses the configured currency', () => {
    setCurrencyForTests('SAR');
    expect(formatMoney(120)).toBe('SR 120.00');
    expect(currencySymbol()).toBe('SR');
  });

  it('honours a per-record override without changing the default', () => {
    setCurrencyForTests('SAR');
    expect(formatMoney(120, 'KWD')).toBe('KD 120.000');   // dinars use 3 places
    expect(formatMoney(120)).toBe('SR 120.00');
  });

  it('shows the bare number before the currency is known, never a dollar sign', () => {
    setCurrencyForTests('');
    const rendered = formatMoney(120);
    expect(rendered).not.toContain('$');
    expect(rendered).toBe('120.00');
  });

  it('falls back to the code itself for a currency it has no symbol for', () => {
    setCurrencyForTests('SAR');
    expect(currencySymbol('XOF')).toBe('XOF');
  });

  it('follows the currency decimal places, not a fixed two', () => {
    setCurrencyForTests('BHD');
    expect(formatMoney(5)).toBe('BD 5.000');
    setCurrencyForTests('JPY');
    expect(formatMoney(5)).toBe('¥ 5');
  });
});
