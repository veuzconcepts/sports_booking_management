/**
 * Smoke check for the customer checkout and its translations.
 *
 * This site has no test runner, and `astro build` only proves the files parse:
 * a component that throws on render still builds perfectly and then shows the
 * customer a blank page. That has happened here more than once, always on the
 * payment step, which is the worst possible place for it.
 *
 * So this renders the checkout pieces on the server and asserts the handful of
 * contracts that money and language depend on:
 *
 *   - a payment tile is never offered for a provider the backend does not have;
 *   - the browser never sends an amount it decided for itself;
 *   - the equal-split preview sums back to the booking total exactly;
 *   - every language defines the same keys, and every key the code uses exists.
 *
 * Run it with `npm run check`. It needs no browser and no server.
 *
 * It uses esbuild (already present, as Vite depends on it) to transpile the JSX,
 * because Node cannot import `.jsx` directly.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

// The bundle has to sit inside the project, not in the OS temp directory:
// `react` stays external so the real one is used, and Node can only resolve it
// from a path under this package.
const workDir = join('node_modules', '.cache', 'checkout-smoke');
mkdirSync(workDir, { recursive: true });
const bundlePath = join(workDir, 'bundle.mjs');

const i18nPath = join(workDir, 'i18n.mjs');

// `react-i18next` stays external so the provider here and the hooks inside the
// components are the same module, and therefore share one React context.
await esbuild.build({
  entryPoints: ['src/components/CheckoutPayment.jsx'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundlePath,
  external: ['react', 'react-dom', 'react-i18next'],
  logLevel: 'silent',
});

await esbuild.build({
  entryPoints: ['src/i18n/client.jsx'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: i18nPath,
  external: ['react', 'react-dom', 'react-i18next', 'i18next'],
  logLevel: 'silent',
});

// The shared module imports the locale JSON, which Vite handles but bare Node
// will not without an import attribute, so it is bundled the same way.
const sharedPath = join(workDir, 'shared.mjs');
await esbuild.build({
  entryPoints: ['src/i18n/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: sharedPath,
  logLevel: 'silent',
});

const { createElement: h } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { I18nextProvider } = await import('react-i18next');
const checkout = await import(pathToFileURL(bundlePath).href);
const { getI18n } = await import(pathToFileURL(i18nPath).href);
const { RESOURCES, LOCALES, dirFor, fromAstro, intlLocale, resolveLocale, weekdayStyle } =
  await import(pathToFileURL(sharedPath).href);

const {
  CardForm, PaymentMethods, SplitPanel, SplitToggle,
  blankCard, blankSplit, cardRequest, paymentTiles, previewEqualSplit, splitRequest,
} = checkout;

const failures = [];

function check(name, run) {
  try {
    const result = run();
    if (result === undefined || result === null || result === false) {
      throw new Error('returned nothing');
    }
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL  ${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  return true;
}

/** Render an island the way Astro does, inside a language provider. */
function render(element, locale = 'en') {
  return renderToStaticMarkup(
    h(I18nextProvider, { i18n: getI18n(locale) }, element),
  );
}

const DEMO = {
  card_enabled: true, demo_mode: true, split_enabled: true, split_minutes: 60,
  test_cards: [{ number: '4242424242424242', label: 'Successful payment' }],
  test_expiry: '12/30', test_cvv: '123',
};
const LIVE = { card_enabled: true, demo_mode: false, split_enabled: true, split_minutes: 60 };
const NO_PROVIDER = { card_enabled: false, demo_mode: false, split_enabled: false };

console.log('\nRendering:');

check('method tiles, demo mode', () => render(
  h(PaymentMethods, { method: 'card', config: DEMO, country: 'SA', onPick() {} })));

check('method tiles, no provider', () => render(
  h(PaymentMethods, { method: 'venue', config: NO_PROVIDER, country: 'SA', onPick() {} })));

check('method tiles while splitting', () => render(
  h(PaymentMethods, {
    method: 'card', config: LIVE, country: 'AE', splitOn: true,
    heading: 'Pay your share with', onPick() {},
  })));

check('card form, demo', () => render(
  h(CardForm, { card: blankCard(), setCard() {}, config: DEMO })));

check('card form, compact', () => render(
  h(CardForm, { card: blankCard(), setCard() {}, config: LIVE, compact: true })));

check('split toggle', () => render(h(SplitToggle, { on: false, onChange() {} })));

check('split panel, equal amounts', () => render(
  h(SplitPanel, {
    split: { ...blankSplit(), on: true }, setSplit() {}, total: '29.40',
    currency: 'SAR', organizerName: 'Layla Ahmed', holdMinutes: 60,
  })));

