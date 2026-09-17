import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the Listing Page Layout Standard (CLAUDE.md section 36).
 *
 * The rules are easy to state and easy to break by copying an older page:
 * a listing is a full-page workspace, not a card, and it gets its heading from
 * ListPage so the title, the toolbar, the columns and the row count stay on one
 * gutter. Nothing in a build or a render test notices when a new page drifts
 * back to the old shape, so it is checked here.
 */

const SRC = path.resolve(__dirname, '../..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name) && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

const files = walk(path.join(SRC, 'pages')).map((file) => ({
  name: path.relative(SRC, file).split(path.sep).join('/'),
  source: fs.readFileSync(file, 'utf8'),
}));

const listingPages = files.filter(({ source }) => /<ListView\b/.test(source));

describe('listing page layout standard', () => {
  it('finds the listing pages it is meant to be guarding', () => {
    // A rename that empties this list would make every rule below vacuous.
    expect(listingPages.length).toBeGreaterThan(8);
  });

  it('every listing page builds its heading with ListPage', () => {
    const offenders = listingPages
      .filter(({ source }) => /<PageHeader\b/.test(source))
      .map(({ name }) => name);
    expect(offenders, 'these still use PageHeader beside a ListView').toEqual([]);
  });

  it('no listing page wraps the workspace in a card', () => {
    const offenders = listingPages
      .filter(({ source }) => /className="card"/.test(source))
      .map(({ name }) => name);
    expect(offenders, 'a listing is a full-page workspace, not a card').toEqual([]);
  });

  it('the table surface is the shared one, not a per-page card', () => {
    const table = fs.readFileSync(path.join(__dirname, 'ListTable.jsx'), 'utf8');
    expect(table).not.toMatch(/className="card"/);
    expect(table).toMatch(/className="lv-surface"/);
  });

  it('tab strips use the shared component rather than inline styles', () => {
    const offenders = files
      .filter(({ source }) => /tabBtnStyle/.test(source))
      .map(({ name }) => name);
    expect(offenders, 'use PageTabs instead of an inline tab style').toEqual([]);
  });

  it('the workspace cancels the shell padding from a variable, not a number', () => {
    const css = fs.readFileSync(path.join(__dirname, 'listview.css'), 'utf8');
    const layout = fs.readFileSync(path.join(SRC, 'layouts/layout.css'), 'utf8');
    // Hard-coding the gutter is how the two drift apart.
    expect(css).toMatch(/margin: calc\(var\(--app-gutter, 0px\) \* -1\)/);
    expect(layout).toMatch(/--app-gutter:/);
  });
});
