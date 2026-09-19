/**
 * Localisation for the public site.
 *
 * One dictionary serves both halves of this app: Astro components render on the
 * server and call `translator(locale)`, React islands go through i18next. They
 * read the same JSON files, so a string is never defined twice and the two
 * halves of a page cannot drift out of step.
 *
 * Language is resolved per request rather than per route. The site is fully
 * server-rendered (`output: 'server'`), so there is no build-time reason to
 * duplicate every page under `/ar/`, and a visitor keeps their choice through a
 * cookie instead of through a URL they would have to carry by hand.
 *
 * What this does NOT translate: content authored in the CMS (homepage sections,
 * banners, FAQs, testimonials, footer copy). Those arrive from the backend in
 * whatever language they were written in. Serving them in two languages needs
 * multilingual fields on the CMS models, which is a backend content decision,
 * not something the website can paper over.
 */

import ar from './locales/ar.json';
import en from './locales/en.json';

export const RESOURCES = { en, ar };

export const LOCALES = [
  { code: 'en', label: 'English', native: 'English', dir: 'ltr' },
  { code: 'ar', label: 'Arabic', native: 'العربية', dir: 'rtl' },
];

export const DEFAULT_LOCALE = 'en';
export const LOCALE_COOKIE = 'lang';

const RTL = new Set(['ar', 'he', 'fa', 'ur']);

export function isSupported(code) {
  return LOCALES.some((locale) => locale.code === code);
}

export function dirFor(code) {
  return RTL.has(String(code || '').slice(0, 2).toLowerCase()) ? 'rtl' : 'ltr';
}

export function localeMeta(code) {
  return LOCALES.find((locale) => locale.code === code) || LOCALES[0];
}

/**
 * The language for this request.
 *
 * An explicit `?lang=` wins, because it is the visitor clicking the switcher.
 * Otherwise their stored choice, and only then what their browser asked for.
 * Anything unrecognised falls back rather than 404s: a bad language code should
 * never cost somebody their booking.
 */
export function resolveLocale({ url, cookies, headers } = {}) {
  const requested = url?.searchParams?.get('lang');
  if (requested && isSupported(requested)) return requested;

  const stored = cookies?.get?.(LOCALE_COOKIE)?.value;
  if (stored && isSupported(stored)) return stored;

  const header = headers?.get?.('accept-language') || '';
  for (const part of header.split(',')) {
    const code = part.split(';')[0].trim().slice(0, 2).toLowerCase();
    if (isSupported(code)) return code;
  }
  return DEFAULT_LOCALE;
}

/** Walk a dotted key through a nested dictionary. */
function lookup(dictionary, key) {
  return String(key || '').split('.').reduce(
    (node, part) => (node && typeof node === 'object' ? node[part] : undefined),
    dictionary,
  );
}

/**
 * A translator for Astro components, matching i18next's `{{name}}` syntax so
 * the same JSON file serves the server and the islands.
 *
 * A missing key falls back to English and then to the key itself, which is ugly
 * on screen and therefore gets noticed and fixed, rather than rendering an
 * empty element that nobody spots.
 */
export function translator(locale) {
  const primary = RESOURCES[locale] || RESOURCES[DEFAULT_LOCALE];
  return function t(key, vars) {
    let value = lookup(primary, key);
    if (value === undefined) value = lookup(RESOURCES[DEFAULT_LOCALE], key);
    if (typeof value !== 'string') return key;
    if (!vars) return value;
    return value.replace(/\{\{(\w+)\}\}/g, (match, name) =>
      (vars[name] === undefined ? match : String(vars[name])));
  };
}

/** The same URL with a different language, for the switcher links. */
export function localeHref(url, code) {
  const next = new URL(url);
  next.searchParams.set('lang', code);
  return `${next.pathname}${next.search}`;
}


/**
 * The language for one Astro component, whether or not middleware has run.
 *
 * Middleware normally settles this once per request, and reading its answer is
 * the fast path. But `Astro.locals` is an ordinary object: a dev server that
 * started before the middleware file existed, a route that bypasses it, or an
 * error page rendered outside the pipeline all leave it empty. Calling a `t`
 * that is not there throws during render, which in Astro means the whole page
 * dies rather than one string going missing.
 *
 * So this falls back to resolving the language itself. A translator is never
 * worth a broken page.
 */
export function fromAstro(context) {
  const locals = context?.locals || {};
  if (typeof locals.t === 'function' && locals.locale) {
    return { locale: locals.locale, dir: locals.dir || dirFor(locals.locale), t: locals.t };
  }
  const locale = resolveLocale({
    url: context?.url,
    cookies: context?.cookies,
    headers: context?.request?.headers,
  });
  // Persist here too, not only in middleware. Without this the language works
  // on the click that carries `?lang=` and is lost on the very next request,
  // which is exactly what a dev server that has not loaded the middleware file
  // does. Writing the same cookie from several components in one request is
  // harmless: same name, same value.
  rememberLocale(context, locale);
  return { locale, dir: dirFor(locale), t: translator(locale) };
}

/**
 * Store a DELIBERATE language choice for a year.
 *
 * Only an explicit `?lang=` is remembered. Persisting on every request would
 * freeze whatever `Accept-Language` happened to say on the first visit, and the
 * visitor could never get back to following their browser.
 */
export function rememberLocale(context, locale) {
  if (context?.url?.searchParams?.get('lang') !== locale) return;
  try {
    context.cookies?.set?.(LOCALE_COOKIE, locale, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      httpOnly: false,
    });
  } catch {
    // A response already on its way cannot take another header. Losing the
    // preference is survivable; throwing mid-render is not.
  }
}


/**
 * The BCP-47 tag to hand to `Intl` for this language.
 *
 * Arabic asks for Latin digits (`-u-nu-latn`) on purpose. Month and weekday
 * names read in Arabic, but dates, times and prices stay in the digits the rest
 * of the page uses: mixing Arabic-Indic numerals into a calendar while the
 * prices beside it are in Latin ones looks like a bug, and Saudi web users read
 * both.
 */
export function intlLocale(code) {
  return code === 'ar' ? 'ar-u-nu-latn' : 'en-GB';
}


/**
 * How wide a weekday heading may be in a seven-column calendar.
 *
 * English abbreviates to three letters (Sun, Mon), which fits. Arabic's short
 * form is the whole word (الاثنين, الثلاثاء), which does not, so it uses the
 * narrow form (ح ن ث ر خ ج س) that Arabic calendars conventionally print
 * anyway. This is a typographic constraint, not a preference.
 */
export function weekdayStyle(code) {
  return code === 'ar' ? 'narrow' : 'short';
}
