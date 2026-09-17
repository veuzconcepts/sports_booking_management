import { test, expect } from '@playwright/test';

import { setupApp } from './support.js';

/**
 * Arabic, in a browser.
 *
 * `src/i18n/parity.test.js` proves every English key has an Arabic string. It
 * cannot prove those strings reach the screen: a namespace that is never
 * registered, a key read under the wrong namespace, or a layout that only works
 * left-to-right all pass a file comparison and fail a reader. This checks the
 * things only a browser knows.
 */

const PAGES = [
  '/dashboard', '/bookings', '/customers', '/staff', '/facilities',
  '/payments', '/invoices', '/promo-codes', '/subscriptions', '/users',
  '/reports', '/organization', '/booking-config', '/website/campaigns',
  '/auditlogs', '/notifications',
];

/**
 * What an untranslated key looks like on screen: a dotted, lowercase, spaceless
 * token such as `bookings.status.booked`. Real prose has spaces.
 */
const RAW_KEY = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9_]*){1,4}$/;

async function openInArabic(page, path) {
  await setupApp(page);
  // Chosen before the app boots, the way the pre-paint script expects.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ui_language', 'ar');
      localStorage.setItem('ui_language_dir', 'rtl');
    } catch { /* private mode: the app falls back, which is also fine */ }
  });
  await page.goto(path);
  await page.locator('.topbar').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
}

for (const path of PAGES) {
  test(`${path} reads right-to-left in Arabic`, async ({ page }) => {
    await openInArabic(page, path);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test(`${path} shows no untranslated keys in Arabic`, async ({ page }) => {
    await openInArabic(page, path);
    const leaked = await page.evaluate((pattern) => {
      const re = new RegExp(pattern);
      const found = new Set();
      document.querySelectorAll('h1,h2,h3,h4,th,td,label,button,a,span,p').forEach((el) => {
        if (el.children.length) return;                  // leaf nodes only
        const text = (el.textContent || '').trim();
        if (text && text.length < 80 && re.test(text)) found.add(text);
      });
      return [...found];
    }, RAW_KEY.source);
    expect(leaked, `raw translation keys on ${path}`).toEqual([]);
  });

  test(`${path} does not scroll sideways in Arabic`, async ({ page }) => {
    await openInArabic(page, path);
    const overflow = await page.evaluate(() => Math.round(
      document.documentElement.scrollWidth - document.documentElement.clientWidth));
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
