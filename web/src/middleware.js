import { dirFor, rememberLocale, resolveLocale, translator } from './i18n/index.js';

/**
 * Settles the language once per request, before anything renders.
 *
 * This belongs in middleware rather than in the layout: Astro does not promise
 * that a layout's frontmatter runs before the components passed into its slots,
 * so a layout that resolved the language would sometimes be doing it after the
 * header had already rendered in the wrong one. Middleware runs first, always,
 * and everything downstream reads the same answer from `locals`.
 */
export function onRequest(context, next) {
  const locale = resolveLocale({
    url: context.url,
    cookies: context.cookies,
    headers: context.request.headers,
  });

  // One rule for remembering a choice, shared with the fallback path, so the
  // two cannot drift apart.
  rememberLocale(context, locale);

  context.locals.locale = locale;
  context.locals.dir = dirFor(locale);
  context.locals.t = translator(locale);
  return next();
}
