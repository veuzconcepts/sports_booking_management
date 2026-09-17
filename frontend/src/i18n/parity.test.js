import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every English key has a translation in every other language.
 *
 * Without this, a namespace can be added in English and quietly fall back to
 * English everywhere else. That is exactly what happened here: twenty of the
 * twenty-four namespaces were empty stubs, the application rendered perfectly,
 * and nothing failed. A silent fallback is worse than a loud one, because there
 * is nothing to notice.
 *
 * Plural keys are compared by their base name. English needs `_one` and
 * `_other`; Arabic needs six forms. Comparing the raw keys would demand English
 * grow forms it has no use for.
 */

const LOCALES = path.resolve(__dirname, 'locales');
const BASE = 'en';
const PLURAL = /_(zero|one|two|few|many|other)$/;

function flatten(node, prefix = '') {
  const out = {};
  Object.entries(node || {}).forEach(([key, value]) => {
    const full = `${prefix}${key}`;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value, `${full}.`));
    } else {
      out[full] = value;
    }
  });
  return out;
}

const baseName = (key) => key.replace(PLURAL, '');

function read(locale, file) {
  const full = path.join(LOCALES, locale, file);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

const namespaces = fs.readdirSync(path.join(LOCALES, BASE))
  .filter((name) => name.endsWith('.json') && name !== 'index.js');

const languages = fs.readdirSync(LOCALES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== BASE)
  .map((entry) => entry.name);

describe('translation parity', () => {
  it('finds the languages and namespaces it is meant to be guarding', () => {
    expect(namespaces.length).toBeGreaterThan(20);
    expect(languages.length).toBeGreaterThan(0);
  });

  languages.forEach((language) => {
    describe(language, () => {
      namespaces.forEach((file) => {
        it(`${file} covers every English key`, () => {
          const english = new Set(Object.keys(flatten(read(BASE, file))).map(baseName));
          const translated = read(language, file);
          expect(translated, `${language}/${file} is missing entirely`).not.toBeNull();

          const have = new Set(Object.keys(flatten(translated)).map(baseName));
          const missing = [...english].filter((key) => !have.has(key)).sort();
          expect(missing, `untranslated in ${language}/${file}`).toEqual([]);
        });

        it(`${file} has no keys English does not`, () => {
          // A stale key is a rename that was only half applied; it renders
          // nothing and hides the fact that the real key is untranslated.
          const english = new Set(Object.keys(flatten(read(BASE, file))).map(baseName));
          const have = new Set(Object.keys(flatten(read(language, file) || {})).map(baseName));
          const extra = [...have].filter((key) => !english.has(key)).sort();
          expect(extra, `stale keys in ${language}/${file}`).toEqual([]);
        });
      });
    });
  });
});
