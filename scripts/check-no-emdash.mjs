#!/usr/bin/env node
/**
 * UI text standard guard: no em dash (—, U+2014) in user-facing UI source.
 *
 * Rationale: all labels, messages, buttons, table text, empty states, validation
 * messages, notifications and website copy must use the plain keyboard hyphen (-),
 * not the em dash. This scans the presentational source trees (where the em dash
 * is never legitimate) and fails if any is found.
 *
 * Usage:  node scripts/check-no-emdash.mjs
 * Exit 0 = clean, exit 1 = em dash found (prints file:line for each).
 *
 * Note: backend user-facing message strings (DRF `detail`, serializer errors,
 * loyalty/notification text, CMS seed content) must also use hyphens, but Python
 * docstrings/comments there may keep the em dash, so the backend is not scanned
 * wholesale here - see docs/ui-text-standards.md.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EM_DASH = '—';
const SCAN_DIRS = ['frontend/src', 'frontend/e2e', 'web/src'];
const TEXT_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.astro', '.css', '.html']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'assets']);

const hits = [];

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (!SKIP_DIR.has(name)) walk(full);
    } else if (TEXT_EXT.has(extname(name))) {
      const lines = readFileSync(full, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.includes(EM_DASH)) hits.push(`${full}:${i + 1}: ${line.trim()}`);
      });
    }
  }
}

for (const d of SCAN_DIRS) walk(join(ROOT, d));

if (hits.length) {
  console.error(`Found ${hits.length} em dash(es) in UI source. Use a plain hyphen (-) instead:\n`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('OK: no em dash in UI source.');
