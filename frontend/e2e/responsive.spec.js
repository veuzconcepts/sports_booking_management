import { expect, test } from '@playwright/test';

import {
  VIEWPORTS,
  horizontalOverflow,
  overflowingElements,
  setupApp,
} from './support.js';

/**
 * The responsive standard in CLAUDE.md, checked in a real browser.
 *
 * jsdom does no layout, so a unit test cannot tell whether a page overflows.
 * These run Chromium at each width the standard names and assert the thing
 * that actually matters to a user: the page does not slide sideways, and the
 * controls they need are still on screen.
 */

// Representative of every layout family in the application.
const ROUTES = [
  { name: 'Dashboard', path: '/dashboard' },
  { name: 'Bookings list', path: '/bookings' },
  { name: 'Organization info', path: '/organization' },
  { name: 'Booking configuration', path: '/booking-config' },
  { name: 'Clubs and facilities', path: '/clubs' },
  { name: 'Reports', path: '/reports' },
  { name: 'Users', path: '/users' },
];

async function open(page, path) {
  await setupApp(page);
  await page.goto(path);
  // The shell is rendered once the header is present; individual lists settle
  // after their fetch, which the mock answers immediately.
  await page.locator('.topbar').waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
}

/**
 * Wait for the layout to stop moving before measuring it.
 *
 * Panels slide, tables load and fonts swap, and any of those can be wider than
 * the viewport for a frame. Polling asks the question the test actually means:
 * does the page overflow once it has finished arriving?
 */
async function settled(page, label) {
  await expect
    .poll(() => horizontalOverflow(page), { timeout: 5000, message: label })
    .toBeLessThanOrEqual(1);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} (${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of ROUTES) {
      test(`${route.name} does not scroll sideways`, async ({ page }) => {
        await open(page, route.path);
        // The question is whether the SETTLED page overflows. A fixed pause
        // could measure mid-render, which failed when two workers competed for
        // the dev server rather than because a layout was wrong.
        await settled(page, `${route.name} at ${viewport.width}px`);

        const overflow = await horizontalOverflow(page);
        if (overflow > 1) {
          const culprits = await overflowingElements(page);
          throw new Error(
            `${route.name} overflows by ${overflow}px at ${viewport.width}px.\n`
            + JSON.stringify(culprits, null, 2),
          );
        }
      });
    }
  });
}

// Every remaining page, at the widths where layouts actually break.
const ALL_ROUTES = [
  { name: 'Customers', path: '/customers' },
  { name: 'Facilities catalogue', path: '/facilities' },
  { name: 'Promo codes', path: '/promo-codes' },
  { name: 'Staff', path: '/staff' },
  { name: 'Payments', path: '/payments' },
  { name: 'Invoices', path: '/invoices' },
  { name: 'Refunds', path: '/credit-notes' },
  { name: 'Subscriptions', path: '/subscriptions' },
  { name: 'Notifications', path: '/notifications' },
  { name: 'Audit log', path: '/auditlogs' },
  { name: 'System settings', path: '/settings' },
  { name: 'Languages', path: '/languages' },
  { name: 'Loyalty configuration', path: '/loyalty-config' },
  { name: 'Loyalty reports', path: '/loyalty-reports' },
  { name: 'Roles', path: '/roles' },
  { name: 'Website dashboard', path: '/website' },
  { name: 'Media library', path: '/website/media' },
  { name: 'Footer settings', path: '/website/footer' },
  { name: 'Profile', path: '/profile' },
];

const NARROW = VIEWPORTS.filter((v) => [1024, 768, 375].includes(v.width));

for (const viewport of NARROW) {
  test.describe(`${viewport.name} sweep`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of ALL_ROUTES) {
      test(`${route.name} does not scroll sideways`, async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await open(page, route.path);
        // A page that crashed cannot overflow, so a green assertion would be
        // meaningless without this.
        expect(errors, `${route.name} threw: ${errors[0]}`).toEqual([]);

        await settled(page, `${route.name} at ${viewport.width}px`);

        const overflow = await horizontalOverflow(page);
        if (overflow > 1) {
          const culprits = await overflowingElements(page);
          throw new Error(
            `${route.name} overflows by ${overflow}px at ${viewport.width}px.\n`
            + JSON.stringify(culprits, null, 2),
          );
        }
      });
    }
  });
}

