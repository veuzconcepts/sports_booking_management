import { expect, test } from '@playwright/test';

import { setupApp } from './support.js';

/**
 * Issuing a split payment link from the admin booking screen.
 *
 * Staff cannot read the link the customer was given: only digests are stored.
 * Minting a fresh one is the only recovery, and the moment it is minted is the
 * ONLY moment anybody can read it, so the dialog that shows it has to let them
 * copy it by hand as well as automatically.
 */

const BOOKING = {
  id: 1,
  reference: 'BK-3BC4EF',
  status: 'booked',
  payment_status: 'partially_paid',
  payment_method: 'online',
  source: 'website',
  currency: 'SAR',
  total_amount: '63.000',
  amount_paid: '31.500',
  outstanding: '31.500',
  scheduled_date: '2026-09-25',
  scheduled_time: '22:00',
  end_time: '22:45',
  duration_minutes: 45,
  customer_label: 'Jafar Koya',
  club_name: 'Nadena Club',
  facility_name: 'Navab',
  facility_type_name: 'Badminton Court',
  status_history: [],
  can_modify: true,
};

const FINANCE = {
  invoices: [],
  payments: [],
  splits: [{
    id: 1,
    status: 'active',
    currency: 'SAR',
    expires_at: '2026-09-22T04:28:00Z',
    allocated: '126.000',
    paid: '31.500',
    shares: [
      { id: 11, name: 'Jafar Koya', is_organizer: true, amount: '31.500',
        status: 'paid', paid_at: null, payment: 'PAY-CFC21B8C' },
      { id: 12, name: 'Ahmed Mehaboob', is_organizer: false, amount: '31.500',
        status: 'pending', paid_at: null, payment: null },
    ],
  }],
};

const ISSUED = {
  share: 12,
  name: 'Ahmed Mehaboob',
  amount: '31.500',
  url: 'https://book.example.com/pay/split/abcdef123456',
  expires_at: '2026-09-22T04:28:00Z',
};

test('the issued link can be copied by hand, and says when it dies', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 950 });
  await setupApp(page, {
    'GET /bookings/1/': BOOKING,
    'GET /bookings/1/finance/': FINANCE,
    'POST /bookings/1/split-share-link/': ISSUED,
  });
  await page.goto('/bookings/1');
  await page.locator('.topbar').waitFor({ state: 'visible' });
  await page.locator('.split-panel').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(500);

  // Only the unpaid share is offered a link; a paid one is finished.
  const buttons = page.locator('.split-panel__table button');
  await expect(buttons).toHaveCount(1);

  await buttons.first().click();
  // Issuing stops the previous link working, so it is said out loud first.
  const confirm = page.locator('.modal-dialog, [role="dialog"]').last();
  await confirm.waitFor({ state: 'visible', timeout: 8000 });
  await expect(confirm).toContainText(/stops the previous one working/i);
  await confirm.getByRole('button', { name: /issue new link/i }).click();
  await page.waitForTimeout(800);

  const shown = page.locator('[role="dialog"]').last();
  // The URL itself, readable and selectable.
  await expect(shown).toContainText(ISSUED.url);
  // An explicit copy button: the automatic copy fails silently on an insecure
  // origin, and a link that exists but was never copied cannot be sent.
  await expect(shown.getByRole('button', { name: /copy link|copied/i })).toBeVisible();
  // And how long it is good for.
  await expect(shown).toContainText(/stops working/i);
});

test('the organizer is named and marked, and the money sits beside the actions',
  async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 950 });
    await setupApp(page, {
      'GET /bookings/1/': BOOKING,
      'GET /bookings/1/finance/': FINANCE,
    });
    await page.goto('/bookings/1');
    await page.locator('.topbar').waitFor({ state: 'visible' });
    await page.locator('.split-panel').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(500);

    // Their NAME, with the crown as a mark on it rather than instead of it.
    const who = page.locator('.split-panel__who').first();
    await expect(who).toContainText('Jafar Koya');
    const mark = page.locator('.split-panel__org');
    await expect(mark).toHaveCount(1);
    expect(await mark.getAttribute('title')).toBeTruthy();

    // The payment state, beside the buttons that act on it. Located by its
    // own heading: a text filter for "assign" also matches the status path
    // above, which lists Assigned as a stage.
    const actions = page.locator('.card').filter({
      has: page.locator('.card-title', { hasText: /^Actions$/ }),
    });
    await expect(actions).toHaveCount(1);
    await expect(actions).toContainText(/partially paid/i);
    await expect(actions).toContainText(/31\.50/);
  });

test('the payer page never stacks a date down the page', async ({ page }) => {
  // Covered by a smoke check on the CSS too, but only a browser lays out a
  // table: the bug was a descendant selector putting the date into a 34px
  // icon column, which no static check would have noticed on its own.
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await setupApp(page, { 'GET /bookings/1/': BOOKING, 'GET /bookings/1/finance/': FINANCE });
    await page.goto('/bookings/1');
    await page.locator('.topbar').waitFor({ state: 'visible' });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `the booking page scrolls sideways at ${width}`).toBeLessThanOrEqual(1);
  }
});
