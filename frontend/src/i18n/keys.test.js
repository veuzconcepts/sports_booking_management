import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import en from './locales/en/index.js';
import { NAMESPACES } from './index.js';

/**
 * Guards the two ways translation can silently break.
 *
 * 1. A `t('...')` key with nothing behind it renders the raw key to every user
 *    in every language, because English is the fallback for all of them.
 * 2. A `t(...)` call outside any scope where `t` exists compiles fine and then
 *    throws ReferenceError the first time that code path runs.
 *
 * Both are the kind of mistake a bulk edit makes and a reviewer misses.
 */

const SRC = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'i18n']);

// Modules that receive `t` as an argument instead of calling useTranslation,
// so their namespace is decided by the caller.
const NS_OVERRIDE = { 'pages/website/cmsConfig.jsx': 'website' };

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (/\.jsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC).map((f) => ({
  path: path.relative(SRC, f).split(path.sep).join('/'),
  source: fs.readFileSync(f, 'utf8'),
}));

function resolves(ns, key) {
  let node = en[ns];
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false;
    node = node[part];
  }
  return typeof node === 'string';
}

const USE = /(?<![\w.$])t\(\s*'([^']+)'/g;
const NSDECL = /useTranslation\(\s*\[?\s*'([^']+)'/;

describe('translation keys', () => {
  it('every namespace on disk is registered', () => {
    NAMESPACES.forEach((ns) => expect(Object.keys(en)).toContain(ns));
    Object.keys(en).forEach((ns) => expect(NAMESPACES).toContain(ns));
  });

  it('resolves every literal key used in the application', () => {
    const missing = [];
    files.forEach(({ path: file, source }) => {
      const declared = NSDECL.exec(source);
      const defaultNs = NS_OVERRIDE[file] || (declared ? declared[1] : 'common');
      for (const match of source.matchAll(USE)) {
        const [, raw] = match;
        const [maybeNs, ...rest] = raw.split(':');
        const ns = rest.length ? maybeNs : defaultNs;
        const key = rest.length ? rest.join(':') : raw;
        if (!en[ns]) {
          missing.push(`${file}: unknown namespace in ${raw}`);
        } else if (!resolves(ns, key)
          && !resolves(ns, `${key}_other`)
          && !resolves(ns, `${key}_one`)) {
          missing.push(`${file}: ${ns}:${key}`);
        }
      }
    });
    expect(missing, `unresolved keys:\n${missing.join('\n')}`).toEqual([]);
  });
});