test.describe('navigation', () => {
  test('the sidebar is a drawer below the laptop breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await open(page, '/bookings');

    const menuButton = page.locator('.topbar-menu-btn');
    await expect(menuButton).toBeVisible();

    // Closed: the drawer must not cover the content.
    const nav = page.locator('.nav');
    await expect(nav).not.toHaveClass(/\bopen\b/);

    await menuButton.click();
    await expect(nav).toHaveClass(/\bopen\b/);
    await expect(page.locator('.nav-backdrop')).toBeVisible();

    // Opening the drawer must not make the page itself scrollable sideways.
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('the sidebar is docked on a desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/bookings');
    await expect(page.locator('.topbar-menu-btn')).toBeHidden();
    await expect(page.locator('.nav')).toBeVisible();
  });
});

test.describe('business hours', () => {
  test('stacks into day cards on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, '/organization');

    const row = page.locator('.sch-row').first();
    if (await row.count() === 0) test.skip(true, 'schedule not rendered on this tab');
    await row.scrollIntoViewIfNeeded();

    // The desktop header row is hidden and the day card is one column wide.
    await expect(page.locator('.sch-head')).toBeHidden();
    const width = await row.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(375);

    // The two badge cells were both `sch-row__meta`; they must not overlap.
    const breaks = row.locator('.sch-row__breaks');
    const source = row.locator('.sch-row__source');
    if (await breaks.count() && await source.count()) {
      const a = await breaks.boundingBox();
      const b = await source.boundingBox();
      const overlaps = a && b && a.y < b.y + b.height && b.y < a.y + a.height
        && a.x < b.x + b.width && b.x < a.x + a.width;
      expect(overlaps, 'breaks and source badges overlap').toBeFalsy();
    }
  });

  test('stacks inside the club modal as well', async ({ page }) => {
    // Organization, Club and Facility all render ScheduleScopePanel over the
    // same ScheduleEditor, so this proves the shared component, not a copy.
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, '/clubs');

    const newClub = page.getByRole('button', { name: /new club/i }).first();
    if (await newClub.count() === 0) test.skip(true, 'no create action for this role');
    await newClub.click();
    await expect(page.locator('.modal-dialog')).toBeVisible();

    // The editor is revealed by turning off "use the parent schedule".
    const inherit = page.locator('.modal-dialog .sch-source input[type="checkbox"]').first();
    if (await inherit.count()) await inherit.uncheck();

    const row = page.locator('.modal-dialog .sch-row').first();
    await expect(row).toBeVisible();
    await expect(page.locator('.modal-dialog .sch-head')).toBeHidden();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('keeps a tabular row on a desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/organization');
    const head = page.locator('.sch-head');
    if (await head.count() === 0) test.skip(true, 'schedule not rendered on this tab');
    await expect(head.first()).toBeVisible();
  });
});