check('split panel, custom amounts', () => render(
  h(SplitPanel, {
    split: {
      ...blankSplit(), on: true, mode: 'custom',
      custom: [
        { name: '', amount: '9.80', isOrganizer: true },
        { name: 'Ali', amount: '9.80' },
        { name: 'Omar', amount: '9.80' },
      ],
    },
    setSplit() {}, total: '29.40', currency: 'SAR',
    organizerName: 'Layla Ahmed', holdMinutes: 60,
  })));

check('the split panel renders in Arabic', () => {
  const html = render(
    h(SplitPanel, {
      split: { ...blankSplit(), on: true }, setSplit() {}, total: '29.40',
      currency: 'SAR', organizerName: 'ليلى', holdMinutes: 60,
    }), 'ar');
  return assert(html.includes(RESOURCES.ar.split.title), 'Arabic copy did not render');
});

console.log('\nWhat the customer is shown:');

check('the equal split preview sums back to the total', () => {
  const shares = previewEqualSplit('29.40', 3);
  const sum = shares.reduce((total, share) => total + Math.round(Number(share) * 100), 0);
  assert(sum === 2940, `shares summed to ${sum}, not 2940`);
  return assert(shares[0] === '9.80', `first share was ${shares[0]}`);
});

check('an odd cent lands on the last share rather than vanishing', () => {
  const shares = previewEqualSplit('100.00', 3);
  return assert(shares.join(',') === '33.33,33.33,33.34', shares.join(','));
});

check('an amount too small to divide shows nothing rather than zeros', () =>
  assert(previewEqualSplit('0.02', 5).length === 0, 'offered impossible shares'));

console.log('\nWhat the backend is allowed to decide:');

check('no card provider means no card tile', () => {
  const keys = paymentTiles({ config: NO_PROVIDER, country: 'SA' }).map((tile) => tile.key);
  assert(!keys.includes('card'), 'a card tile was offered with no provider configured');
  return assert(keys.includes('venue'), 'paying at the venue must always remain');
});

check('a wallet tile stays hidden until a provider supports one', () => {
  const keys = paymentTiles({ config: LIVE, country: 'SA' }).map((tile) => tile.key);
  return assert(!keys.includes('wallet'), 'a wallet tile was offered with no provider');
});

check('paying at the venue is withdrawn while splitting', () => {
  const keys = paymentTiles({ config: LIVE, country: 'SA', splitOn: true })
    .map((tile) => tile.key);
  return assert(!keys.includes('venue'), 'a split cannot be settled at the counter');
});

check('the card tile is labelled for the country', () => {
  // mada is Saudi Arabia's domestic network, so only a Saudi org claims it.
  const sa = paymentTiles({ config: LIVE, country: 'SA' })[0].labelKey;
  const ae = paymentTiles({ config: LIVE, country: 'AE' })[0].labelKey;
  return assert(sa === 'methods.cardMada' && ae === 'methods.card', `${sa} / ${ae}`);
});

console.log('\nWhat leaves the browser:');

check('an equal split sends a headcount, never amounts', () => {
  const body = splitRequest({ ...blankSplit(), on: true, people: 4 });
  assert(!JSON.stringify(body).includes('amount'),
    'an amount the browser chose leaked into the request');
  return assert(body.people === 4, 'the headcount was lost');
});

check('one contact box routes to email or to phone', () => {
  const body = splitRequest({
    ...blankSplit(), on: true, people: 3,
    friends: [
      { name: 'Ali', contact: 'ali@club.sa' },
      { name: 'Omar', contact: '+966500000002' },
    ],
  });
  assert(body.friends[0].email === 'ali@club.sa' && !body.friends[0].phone, 'email misrouted');
  return assert(body.friends[1].phone === '+966500000002' && !body.friends[1].email,
    'phone misrouted');
});

check('the card payload carries only what was typed', () => {
  const body = cardRequest({
    holder: 'Layla Ahmed', number: '4242 4242 4242 4242', expiry: '12/30', cvv: '123',
  });
  assert(body.number === '4242424242424242', `number was ${body.number}`);
  return assert(Object.keys(body).sort().join(',') === 'cvv,expiry,holder,number',
    `unexpected fields: ${Object.keys(body)}`);
});

console.log('\nTranslations:');

/** Every dotted key in a nested dictionary. */
function keysOf(node, prefix = '') {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' ? keysOf(value, path) : [path];
  });
}

const englishKeys = keysOf(RESOURCES.en);
const english = new Set(englishKeys);

