import { expect, test } from '@playwright/test';

import { horizontalOverflow, overflowingElements, setupApp } from './support.js';

/**
 * The AI Insights panel.
 *
 * The backend tests prove the assistant cannot write and cannot widen its
 * scope. These prove the other half of the claim: the trigger belongs to the
 * Reports page, the panel is a side panel rather than a dialog, and a provider
 * failure leaves the reports working.
 */

const CAPABILITIES = {
  enabled: true,
  suggestions: [
    'Give me a management summary for this month.',
    'Compare this month with last month.',
  ],
  catalogue: [{ name: 'get_booking_summary', category: 'booking', description: 'Bookings' }],
  max_date_range_days: 732,
};

const ANSWER = {
  answer: '1,284 bookings this month, 11% above the same period last month.',
  widgets: [
    {
      type: 'kpi',
      title: 'Bookings',
      items: [{ label: 'Total bookings', value: 1284, format: 'number' }],
    },
    {
      type: 'bar',
      title: 'By status',
      x: 'status',
      y: 'count',
      rows: [{ status: 'confirmed', count: 900 }, { status: 'booked', count: 384 }],
    },
  ],
  report_id: 'abc123',
  meta: [{ date_from: '2026-09-01', date_to: '2026-09-30', scope: 'all clubs' }],
  tools_used: ['get_booking_summary'],
  export_supported: true,
  generated_at: '2026-09-17T10:42:00Z',
  cached: false,
};

async function openReports(page, { routes = [], viewport = { width: 1440, height: 900 } } = {}) {
  await page.setViewportSize(viewport);
  await setupApp(page);
  await page.route('**/api/v1/reports/ai/capabilities/',
    (route) => route.fulfill({ status: 200, json: CAPABILITIES }));
  await page.route('**/api/v1/reports/ai/ask/',
    (route) => route.fulfill({ status: 200, json: ANSWER }));
  // Registered last so a test's own override wins.
  for (const [pattern, handler] of routes) await page.route(pattern, handler);

  await page.goto('/reports');
  await page.locator('.topbar').waitFor({ state: 'visible' });
  await page.waitForTimeout(400);
}

test.describe('the trigger', () => {
  test('sits on the Reports page, not in the application header', async ({ page }) => {
    await openReports(page);
    const trigger = page.locator('.ai-trigger');
    await expect(trigger).toBeVisible();

    // Inside the page content, below the global header.
    const triggerBox = await trigger.boundingBox();
    const topbar = await page.locator('.topbar').boundingBox();
    expect(triggerBox.y).toBeGreaterThanOrEqual(topbar.y + topbar.height);
    await expect(page.locator('.topbar .ai-trigger')).toHaveCount(0);
  });

  test('does not appear on any other page', async ({ page }) => {
    await openReports(page);
    await page.goto('/bookings');
    await page.locator('.topbar').waitFor({ state: 'visible' });
    await expect(page.locator('.ai-trigger')).toHaveCount(0);
  });
});