test.describe('modals', () => {
  test('go full width on a phone and keep their footer reachable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, '/bookings');

    const newBooking = page.getByRole('button', { name: /new booking/i }).first();
    if (await newBooking.count() === 0) test.skip(true, 'no create action for this role');
    await newBooking.click();

    const dialog = page.locator('.modal-dialog');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box.width).toBeGreaterThan(340);        // effectively full width
    expect(box.width).toBeLessThanOrEqual(375);
    expect(box.height).toBeLessThanOrEqual(812);

    const foot = page.locator('.modal-foot');
    if (await foot.count()) {
      const footBox = await foot.boundingBox();
      expect(footBox.y + footBox.height).toBeLessThanOrEqual(812 + 1);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
});

test.describe('listing table', () => {
  test('drops low-priority columns and scrolls inside its own card', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, '/bookings');

    const table = page.locator('.lt').first();
    if (await table.count() === 0) test.skip(true, 'list did not render');

    // Hidden columns are hidden, not merely narrow.
    const lowVisible = await page.locator('.lt-priority-low').evaluateAll(
      (els) => els.filter((el) => getComputedStyle(el).display !== 'none').length,
    );
    expect(lowVisible).toBe(0);

    // Any remaining width is absorbed by the wrapper, not by the page.
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
});

test.describe('sign in', () => {
  /** Reach the sign-in screen with no session, in the given language. */
  async function signIn(page, language) {
    await setupApp(page);
    await page.route('**/api/v1/auth/me/',
      (route) => route.fulfill({ status: 401, json: { detail: 'No session' } }));
    if (language) {
      await page.addInitScript((l) => window.localStorage.setItem('ui_language', l), language);
    }
    await page.goto('/login');
    await page.locator('.auth-form-card').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
  }

  for (const language of ['en', 'ar']) {
    test(`the language switcher sits clear of the form in ${language}`, async ({ page }) => {
      // It used to be a flex sibling of the card, so it sat beside it and its
      // menu opened across the heading.
      await page.setViewportSize({ width: 1440, height: 900 });
      await signIn(page, language);

      await page.locator('.lang__trigger').click();
      const menu = await page.locator('.lang__menu').boundingBox();
      const card = await page.locator('.auth-form-card').boundingBox();

      const clear = menu.y + menu.height <= card.y
        || menu.x + menu.width <= card.x
        || menu.x >= card.x + card.width;
      expect(clear, 'the language menu overlaps the sign-in card').toBe(true);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    });
  }

  test('every option row has the same shape', async ({ page }) => {
    // `dir` on the option button mirrored the whole row, so the Arabic entry
    // laid its columns out backwards.
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, 'ar');
    await page.locator('.lang__trigger').click();

    const ticks = await page.locator('.lang__option .lang__tick').evaluateAll(
      (els) => els.map((el) => Math.round(el.getBoundingClientRect().x)),
    );
    expect(new Set(ticks).size, 'option columns are not aligned').toBe(1);
  });

  test('a remembered language is applied before anything is painted', async ({ page }) => {
    // The provider used to wait for the language catalogue, so a returning
    // Arabic user saw an English page flip direction on every refresh.
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupApp(page);
    await page.addInitScript(() => {
      window.localStorage.setItem('ui_language', 'ar');
      window.localStorage.setItem('ui_language_dir', 'rtl');
    });
    await page.route('**/api/v1/auth/me/',
      (route) => route.fulfill({ status: 401, json: { detail: 'No session' } }));

    // Hold the catalogue open: if direction depended on it, this would fail.
    await page.route('**/api/v1/settings/languages/public/', async (route) => {
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
      return route.fulfill({
        status: 200,
        json: {
          default: 'en',
          languages: [
            { code: 'en', locale: 'en', name: 'English', native_name: 'English', direction: 'ltr', is_default: true },
            { code: 'ar', locale: 'ar', name: 'Arabic', native_name: 'العربية', direction: 'rtl', is_default: false },
          ],
        },
      });
    });

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    // Set by the inline script in index.html, before React has run at all.
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  });

  test('the switcher lists each language once, by its own name', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, 'ar');
    await page.locator('.lang__trigger').click();

    const options = page.locator('.lang__option');
    await expect(options).toHaveCount(2);
    await expect(options.filter({ hasText: 'العربية' })).toHaveCount(1);
    // The English name of a non-English language is not a second column.
    await expect(options.filter({ hasText: 'Arabic' })).toHaveCount(0);
  });

  test('each block of text takes its direction from its own content', async ({ page }) => {
    // Arabic is translated for auth, but Latin content on the same page (the
    // demo email addresses) must still read left to right, with its own
    // punctuation in the right place.
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // Measure only once the Arabic copy is actually on screen; until then the
    // English fallback is showing and lays out the other way.
    await expect(page.locator('.auth-form-card h2')).toContainText('تسجيل');

    /** Where the rendered text sits inside its block. */
    const offsets = (locator) => locator.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { start: text.left - box.left, end: box.right - text.right };
    });

    const arabic = await offsets(page.locator('.auth-form-card p.muted').first());
    expect(arabic.end, 'Arabic copy is not laid out from the right')
      .toBeLessThan(arabic.start);

    const latin = await offsets(page.locator('.auth-form-card .card-body .muted').first());
    expect(latin.start, 'Latin content is not laid out from the left')
      .toBeLessThan(latin.end);
  });
});

