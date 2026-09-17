import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en/index.js';

/**
 * The single i18next setup for the admin application.
 *
 * Nothing else calls `i18next.init`. Components use `useTranslation(ns)`; code
 * outside React uses the exported `t`. Keeping one instance means a language
 * change is one state change, not a cascade of re-initialisations.
 *
 * ENGLISH is the source language and ships in the main bundle: it is the
 * fallback for every missing key, so it must always be present. Other languages
 * are fetched on demand by `loadLanguage`, so adding a tenth language does not
 * make the first paint slower for someone using the first.
 */
export const NAMESPACES = [
  'common',        // buttons, generic words, shared states
  'navigation',    // sidebar, topbar, breadcrumbs
  'auth',          // sign in, password, MFA
  'table',         // the shared listing framework
  'validation',    // form and field messages
  'auditlogs',
  'bookings',
  'clubs',
  'customers',
  'dashboard',
  'facilities',
  'loyalty',
  'notifications',
  'organization',  // organization profile and branding
  'payments',
  'promotions',
  'reports',
  'roles',
  'schedule',      // business hours, special dates
  'settings',
  'staff',
  'subscriptions',
  'users',
  'website',
];

export const FALLBACK_LANGUAGE = 'en';

/** Languages already fetched, so switching back is instant. */
const loaded = new Set([FALLBACK_LANGUAGE]);

/**
 * Pull in a language's resources. Every namespace for one language arrives in
 * a single chunk: they are small, and a user who switches language wants the
 * whole interface to change, not a page at a time.
 */
export async function loadLanguage(code) {
  if (!code || loaded.has(code)) return true;
  try {
    // The explicit map keeps the bundler able to see every candidate; a bare
    // template import would make it give up and include nothing.
    const loaders = {
      ar: () => import('./locales/ar/index.js'),
    };
    const loader = loaders[code];
    if (!loader) return false;

    const bundle = (await loader()).default;
    Object.entries(bundle).forEach(([ns, resources]) => {
      i18next.addResourceBundle(code, ns, resources, true, true);
    });
    loaded.add(code);
    return true;
  } catch {
    return false;              // stay on the current language rather than break
  }
}

i18next
  .use(initReactI18next)
  .init({
    resources: { [FALLBACK_LANGUAGE]: en },
    lng: FALLBACK_LANGUAGE,
    fallbackLng: FALLBACK_LANGUAGE,
    ns: NAMESPACES,
    defaultNS: 'common',
    // A regional tag falls back to its base language before English, so an
    // "ar-SA" user sees Arabic rather than dropping straight to English.
    nonExplicitSupportedLngs: true,
    load: 'all',
    interpolation: {
      escapeValue: false,      // React escapes for us
    },
    returnNull: false,
    // In development a missing key is worth noticing; in production the
    // English fallback is shown rather than a raw key.
    saveMissing: false,
    missingKeyHandler: import.meta.env.DEV
      ? (lngs, ns, key) => {
        // eslint-disable-next-line no-console
        console.warn(`[i18n] missing key: ${ns}:${key} (${lngs.join(', ')})`);
      }
      : undefined,
    react: {
      useSuspense: false,      // resources are bundled or preloaded, never awaited mid-render
    },
  });

export const t = i18next.t.bind(i18next);
export default i18next;