// A plural key exists as several suffixed entries, and languages legitimately
// have different numbers of them: English has two forms, Arabic has six. So
// parity is compared on the BASE key, not on the suffixed variants.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const baseKey = (key) => key.replace(PLURAL_SUFFIX, '');
const baseKeys = (bundle) => new Set(keysOf(bundle).map(baseKey));
const englishBases = baseKeys(RESOURCES.en);

check('every language covers exactly the same keys', () => {
  const problems = [];
  for (const { code } of LOCALES) {
    if (code === 'en') continue;
    const theirs = baseKeys(RESOURCES[code]);
    for (const key of englishBases) if (!theirs.has(key)) problems.push(`${code} missing ${key}`);
    for (const key of theirs) if (!englishBases.has(key)) problems.push(`${code} has extra ${key}`);
  }
  return assert(problems.length === 0, problems.slice(0, 8).join('; '));
});

check('Arabic carries its own plural forms', () => {
  // Arabic grammar distinguishes one, two and several; a two-form translation
  // copied from English would read wrong for exactly two add-ons.
  const forms = keysOf(RESOURCES.ar).filter((key) => PLURAL_SUFFIX.test(key));
  const bases = new Set(forms.map(baseKey));
  const problems = [...bases].filter((base) =>
    !forms.includes(`${base}_two`) || !forms.includes(`${base}_few`));
  return assert(problems.length === 0, `missing dual/few forms: ${problems.join(', ')}`);
});

check('no Arabic value is still the English string', () => {
  const read = (node, key) => key.split('.').reduce((branch, part) => branch?.[part], node);
  const untranslated = englishKeys.filter((key) => {
    const source = read(RESOURCES.en, key);
    const target = read(RESOURCES.ar, key);
    if (typeof source !== 'string' || typeof target !== 'string') return false;
    if (source !== target) return false;
    // Placeholders, brand names and pure punctuation are legitimately identical.
    return !/^[\d\s/{}.@:A-Za-z]*$/.test(source);
  });
  return assert(untranslated.length === 0, untranslated.slice(0, 8).join(', '));
});

check('every key the components use actually exists', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'i18n') walk(full);
      } else if (/\.(jsx|js|astro)$/.test(name)) {
        files.push(full);
      }
    }
  };
  walk('src');
  const missing = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [, key] of text.matchAll(/\bt\(\s*'([a-z][\w.]*)'/g)) {
      if (!english.has(key) && !englishBases.has(key)) missing.add(`${key} (${file})`);
    }
  }
  return assert(missing.size === 0, [...missing].slice(0, 8).join(', '));
});

check('Arabic is right to left and English is not', () => {
  assert(dirFor('ar') === 'rtl', 'Arabic must be rtl');
  return assert(dirFor('en') === 'ltr', 'English must be ltr');
});

check('an explicit language choice beats a stored one', () => {
  const locale = resolveLocale({
    url: new URL('https://x.test/book?lang=ar'),
    cookies: { get: () => ({ value: 'en' }) },
    headers: new Headers(),
  });
  return assert(locale === 'ar', `resolved ${locale}`);
});

check('a stored choice beats the browser header', () => {
  const locale = resolveLocale({
    url: new URL('https://x.test/book'),
    cookies: { get: () => ({ value: 'ar' }) },
    headers: new Headers({ 'accept-language': 'en-GB,en;q=0.9' }),
  });
  return assert(locale === 'ar', `resolved ${locale}`);
});

check('an unknown language falls back rather than failing', () => {
  const locale = resolveLocale({
    url: new URL('https://x.test/book?lang=zz'),
    cookies: { get: () => undefined },
    headers: new Headers({ 'accept-language': 'zz-ZZ' }),
  });
  return assert(locale === 'en', `resolved ${locale}`);
});

check('a page still renders when middleware has not run', () => {
  // Astro.locals is an ordinary object. A dev server started before the
  // middleware file existed leaves it empty, and a component that called
  // `Astro.locals.t` then threw and took the whole page down.
  const { t, locale, dir } = fromAstro({
    url: new URL('https://x.test/book?lang=ar'),
    cookies: { get: () => undefined },
    request: { headers: new Headers() },
  });
  assert(typeof t === 'function', 'no translator without middleware');
  assert(locale === 'ar' && dir === 'rtl', `resolved ${locale}/${dir}`);
  return assert(t('nav.clubs') === RESOURCES.ar.nav.clubs, 'translator did not translate');
});

