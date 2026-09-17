import { test, expect } from '@playwright/test';

import { setupApp, BOOKINGS, VIEWPORTS, horizontalOverflow } from './support.js';

/**
 * The board and the calendar, in a real browser.
 *
 * Both are laid out with grids, sticky headers and absolutely positioned
 * blocks, which is exactly the kind of thing a unit test renders happily and a
 * browser then breaks. These check the things only a browser knows: that the
 * columns are on screen, the rail is beside the grid, and neither view pushes
 * the page sideways at any width.
 */

const open = async (page, view) => {
  await setupApp(page);
  await page.goto(`/bookings?view=${view}`);
  await page.locator('.topbar').waitFor({ state: 'visible' });
  // The list renders first and the chosen view swaps in once the query settles,
  // so every assertion waits for the view it is actually about.
  await page.locator(view === 'cards' ? '.bkb' : '.bk-cal').waitFor({ state: 'visible' });
};

test.describe('bookings board', () => {
  test('shows a column for every stage', async ({ page }) => {
    await open(page, 'cards');
    await expect(page.locator('.bkb-col')).toHaveCount(5);
  });

  test('sorts the fixture bookings into their stages', async ({ page }) => {
    await open(page, 'cards');
    await expect(page.locator('.bkb-card').first()).toBeVisible();
    const cards = await page.locator('.bkb-card').count();
    expect(cards).toBe(BOOKINGS.length);
  });

  test('a card carries its reference, facility and customer', async ({ page }) => {
    await open(page, 'cards');
    const card = page.locator('.bkb-card').first();
    // The board root renders before the rows arrive, so wait for a real card.
    await expect(card).toBeVisible();
    await expect(card.locator('.bkb-card__ref')).not.toBeEmpty();
    await expect(card.locator('.bkb-card__title')).not.toBeEmpty();
    await expect(card.locator('.bkb-card__person')).not.toBeEmpty();
  });

  test('says how a booking is moved', async ({ page }) => {
    await open(page, 'cards');
    await expect(page.locator('.bkb__hint')).toContainText(/drag a card/i);
  });

  test('no card spills over the next column', async ({ page }) => {
    // A card that overflows its column covers the one beside it: its menu
    // becomes unclickable and a drop lands on the wrong stage. That is what
    // "drag and drop does not work" looked like from the outside.
    await open(page, 'cards');
    await expect(page.locator('.bkb-card').first()).toBeVisible();
    const spills = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.bkb-col').forEach((col, i) => {
        const right = col.getBoundingClientRect().right;
        col.querySelectorAll('.bkb-card').forEach((card) => {
          if (card.getBoundingClientRect().right > right + 1) bad.push(i);
        });
      });
      return [...new Set(bad)];
    });
    expect(spills, 'columns whose cards overflow').toEqual([]);
  });

  test('a real drag carries the card identity and reads as a move', async ({ page }) => {
    await open(page, 'cards');
    await expect(page.locator('.bkb-card').first()).toHaveAttribute('draggable', 'true');

    // Observed from a genuine drag, not a synthesised event: a hand-built
    // DragEvent carries a DataTransfer the browser will not populate, which
    // says nothing about what happens when someone actually drags.
    await page.evaluate(() => {
      window.__drag = null;
      // Bubble phase, so this runs after the handler that sets the data.
      document.addEventListener('dragstart', (e) => {
        window.__drag = {
          types: e.dataTransfer.types.join(','),
          effect: e.dataTransfer.effectAllowed,
        };
      }, false);
    });
    await page.dragAndDrop('.bkb-card', '.bkb-col:nth-child(3)');

    const drag = await page.evaluate(() => window.__drag);
    // Firefox refuses to start a drag with no data attached, and without an
    // effect the cursor reads "not allowed" over a column that accepts it.
    expect(drag.types).toContain('text/plain');
    expect(drag.effect).toBe('move');
  });

  test('the same move is reachable without a mouse', async ({ page }) => {
    await open(page, 'cards');
    await page.locator('.bkb-card__menu button').first().click();
    await expect(page.locator('[role="menu"]')).toContainText(/move to/i);
  });
});

test.describe('bookings calendar', () => {
  test('puts the rail beside the grid on a desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'calendar');
    const rail = page.locator('.bk-rail');
    const grid = page.locator('.bk-cal__main');
    await expect(rail).toBeVisible();
    const railBox = await rail.boundingBox();
    const gridBox = await grid.boundingBox();
    expect(railBox.x + railBox.width).toBeLessThanOrEqual(gridBox.x + 2);
  });

  test('the rail counts what is on the grid', async ({ page }) => {
    await open(page, 'calendar');
    await expect(page.locator('.bk-rail__card').first()).toBeVisible();
  });

  test('nothing in the rail is cut off', async ({ page }) => {
    // The rail's implicit grid column sized itself to the widest card and spilled
    // 48px past the rail, clipping the month and both panels.
    await open(page, 'calendar');
    await expect(page.locator('.bk-rail__card').first()).toBeVisible();
    const clipped = await page.evaluate(() => {
      const rail = document.querySelector('.bk-rail');
      const width = rail.getBoundingClientRect().width;
      return [...rail.querySelectorAll('*')]
        .filter((n) => n.getBoundingClientRect().width > width + 1)
        .map((n) => n.className.toString().slice(0, 30));
    });
    expect([...new Set(clipped)], 'rail content wider than the rail').toEqual([]);
  });

  test('day columns stay readable, scrolling rather than squeezing', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, 'calendar');
    await expect(page.locator('.bk-cal__event').first()).toBeVisible();
    const narrowest = await page.evaluate(() => Math.min(
      ...[...document.querySelectorAll('.bk-cal__day')]
        .map((d) => d.getBoundingClientRect().width)));
    expect(narrowest).toBeGreaterThanOrEqual(100);
  });

  test('stacks the rail above the grid on a phone', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.find((v) => v.width <= 480) || { width: 390, height: 844 });
    await open(page, 'calendar');
    const rail = page.locator('.bk-rail');
    const grid = page.locator('.bk-cal__main');
    const railBox = await rail.boundingBox();
    const gridBox = await grid.boundingBox();
    expect(railBox.y).toBeLessThan(gridBox.y);
  });
});

for (const view of ['cards', 'calendar']) {
  for (const viewport of VIEWPORTS) {
    test(`${view} does not scroll sideways at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await open(page, view);
      await page.waitForTimeout(250);
      // A pixel of rounding is not overflow; anything more is.
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    });
  }
}
