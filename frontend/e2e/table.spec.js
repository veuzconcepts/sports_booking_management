import { expect, test } from '@playwright/test';

import { setupApp } from './support.js';

/**
 * Column resize and reorder, in a real browser.
 *
 * These cannot be tested in jsdom, which does no layout: the resize bug this
 * file exists for had a correct drag handler, a correct inline style and a
 * correctly saved preference, and the column still did not move. Only a
 * browser that actually lays out a table could tell.
 */

async function openBookings(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupApp(page);
  await page.goto('/bookings');
  await page.locator('.topbar').waitFor({ state: 'visible' });
  await page.locator('.lt').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(600);
}

test('a dragged column actually changes width', async ({ page }) => {
  await openBookings(page);

  const th = page.locator('.lt thead th').nth(1);
  const before = (await th.boundingBox()).width;
  const handle = page.locator('.lt-resize').first();
  const box = await handle.boundingBox();

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  // The table lays out `auto` and is 100% wide, so a bare `width` on a cell is
  // only a hint the browser may ignore. It used to ignore it: the column
  // snapped back to its old size while the saved preference said otherwise, so
  // the width was right everywhere except on screen.
  const after = (await th.boundingBox()).width;
  expect(after, 'the column did not follow the pointer').toBeGreaterThan(before + 60);
});

test('the width survives a reload', async ({ page }) => {
  await openBookings(page);

  const th = page.locator('.lt thead th').nth(1);
  const original = (await th.boundingBox()).width;
  const handle = page.locator('.lt-resize').first();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const resized = (await th.boundingBox()).width;

  await page.reload();
  await page.locator('.lt').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(600);

  const restored = (await page.locator('.lt thead th').nth(1).boundingBox()).width;
  expect(Math.abs(restored - resized), 'the saved width was not applied').toBeLessThan(4);
  // And it is the WIDER one, not simply the same default measured twice.
  expect(restored, 'the restored width is the original default').toBeGreaterThan(original + 60);
});

test('a column can be dragged into a different position', async ({ page }) => {
  await openBookings(page);

  const order = () => page.evaluate(() => [...document.querySelectorAll('.lt thead th')]
    .map((t) => t.getAttribute('data-col')).filter(Boolean));

  const before = await order();
  await page.locator('.lt thead th[data-col="customer"]')
    .dragTo(page.locator('.lt thead th[data-col="reference"]'));
  await page.waitForTimeout(500);

  const after = await order();
  expect(after, 'the column order did not change').not.toEqual(before);
  expect(after.indexOf('customer')).toBeLessThan(after.indexOf('reference'));
});
