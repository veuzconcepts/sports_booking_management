import { expect, test } from '@playwright/test';

import { horizontalOverflow, setupApp } from './support.js';

/**
 * Organization branding, checked where it actually matters: in the browser,
 * against computed styles.
 *
 * A unit test can prove the provider writes a variable. Only a real render can
 * prove the header, the sidebar and the buttons are reading it, which is the
 * whole claim of a centralised theme.
 */

async function open(page, path, options = {}) {
  const { viewport = { width: 1440, height: 900 }, routes = [], waitFor = '.topbar' } = options;
  await page.setViewportSize(viewport);
  await setupApp(page);
  // After setupApp: Playwright tries the most recent handler first, so an
  // override registered earlier would be shadowed by its catch-all.
  for (const [pattern, handler] of routes) await page.route(pattern, handler);
  await page.goto(path);
  await page.locator(waitFor).waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
}

/** The computed value of a CSS variable on <html>. */
function variable(page, name) {
  return page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

test.describe('theme resolution', () => {
  test('the palette reaches the document as CSS variables', async ({ page }) => {
    await open(page, '/dashboard');
    expect(await variable(page, '--color-primary-600')).toBe('#6f4a9e');
    expect(await variable(page, '--header-bg')).toBe('#201b50');
    expect(await variable(page, '--table-header-bg')).toBe('#fafbfd');
  });

  test('the header paints from the theme, not from a literal', async ({ page }) => {
    await open(page, '/dashboard');
    // rgb(32, 27, 80) is #201b50: the header is reading the token.
    const background = await page.locator('.topbar').evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(background).toBe('rgb(32, 27, 80)');
  });

  test('a custom palette repaints the chrome without touching any page', async ({ page }) => {
    await open(page, '/dashboard', {
      routes: [['**/api/v1/settings/theme/public/', (route) => route.fulfill({
        status: 200,
        json: {
          name: 'Riverside',
          theme: { headerBg: '#0b6b3a', headerText: '#ffffff', primary: '#0b6b3a' },
          logo_light: null, logo_dark: null, favicon: null,
        },
      })]],
    });

    expect(await variable(page, '--header-bg')).toBe('#0b6b3a');
    const background = await page.locator('.topbar').evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(background).toBe('rgb(11, 107, 58)');
  });

  test('a branding failure leaves the shipped palette in place', async ({ page }) => {
    // Bad or unreachable branding must never leave the app unstyled.
    await open(page, '/dashboard', {
      routes: [['**/api/v1/settings/theme/public/',
        (route) => route.fulfill({ status: 500, json: {} })]],
    });

    expect(await variable(page, '--color-primary-600')).toBe('#6f4a9e');
    const background = await page.locator('.topbar').evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(background).toBe('rgb(32, 27, 80)');
  });

  test('the sign-in screen is branded before anyone signs in', async ({ page }) => {
    await open(page, '/login', {
      waitFor: '.auth-form-card',
      routes: [
        ['**/api/v1/auth/me/',
          (route) => route.fulfill({ status: 401, json: { detail: 'No session' } })],
        ['**/api/v1/settings/theme/public/', (route) => route.fulfill({
          status: 200,
          json: {
            name: 'Riverside Sports Club',
            theme: { primary: '#0b6b3a' },
            logo_light: null, logo_dark: null, favicon: null,
          },
        })],
      ],
    });

    await expect(page.locator('.auth-form-card')).toBeVisible();
    expect(await variable(page, '--color-primary-600')).toBe('#0b6b3a');
    await expect(page.locator('.auth-hero-brand')).toContainText('Riverside Sports Club');
  });
});

test.describe('branding settings', () => {
  test('the preview is scoped and does not restyle the page', async ({ page }) => {
    await open(page, '/organization?tab=theme');

    const preview = page.locator('.th-preview');
    await expect(preview).toBeVisible();

    const before = await variable(page, '--color-primary-600');

    // Drive the hex field directly: the native colour picker cannot be typed
    // into, and this is the same code path.
    const hex = page.locator('.th-hex').first();
    await hex.fill('#ff0000');
    await hex.blur();

    await expect
      .poll(async () => preview.evaluate(
        (el) => getComputedStyle(el).getPropertyValue('--color-primary-600').trim(),
      ))
      .toBe('#ff0000');

    // The application around it is untouched until Save is pressed.
    expect(await variable(page, '--color-primary-600')).toBe(before);
  });

  test('an invalid colour is refused in the field', async ({ page }) => {
    await open(page, '/organization?tab=theme');
    const hex = page.locator('.th-hex').first();
    await hex.fill('rebeccapurple');
    await expect(page.locator('.th-field__row--invalid').first()).toBeVisible();
    await expect(page.locator('.form-error').first()).toBeVisible();
  });

  test('the save bar appears only once something has changed', async ({ page }) => {
    await open(page, '/organization?tab=theme');
    await expect(page.locator('.th-bar')).toHaveCount(0);

    const hex = page.locator('.th-hex').first();
    await hex.fill('#123456');
    await expect(page.locator('.th-bar')).toBeVisible();
  });

  test('a poor contrast pair is flagged with a way to fix it', async ({ page }) => {
    await open(page, '/organization?tab=theme');

    // Header text the same colour as the header background.
    const fields = page.locator('.th-field');
    const headerBg = fields.filter({ hasText: 'Header background' }).locator('.th-hex');
    await headerBg.fill('#ffffff');

    const failing = page.locator('.th-contrast__item.is-fail');
    await expect(failing.first()).toBeVisible();
    await expect(failing.first().getByRole('button')).toBeVisible();
  });

  test('presets are offered and load into the draft', async ({ page }) => {
    await open(page, '/organization?tab=theme');
    const preset = page.locator('.th-preset').filter({ hasText: 'Professional Blue' });
    await expect(preset).toBeVisible();
    await preset.getByRole('button', { name: /use this theme/i }).click();

    await expect
      .poll(async () => page.locator('.th-preview').evaluate(
        (el) => getComputedStyle(el).getPropertyValue('--color-primary-600').trim(),
      ))
      .toBe('#2563eb');
  });

  test('works on a phone without overflowing', async ({ page }) => {
    await open(page, '/organization?tab=theme', { viewport: { width: 375, height: 812 } });
    await expect(page.locator('.th-preview')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('is read-only without the manage capability', async ({ page }) => {
    await open(page, '/organization?tab=theme', {
      routes: [['**/api/v1/auth/me/', (route) => route.fulfill({
        status: 200,
        json: {
          id: 1,
          email: 'viewer@example.com',
          role: 'manager',
          effective_permissions: ['organization.view'],
        },
      })]],
    });

    await expect(page.locator('.th-preview')).toBeVisible();
    // Frontend hiding is UX only; the backend refuses the write either way.
    await expect(page.locator('.th-bar')).toHaveCount(0);
    await expect(page.locator('.th-hex').first()).toBeDisabled();
  });
});