check('no component reads the translator straight off Astro.locals', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.astro$/.test(name)) {
        const text = readFileSync(full, 'utf8');
        // Either shape is the bug: reading a property off `locals`, or
        // destructuring the translator out of it. A page must not depend on
        // middleware having run.
        if (text.includes('Astro.locals')) offenders.push(full);
      }
    }
  };
  walk('src');
  return assert(offenders.length === 0,
    `use fromAstro(Astro) instead: ${offenders.join(', ')}`);
});

console.log('\nRight to left:');

check('dates and months read in the active language', () => {
  const when = new Date(2026, 8, 17);
  const english = when.toLocaleDateString(intlLocale('en'), { month: 'long', year: 'numeric' });
  const arabic = when.toLocaleDateString(intlLocale('ar'), { month: 'long', year: 'numeric' });
  assert(english.includes('September'), `English month was ${english}`);
  assert(!/[A-Za-z]/.test(arabic), `Arabic month still latin: ${arabic}`);
  // Latin digits on purpose, so a date never disagrees with the price beside it.
  return assert(arabic.includes('2026'), `Arabic year was not latin digits: ${arabic}`);
});

check('weekday headings fit a seven column grid', () => {
  const widest = (code) => Math.max(...Array.from({ length: 7 }, (_, index) =>
    new Date(2024, 0, 7 + index)
      .toLocaleDateString(intlLocale(code), { weekday: weekdayStyle(code) }).length));
  assert(widest('en') <= 3, `English heading too wide: ${widest('en')}`);
  // Arabic's short form is the whole word, so the narrow form is the only one
  // that fits. This guards against someone "tidying" it back to short.
  return assert(widest('ar') <= 3, `Arabic heading too wide: ${widest('ar')}`);
});

check('a duration is a translated phrase, not a glued-on unit', () => {
  const english = getI18n('en').t('common.minutes', { count: 45 });
  const arabic = getI18n('ar').t('common.minutes', { count: 45 });
  assert(english === '45 min', `English was ${english}`);
  assert(!/[A-Za-z]/.test(arabic), `Arabic duration still latin: ${arabic}`);
  // Arabic marks the dual, so two minutes is its own word.
  const dual = getI18n('ar').t('common.minutes', { count: 2 });
  return assert(dual !== arabic.replace('45', '2'), 'Arabic dual form not used');
});