test.describe('the panel', () => {
  test('slides in from the end edge and is not a dialog', async ({ page }) => {
    await openReports(page);
    await page.locator('.ai-trigger').click();

    const panel = page.locator('.ai-panel');
    await expect(panel).toBeVisible();

    // A side panel, not a modal: no scrim, and the page keeps its own scroll.
    await expect(page.locator('.modal-backdrop, .drawer-scrim')).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow))
      .not.toBe('hidden');

    // Anchored to the right edge on an LTR screen, once the slide-in settles.
    await expect.poll(async () => {
      const box = await panel.boundingBox();
      return Math.round(box.x + box.width);
    }).toBe(1440);

    // The report underneath is still visible and usable.
    await expect(page.locator('.metric-grid').first()).toBeVisible();
  });

  test('suggests questions the user can actually ask', async ({ page }) => {
    await openReports(page);
    await page.locator('.ai-trigger').click();
    await expect(page.locator('.ai-suggestion')).toHaveCount(CAPABILITIES.suggestions.length);
  });

  test('answers a question and renders trusted widgets', async ({ page }) => {
    await openReports(page);
    await page.locator('.ai-trigger').click();
    await page.locator('.ai-suggestion').first().click();

    await expect(page.locator('.ai-answer')).toContainText('1,284 bookings');
    await expect(page.locator('.ai-kpi__value')).toContainText('1284');
    await expect(page.locator('.ai-widget').first()).toBeVisible();
    // Freshness is stated, so a reused answer is distinguishable.
    await expect(page.locator('.ai-turn__meta')).toBeVisible();
  });

  test('never renders model output as markup', async ({ page }) => {
    await openReports(page, {
      routes: [['**/api/v1/reports/ai/ask/', (route) => route.fulfill({
        status: 200,
        json: { ...ANSWER, answer: '<img src=x onerror=alert(1)> 5 bookings.' },
      })]],
    });
    await page.locator('.ai-trigger').click();
    await page.locator('.ai-suggestion').first().click();

    await expect(page.locator('.ai-answer')).toBeVisible();
    // The tag is text, not an element.
    await expect(page.locator('.ai-answer img')).toHaveCount(0);
    await expect(page.locator('.ai-answer')).toContainText('<img');
  });

  test('opens a report into the page workspace', async ({ page }) => {
    await openReports(page);
    await page.locator('.ai-trigger').click();
    await page.locator('.ai-suggestion').first().click();
    await page.getByRole('button', { name: /open full report/i }).click();

    const report = page.locator('.ai-report');
    await expect(report).toBeVisible();
    await expect(report.locator('.ai-report__answer')).toContainText('1,284 bookings');
    // The panel steps aside so the report has the width.
    await expect(page.locator('.ai-panel')).toHaveCount(0);
  });

  test('offers Excel and PDF for a report that has data', async ({ page }) => {
    await openReports(page);
    await page.locator('.ai-trigger').click();
    await page.locator('.ai-suggestion').first().click();

    // Scoped to the answer: the page header has its own export buttons.
    const actions = page.locator('.ai-turn__actions');
    await expect(actions.getByRole('button', { name: /excel/i })).toBeVisible();
    await expect(actions.getByRole('button', { name: /pdf/i })).toBeVisible();
  });

  test('a provider failure leaves the reports working', async ({ page }) => {
    await openReports(page, {
      routes: [['**/api/v1/reports/ai/ask/', (route) => route.fulfill({
        status: 503,
        json: { detail: 'AI Insights is temporarily unavailable.' },
      })]],
    });
    await page.locator('.ai-trigger').click();
    await page.locator('.ai-suggestion').first().click();

    await expect(page.locator('.ai-note--warn')).toContainText('unavailable');
    // The page behind it is untouched.
    await expect(page.locator('.metric-grid').first()).toBeVisible();
  });

  test('says so when the assistant is switched off', async ({ page }) => {
    await openReports(page, {
      routes: [['**/api/v1/reports/ai/capabilities/', (route) => route.fulfill({
        status: 200,
        json: { ...CAPABILITIES, enabled: false, suggestions: [] },
      })]],
    });
    await page.locator('.ai-trigger').click();

    await expect(page.locator('.ai-note--warn')).toBeVisible();
    await expect(page.locator('.ai-panel__composer input')).toBeDisabled();
  });
});

test.describe('responsive', () => {
  for (const [name, viewport] of Object.entries({
    'tablet landscape': { width: 1024, height: 768 },
    'tablet portrait': { width: 768, height: 1024 },
    phone: { width: 375, height: 812 },
  })) {
    test(`the panel fits on ${name} without overflowing`, async ({ page }) => {
      await openReports(page, { viewport });
      await page.locator('.ai-trigger').click();

      const panel = page.locator('.ai-panel');
      await expect(panel).toBeVisible();
      // Rounded: a transform leaves sub-pixel width behind.
      const box = await panel.boundingBox();
      expect(Math.round(box.width)).toBeLessThanOrEqual(viewport.width);

      const overflow = await horizontalOverflow(page);
      if (overflow > 1) {
        throw new Error(`overflows by ${overflow}px:
`
          + JSON.stringify(await overflowingElements(page), null, 2));
      }
    });
  }

  test('takes the full width on a phone', async ({ page }) => {
    await openReports(page, { viewport: { width: 375, height: 812 } });
    await page.locator('.ai-trigger').click();
    const box = await page.locator('.ai-panel').boundingBox();
    expect(Math.round(box.width)).toBe(375);
  });
});

test.describe('right-to-left', () => {
  test('the panel opens from the reading edge', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupApp(page);
    await page.addInitScript(() => {
      window.localStorage.setItem('ui_language', 'ar');
      window.localStorage.setItem('ui_language_dir', 'rtl');
    });
    await page.route('**/api/v1/reports/ai/capabilities/',
      (route) => route.fulfill({ status: 200, json: CAPABILITIES }));
    await page.route('**/api/v1/reports/ai/ask/',
      (route) => route.fulfill({ status: 200, json: ANSWER }));

    await page.goto('/reports');
    await page.locator('.topbar').waitFor({ state: 'visible' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    await page.locator('.ai-trigger').click();
    await expect(page.locator('.ai-panel')).toBeVisible();

    await expect.poll(async () => {
      const box = await page.locator('.ai-panel').boundingBox();
      return Math.round(box.x);
    }).toBe(0);                                   // the left edge, in RTL
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
});
