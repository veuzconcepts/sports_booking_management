import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the responsive layer honest between browser runs.
 *
 * The e2e suite proves pages do not overflow, but it is slow and only covers
 * the routes it names. These checks are instant and cover every file, so the
 * two patterns that caused the overflow in the first place cannot come back:
 * an invented breakpoint, and a fixed multi-column grid written inline where no
 * media query can reach it.
 */

const SRC = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules']);

// The scale documented at the top of styles/responsive.css.
const ALLOWED = new Set([480, 640, 768, 1024, 1280, 481, 641, 769, 1025, 1281]);

function walk(dir, test, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, test, out);
    } else if (test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

describe('responsive layer', () => {
  it('uses only the documented breakpoints', () => {
    const offenders = [];
    for (const file of walk(SRC, (n) => n.endsWith('.css'))) {
      const css = fs.readFileSync(file, 'utf8');
      for (const match of css.matchAll(/@media[^{]*?\(((?:max|min)-width):\s*(\d+)px/g)) {
        const width = Number(match[2]);
        if (!ALLOWED.has(width)) {
          offenders.push(`${rel(file)}: ${match[1]}: ${width}px`);
        }
      }
    }
    expect(
      offenders,
      `breakpoints outside the shared scale:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps multi-column grids out of inline styles', () => {
    // An inline style cannot carry a media query, so a fixed column list there
    // survives to 375px. `.form-grid` and friends exist for exactly this.
    const offenders = [];
    for (const file of walk(SRC, (n) => /\.jsx?$/.test(n) && !n.includes('.test.'))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/gridTemplateColumns:\s*'([^']+)'/g)) {
        const value = match[1];
        if (/auto-fit|auto-fill/.test(value)) continue;     // already collapses
        // An explicit note means the author weighed it; see BookingCalendar.
        const before = source.slice(Math.max(0, match.index - 220), match.index);
        if (before.includes('responsive-ok')) continue;
        const columns = value.trim().split(/\s+(?![^(]*\))/).length;
        if (columns > 1) offenders.push(`${rel(file)}: ${value}`);
      }
    }
    expect(
      offenders,
      `inline fixed grids (use .form-grid instead):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('does not reintroduce a physical override for a logical rule', () => {
    // rtl.css previously forced `left: 0` onto popovers already anchored with
    // inset-inline-start, which put them on the wrong edge in Arabic.
    const rtl = fs.readFileSync(path.join(SRC, 'styles/rtl.css'), 'utf8');
    const logical = new Set();
    for (const file of walk(SRC, (n) => n.endsWith('.css'))) {
      if (file.endsWith('rtl.css')) continue;
      const css = fs.readFileSync(file, 'utf8');
      for (const match of css.matchAll(/([.#][\w-]+)\s*\{[^}]*inset-inline-(?:start|end)/g)) {
        logical.add(match[1]);
      }
    }
    const offenders = [];
    for (const match of rtl.matchAll(/\[dir="rtl"\]\s*([.#][\w-]+)[^{]*\{([^}]*)\}/g)) {
      if (logical.has(match[1]) && /(?:^|[;\s])(?:left|right)\s*:/.test(match[2])) {
        offenders.push(match[1]);
      }
    }
    expect(
      offenders,
      `physical RTL override for an already-logical rule:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