check('clock times and money are isolated from bidi reordering', () => {
  // Without <bdi>, the bidi algorithm reorders a left-to-right run inside an
  // Arabic line and "8:00 PM" renders as "PM 8:00". This is what a customer
  // reported, so it is pinned by source.
  const wizard = readFileSync('src/components/BookingWizard.jsx', 'utf8');
  const split = readFileSync('src/components/SplitPay.jsx', 'utf8');
  const problems = [];
  for (const [name, text] of [['BookingWizard', wizard], ['SplitPay', split]]) {
    for (const [line] of text.matchAll(/^.*\bfmtTime\(.*$/gm)) {
      // An aria-label or title is a plain string read linearly by a screen
      // reader, not rendered text, so <bdi> would do nothing there. Visible
      // text is still required to isolate.
      const isAttribute = /\b(aria-label|title)=/.test(line);
      if (!line.includes('<bdi>') && !line.includes('function fmtTime')
          && !isAttribute) {
        problems.push(`${name}: ${line.trim().slice(0, 60)}`);
      }
    }
  }
  if (!wizard.includes('<bdi>{sym} {v}</bdi>')) problems.push('money is not isolated');
  return assert(problems.length === 0, problems.slice(0, 4).join(' | '));
});

check('directional icons mirror but the padlock does not', () => {
  const css = readFileSync('src/styles/payment.css', 'utf8');
  assert(css.includes('[dir="rtl"] .bw__cal-monthbar button svg'),
    'month arrows are not mirrored');
  // A padlock is not directional; flipping it with the arrows looks broken.
  return assert(/\[dir="rtl"\] \.ck__pay svg:first-child[\s\S]{0,80}transform: none/.test(css),
    'the padlock is being mirrored');
});

/**
 * Blank out CSS comments, keeping newlines so line numbers still line up.
 *
 * Written with indexOf rather than a regular expression on purpose: the audit
 * below looks for direction-bound properties, and a comment that merely talks
 * about left and right is not one.
 */
function stripComments(text) {
  const blank = (chunk) => chunk
    .split('')
    .map((character) => (character === '\n' ? character : ' '))
    .join('');
  let out = '';
  let index = 0;
  for (;;) {
    const start = text.indexOf('/*', index);
    if (start < 0) return out + text.slice(index);
    out += text.slice(index, start);
    const end = text.indexOf('*/', start + 2);
    if (end < 0) return out + blank(text.slice(start));
    out += blank(text.slice(start, end + 2));
    index = end + 2;
  }
}

check('no stylesheet uses a direction-bound property', () => {
  // The first pass at this only looked at margin, padding, border and
  // text-align, and missed `right: 50%` written mid-line on the step
  // connector, which is why the progress bar drew on the wrong side in Arabic.
  // This checks every physical form there is.
  const PHYSICAL = [
    [/(^|[;{\s])(margin|padding)-(left|right)\s*:/m, 'margin/padding-left|right'],
    [/(^|[;{\s])border-(left|right)(-\w+)?\s*:/m, 'border-left|right'],
    [/(^|[;{\s])(left|right)\s*:/m, 'left|right inset'],
    [/text-align\s*:\s*(left|right)/m, 'text-align: left|right'],
    [/(float|clear)\s*:\s*(left|right)/m, 'float/clear'],
    [/border-(top|bottom)-(left|right)-radius/m, 'physical corner radius'],
    [/border-radius\s*:\s*[^;}]*([\d.]+[a-z%]*\s+){3}[\d.]/m, 'four-value border-radius'],
    [/background-position\s*:[^;}]*(left|right)/m, 'background-position'],
  ];
  const problems = [];
  for (const name of readdirSync('src/styles')) {
    if (!name.endsWith('.css')) continue;
    // Comments are blanked first: prose like "Right to left:" is not a
    // declaration, and flagging it would teach people to ignore this check.
    // Newlines are kept so the reported line numbers stay accurate.
    const css = stripComments(readFileSync(join('src/styles', name), 'utf8'));
    for (const [pattern, label] of PHYSICAL) {
      css.split('\n').forEach((line, index) => {
        if (pattern.test(line)) problems.push(`${name}:${index + 1} ${label}`);
      });
    }
  }
  return assert(problems.length === 0, problems.slice(0, 6).join(' | '));
});

check('a mirrored icon keeps its mirror on hover', () => {
  // `transform` is one property: a hover rule setting only translateX silently
  // discards the scaleX(-1) that mirrors an arrow, so it flips back under the
  // cursor. Every mirrored selector with a hover nudge must restate both.
  const css = readFileSync('src/styles/booking.css', 'utf8')
    + readFileSync('src/styles/payment.css', 'utf8');
  const mirrored = [...css.matchAll(/\[dir="rtl"\]\s+(\.[\w-]+)[^{,]*\{[^}]*scaleX\(-1\)/g)]
    .map((match) => match[1]);
  const problems = [];
  for (const selector of new Set(mirrored)) {
    const hover = new RegExp(`\\${selector}[^{]*:hover[^{]*\\{[^}]*translateX`, 'g');
    if (!hover.test(css)) continue;
    const paired = new RegExp(`\\[dir="rtl"\\][^{]*\\${selector}[^{]*:hover[^{]*\\{[^}]*scaleX\\(-1\\)[^}]*translateX`);
    if (!paired.test(css)) problems.push(selector);
  }
  return assert(problems.length === 0,
    `hover drops the mirror for: ${problems.join(', ')}`);
});

check('a language choice is remembered without middleware', () => {
  // The fallback path must persist the choice too, not just render it. Without
  // this the language survives the click that carries `?lang=` and is lost on
  // the next request, which is what a dev server with no middleware loaded does.
  const written = [];
  const context = {
    url: new URL('https://x.test/book?lang=ar'),
    cookies: { get: () => undefined, set: (name, value) => written.push([name, value]) },
    request: { headers: new Headers() },
  };
  const { locale } = fromAstro(context);
  assert(locale === 'ar', `resolved ${locale}`);
  return assert(written.some(([name, value]) => name === 'lang' && value === 'ar'),
    `nothing was persisted: ${JSON.stringify(written)}`);
});

check('an inferred language is not written to a cookie', () => {
  // Only a deliberate choice is stored. Persisting what Accept-Language said on
  // a first visit would trap the visitor in it forever.
  const written = [];
  fromAstro({
    url: new URL('https://x.test/book'),
    cookies: { get: () => undefined, set: (...args) => written.push(args) },
    request: { headers: new Headers({ 'accept-language': 'ar-SA' }) },
  });
  return assert(written.length === 0, `wrote ${JSON.stringify(written)}`);
});

// --------------------------------------------------------------------------- //
console.log('\nMulti-slot booking:');

const wizardPath = join(workDir, 'wizard.mjs');
await esbuild.build({
  entryPoints: ['src/components/BookingWizard.jsx'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: wizardPath,
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  // React stays external for the same reason the checkout bundle keeps it so:
  // a second copy gives the component its own hook dispatcher and every
  // render fails with "Invalid hook call".
  external: ['react', 'react-dom', 'react-i18next'],
  logLevel: 'silent',
});
const wizard = await import(pathToFileURL(wizardPath).href);
const wizardSource = readFileSync('src/components/BookingWizard.jsx', 'utf8');

check('a selection survives a refresh on the payment step', () => {
  // Without this every time after the first was dropped and the customer paid
  // for one slot of the several they chose.
  const chosen = [
    { date: '2026-09-17', time: '21:00', end: '21:45' },
    { date: '2026-09-18', time: '09:00', end: '09:45' },
  ];
  const restored = wizard.parseSlotsParam(wizard.formatSlotsParam(chosen));
  return assert(JSON.stringify(restored) === JSON.stringify(chosen),
    JSON.stringify(restored));
});

check('a tampered slot parameter is discarded, not trusted', () => {
  // A URL is user input. Anything that is not exactly a date and two times is
  // dropped rather than carried into a booking request.
  const parsed = wizard.parseSlotsParam(
    'not-a-slot,2026-13-99T99:99~10:00,<script>,2026-09-17T21:00~21:45');
  assert(parsed.length === 1, `kept ${parsed.length}`);
  return assert(parsed[0].date === '2026-09-17', JSON.stringify(parsed));
});

check('a duplicate time cannot be smuggled in twice', () => {
  const parsed = wizard.parseSlotsParam(
    '2026-09-17T21:00~21:45,2026-09-17T21:00~21:45');
  return assert(parsed.length === 1, `kept ${parsed.length}`);
});

check('slots always arrive in chronological order', () => {
  const parsed = wizard.parseSlotsParam(
    '2026-09-19T08:00~08:45,2026-09-17T21:00~21:45,2026-09-17T09:00~09:45');
  return assert(
    parsed.map((s) => `${s.date}T${s.time}`).join(',')
      === '2026-09-17T09:00,2026-09-17T21:00,2026-09-19T08:00',
    JSON.stringify(parsed));
});

check('the wizard never decides the rules for itself', () => {
  // The backend resolves the chain and sends `slot_rules` with availability.
  // A number hard-coded here would drift from it the first time somebody
  // changed a facility.
  assert(wizardSource.includes('data?.slot_rules'), 'slot_rules is not read');
  return assert(!/max_slots_per_booking\s*[:=]\s*\d/.test(wizardSource),
    'a slot maximum is hard-coded in the wizard');
});

check('one time still uses the single-booking endpoint', () => {
  // The proven single-slot checkout must not change shape just because a
  // multi-slot path now exists beside it.
  assert(wizardSource.includes("const many = chosen.length > 1;"),
    'the endpoint is not chosen by slot count');
  return assert(wizardSource.includes("many ? '/api/order' : '/api/book'"),
    'the two endpoints are not selected as expected');
});

check('a partly paid order is never reported as simply paid', () => {
  // Several slots means several charges, so the run can stop halfway. Calling
  // that "failed" would invite paying twice for the settled slots.
  assert(wizardSource.includes("outcome.status === 'partial'"),
    'the partial outcome is not handled');
  return assert(wizardSource.includes('success.partlyPaid'),
    'no message for a partly paid order');
});

check('the order proxy hides the backend like the booking one does', () => {
  const proxy = readFileSync('src/pages/api/order.js', 'utf8');
  assert(proxy.includes('createOrder'), 'does not call the shared client');
  return assert(!proxy.includes('http'), 'the proxy names a backend URL');
});

// --------------------------------------------------------------------------- //
console.log('\nAvailability-aware calendar:');

const calendarSource = readFileSync('src/components/BookingWizard.jsx', 'utf8');

check('the calendar asks the backend which dates are bookable', () => {
  // Section 3: the browser must not decide this from the weekly pattern. A
  // holiday, a maintenance closure and a full day all look open in one.
  assert(calendarSource.includes('/api/availability-calendar'),
    'the month summary endpoint is never called');
  return assert(calendarSource.includes('month?.days'),
    'the summary is fetched but not used');
});

check('a date the backend refuses is disabled, not merely faded', () => {
  // Section 32: a visually disabled date that is still reachable by keyboard
  // is worse than no disabled state at all.
  assert(calendarSource.includes('disabled={off}'), 'day cells are not disabled');
  return assert(calendarSource.includes("t('wizard.when.unavailable')"),
    'a disabled date carries no accessible reason');
});

check('an empty month offers somewhere to go', () => {
  // Section 8 and 27: a customer must not have to press next repeatedly.
  assert(calendarSource.includes('noneThisMonth'), 'no empty-month message');
  assert(calendarSource.includes('next_available'), 'the next date is not read');
  return assert(calendarSource.includes('goToNextAvailable'),
    'there is no action to jump to it');
});

check('a date that empties after the month loaded says so', () => {
  // Section 12: "no times today" and "not any more" are different messages,
  // and the second one has to retire the stale summary.
  assert(calendarSource.includes('wentStale'), 'staleness is not detected');
  return assert(calendarSource.includes('noLongerAvailable'),
    'a date that just filled up reads as if it never had times');
});

check('booking a slot drops the month it belongs to', () => {
  // Otherwise the calendar keeps offering a date its own booking just filled.
  return assert(/availInvalidate[\s\S]{0,400}_monthCache\.delete/.test(calendarSource),
    'invalidating a day leaves the month summary stale');
});

check('the month is fetched once per month, not once per day', () => {
  // Section 6: thirty requests to paint thirty days is the thing this
  // replaces.
  assert(calendarSource.includes('monthBounds'), 'no month range is computed');
  return assert(!/for\s*\([^)]*\)\s*\{[^}]*\/api\/availability-calendar/.test(calendarSource),
    'the summary is fetched in a loop');
});

check('the calendar proxy hides the backend like the others do', () => {
  const proxy = readFileSync('src/pages/api/availability-calendar.js', 'utf8');
  assert(proxy.includes('getAvailabilityCalendar'), 'does not use the shared client');
  return assert(!proxy.includes('http'), 'the proxy names a backend URL');
});

check('a failed summary does not silently disable the whole month', () => {
  // Availability is a UX optimisation. Losing it must degrade to the old
  // behaviour, not to a calendar where nothing can be clicked.
  return assert(calendarSource.includes('availabilityUnknown'),
    'a failed summary has no message');
});

// --------------------------------------------------------------------------- //
console.log('\nOffers and time classification:');

const bookingCss = readFileSync('src/styles/booking.css', 'utf8');
const tokensCss = readFileSync('src/styles/tokens.css', 'utf8');

check('every custom property the booking styles use is actually defined', () => {
  // Twice now a stylesheet has used an invented token with a hard-coded
  // fallback, which silently pins that colour to light mode for ever.
  const used = new Set();
  for (const [, name] of bookingCss.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) used.add(name);
  const defined = new Set();
  for (const source of [tokensCss, bookingCss, readFileSync('src/styles/theme.css', 'utf8')]) {
    for (const [, name] of source.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(name);
  }
  const missing = [...used].filter((name) => !defined.has(name));
  return assert(missing.length === 0, `undefined: ${missing.join(', ')}`);
});

check('an offer colour is defined for dark mode too', () => {
  const dark = tokensCss.slice(tokensCss.indexOf('[data-theme="dark"]'));
  return assert(dark.includes('--offer-ink') && dark.includes('--warm-soft')
    && dark.includes('--cool-soft'), 'a badge colour is light-mode only');
});

check('an offer is only ever shown on a date that can be booked', () => {
  // Section 8: availability first, offer second.
  return assert(calendarSource.includes('offer: known.available ? known.offer || null : null'),
    'an offer can be rendered on an unavailable date');
});

check('a part-of-day offer does not claim the whole day', () => {
  // Section 12: "-20%" on a date discounted only in the morning is a lie.
  return assert(calendarSource.includes('offer.time_limited ?'),
    'a time-limited offer is shown as though it covered the date');
});

check('the browser never computes a discount', () => {
  // Section 14: the label and the price both come from the backend.
  assert(calendarSource.includes('offer.label'), 'the backend label is unused');
  return assert(!/offer\.value\s*[*/]/.test(calendarSource),
    'a discount is being arithmetic-ed in the browser');
});

check('peak and off-peak reach the slot list', () => {
  assert(calendarSource.includes("s.period === 'hot'"), 'peak is never shown');
  return assert(calendarSource.includes("t('wizard.when.offPeak')"),
    'off-peak has no customer wording');
});

// --------------------------------------------------------------------------- //
console.log('\nThe date step actually renders:');

// esbuild proves the file parses. It does not prove the component runs: a
// reference to a prop that was renamed is valid JavaScript and only explodes
// when React evaluates it. That has now shipped three times, always as a blank
// step, so the step is rendered here for real.
const wizardUi = await import(pathToFileURL(wizardPath).href);

const CLUB = { id: 1, name: 'Nadena Club', city: 'Jeddah' };
const ACTIVITY = { id: 3, name: 'Badminton Court', duration_minutes: 45,
                   price: '120.00' };

function renderSchedule(props = {}) {
  return renderToStaticMarkup(h(I18nextProvider, { i18n: getI18n('en') },
    h(wizardUi.Schedule, {
      club: CLUB, facilityType: ACTIVITY, currency: 'SAR',
      values: [], onChange() {}, onContinue() {}, ...props,
    })));
}

check('the date step renders with nothing chosen yet', () => {
  const html = renderSchedule();
  return assert(html.includes('Badminton Court'), 'the step did not render');
});

check('the date step renders with times already chosen', () => {
  // The exact shape that crashed: the summary aside reads the selection.
  const html = renderSchedule({
    values: [
      { date: '2026-09-17', time: '21:00', end: '21:45' },
      { date: '2026-09-18', time: '09:00', end: '09:45' },
    ],
  });
  assert(html.includes('21:00') || html.includes('9:00'),
    'a chosen time is missing from the summary');
  return assert(html.includes('Nadena Club'), 'the club is missing');
});

check('the date step renders in Arabic', () => {
  const html = renderToStaticMarkup(h(I18nextProvider, { i18n: getI18n('ar') },
    h(wizardUi.Schedule, {
      club: CLUB, facilityType: ACTIVITY, currency: 'SAR',
      values: [{ date: '2026-09-17', time: '21:00', end: '21:45' }],
      onChange() {}, onContinue() {},
    })));
  return assert(html.length > 0 && html.includes('bw__cal'),
    'the Arabic render produced nothing');
});

check('the site reads the price field the backend actually sends', () => {
  // The backend renamed this during the CarWash rename and has a test pinning
  // `from_price` OUT of the payload. The site kept reading the old name, so
  // every price it rendered was blank.
  return assert(!calendarSource.includes('from_price'),
    'the wizard still reads the removed from_price field');
});

check('a price that has not arrived waits rather than guessing', () => {
  // Showing the catalogue price and swapping it for the quoted one a moment
  // later reads as the price changing while the customer watches. Nothing is
  // fetched during a server render, so this is exactly that first moment.
  const html = renderSchedule({
    values: [
      { date: '2026-09-19', time: '20:00', end: '20:45' },
      { date: '2026-09-19', time: '21:00', end: '21:45' },
    ],
  });
  assert(html.includes('bw__price-wait'), 'no placeholder while the price loads');
  return assert(!/SAR\s*\d/.test(html),
    'a price was rendered before the backend supplied one');
});

check('neither step falls back to the catalogue price', () => {
  // That fallback is what produced the visible switch.
  assert(!calendarSource.includes('Number(facilityType.price) * Math.max'),
    'the date step still multiplies the catalogue price');
  return assert(!/orderTotal\(quote\)\s*\?\?\s*perSlotTotal/.test(calendarSource),
    'the checkout still falls back to a per-slot figure');
});

check('the date step and the checkout price from the same endpoint', () => {
  // They disagreed once: the date step showed the bare catalogue price while
  // the checkout showed the same booking with add-ons, the offer and VAT.
  const calls = calendarSource.match(/fetch\('\/api\/quote'/g) || [];
  assert(calls.length <= 1, `${calls.length} separate quote calls`);
  assert(calendarSource.includes('const fetchQuote ='), 'no shared quote helper');
  // Both callers go through it.
  const users = calendarSource.match(/fetchQuote\(\{/g) || [];
  return assert(users.length >= 2,
    `only ${users.length} caller uses the shared helper`);
});

check('the quote is asked about the dates that were chosen', () => {
  // A rule limited to a date range or a time of day is skipped entirely when
  // the backend prices "some booking, no date". That is how an offer which
  // ended in September was quoted against a December booking, at a price the
  // real booking would never have charged.
  assert(/slots: slots\.map\(/.test(calendarSource),
    'the quote request carries no dates');
  return assert(calendarSource.includes('slots: chosen'),
    'the checkout does not quote the slots it is about to book');
});

check('the order total comes from the backend, not from multiplication', () => {
  // Multiplying the first slot's price is wrong the moment a selection
  // straddles the end of an offer.
  assert(calendarSource.includes('const orderTotal ='), 'no order total helper');
  return assert(calendarSource.includes('const bookingTotal = orderTotal(quote)'),
    'the checkout does not take its total from the quote');
});

check('a saving is only claimed when every slot costs the same', () => {
  return assert(calendarSource.includes('uniformPricing'),
    'a per-slot saving could be multiplied across differently priced slots');
});

rmSync(workDir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:`);
  failures.forEach((line) => console.error(`  ${line}`));
  process.exit(1);
}
console.log('\nAll checkout checks passed.\n');