test.describe('popovers', () => {
  // All three used to be positioned inside a box that scrolls, so they were
  // clipped on the rows and fields nearest its bottom edge.
  test('the row menu escapes the scrolling table', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/bookings');

    const rows = page.locator('.lt tbody tr');
    await rows.last().locator('.lt-menu button').first().click();

    const menu = page.locator('.lt-menu__pop');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    // Fully on screen, whichever way it had to flip.
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1440);
  });

  test('the schedule and time menus escape the scrolling modal', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/clubs');

    const newClub = page.getByRole('button', { name: /new club/i }).first();
    if (await newClub.count() === 0) test.skip(true, 'no create action for this role');
    await newClub.click();
    await expect(page.locator('.modal-dialog')).toBeVisible();

    const inherit = page.locator('.modal-dialog .sch-source input[type="checkbox"]').first();
    if (await inherit.count()) await inherit.uncheck();

    // The last day is nearest the bottom of the scrolling body.
    await page.locator('.sch-row__menu button').last().click();
    const dayMenu = page.locator('.sch-menu__pop');
    await expect(dayMenu).toBeVisible();
    let box = await dayMenu.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);

    await page.keyboard.press('Escape');
    await page.locator('.sch-row__day').last().click();
    await page.locator('.tp-btn').last().click();

    const times = page.locator('.tp-list');
    await expect(times).toBeVisible();
    box = await times.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
  });

  test('a status badge never wraps onto a second line', async ({ page }) => {
    // "Confirmed" was rendering as "Confirm / ed", which made the row taller
    // and the status harder to scan.
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/bookings');

    const heights = await page.locator('.lt tbody .badge').evaluateAll(
      (els) => els.map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    expect(heights.length).toBeGreaterThan(0);
    expect(Math.max(...heights)).toBeLessThanOrEqual(30);
  });
});

test.describe('right-to-left', () => {
  test('mirrors the shell without overflowing', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await setupApp(page);
    await page.addInitScript(() => window.localStorage.setItem('ui_language', 'ar'));
    await page.goto('/bookings');
    await page.locator('.topbar').waitFor({ state: 'visible' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('mirrors the desktop sidebar to the right edge', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupApp(page);
    await page.addInitScript(() => window.localStorage.setItem('ui_language', 'ar'));
    await page.goto('/bookings');
    await page.locator('.topbar').waitFor({ state: 'visible' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    const nav = await page.locator('.nav').boundingBox();
    expect(nav.x + nav.width).toBeGreaterThan(1400);   // docked on the right
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  /**
   * Slide-over panels mirror, and the way to get this wrong is specific.
   *
   * `justify-content` resolves against the container's direction, so the
   * `flex-end` that anchors a panel to the right in English already means the
   * left in Arabic. Adding a `[dir="rtl"]` override to `flex-start` looks like
   * the mirroring fix and is the opposite of one: it puts the panel back on
   * the right while the shadow beside it is drawn for a panel on the left.
   * The drawer carried exactly that for a while, measured at 1000..1440 in a
   * right-to-left interface.
   *
   * One test per direction rather than one that visits both: `addInitScript`
   * only takes effect on a later navigation, so measuring English and then
   * Arabic on the same page silently measured English twice and read as a
   * mirroring failure.
   */
  const PANELS = [
    ['drawer', 'drawer-backdrop', 'drawer-panel'],
    ['side modal', 'modal-backdrop modal-backdrop--side',
      'modal-dialog modal-dialog--lg modal-dialog--side'],
  ];

  async function panelEdge(page, backdropClass, panelClass) {
    return page.evaluate(([backdrop, panel]) => {
      const host = document.createElement('div');
      host.className = backdrop;
      const inner = document.createElement('div');
      inner.className = panel;
      inner.style.maxWidth = '440px';
      host.appendChild(inner);
      document.body.appendChild(host);
      const box = inner.getBoundingClientRect();
      const out = { left: Math.round(box.left), right: Math.round(box.right) };
      host.remove();
      return out;
    }, [backdropClass, panelClass]);
  }

  for (const [label, backdropClass, panelClass] of PANELS) {
    test(`a ${label} opens from the right in English`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await setupApp(page);
      await page.goto('/bookings');
      await page.locator('.topbar').waitFor({ state: 'visible' });
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

      const box = await panelEdge(page, backdropClass, panelClass);
      expect(box.right).toBeGreaterThan(1400);
    });

    test(`a ${label} opens from the left in Arabic`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.addInitScript(() => window.localStorage.setItem('ui_language', 'ar'));
      await setupApp(page);
      await page.goto('/bookings');
      await page.locator('.topbar').waitFor({ state: 'visible' });
      // Asserted before measuring: a language that failed to apply would
      // otherwise be indistinguishable from a panel on the wrong edge.
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      const box = await panelEdge(page, backdropClass, panelClass);
      expect(box.left).toBeLessThanOrEqual(1);
    });
  }
});
