import { useEffect, useState } from 'react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { DEFAULT_LOCALE, RESOURCES, dirFor } from './index.js';

/**
 * i18next for the React islands.
 *
 * Both dictionaries are bundled rather than fetched. They are small, and it
 * means switching language never shows a flash of untranslated text or needs a
 * round trip; the alternative (loading a locale on demand) would buy nothing
 * here and cost a visible delay mid-booking.
 *
 * The instance is a module singleton. Astro mounts each island as its own React
 * root, but they share this module inside one bundle, so initialising once and
 * letting every island read it keeps them in step: switch language in the header
 * and the wizard, the popup and the availability strip all follow together.
 */
let instance = null;

export function getI18n(locale = DEFAULT_LOCALE) {
  if (instance) {
    if (locale && instance.language !== locale) instance.changeLanguage(locale);
    return instance;
  }
  instance = i18next.createInstance();
  instance.use(initReactI18next).init({
    lng: locale || DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    resources: Object.fromEntries(
      Object.entries(RESOURCES).map(([code, bundle]) => [code, { translation: bundle }]),
    ),
    interpolation: { escapeValue: false },   // React already escapes
    // A missing key should be visible, not silently blank.
    parseMissingKeyHandler: (key) => key,
    react: { useSuspense: false },
  });
  return instance;
}

/**
 * Wraps an island so everything inside it can call `useTranslation()`.
 *
 * `locale` comes from the server render, so the first paint is already in the
 * right language: an island that worked it out for itself on the client would
 * flash English first.
 */
export function I18n({ locale, children }) {
  const i18n = getI18n(locale);
  // Re-render when the language changes from anywhere (the header switcher
  // navigates, but a client-side change should still propagate).
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((value) => value + 1);
    i18n.on('languageChanged', bump);
    return () => i18n.off('languageChanged', bump);
  }, [i18n]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

/** The writing direction of the active language, for islands that need it. */
export function useDir(locale) {
  return dirFor(locale);
}
