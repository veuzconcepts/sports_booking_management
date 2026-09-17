import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';

import i18n, { FALLBACK_LANGUAGE, loadLanguage } from './index.js';
import { languagesApi } from '../services/languagesService.js';

/**
 * Resolves which language the interface runs in, and keeps the document in
 * step with it.
 *
 * The chain, most specific first:
 *
 *     signed-in user's preference
 *       -> the language they last chose in this browser
 *         -> the organization default
 *           -> English
 *
 * A language that an administrator has since disabled drops out of the chain
 * rather than stranding someone on a language nobody maintains. Direction and
 * the document `lang` attribute follow the active language, so RTL is handled
 * once here instead of component by component.
 */
const LanguageContext = createContext(null);

const STORAGE_KEY = 'ui_language';
// The direction is remembered too, so index.html can set it before the first
// paint without waiting for the catalogue.
const DIRECTION_KEY = 'ui_language_dir';

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';                      // private mode or blocked storage
  }
}

function readStoredDirection() {
  try {
    return localStorage.getItem(DIRECTION_KEY) === 'rtl' ? 'rtl' : 'ltr';
  } catch {
    return 'ltr';
  }
}

function writeStored(code, direction) {
  try {
    if (code) {
      localStorage.setItem(STORAGE_KEY, code);
      localStorage.setItem(DIRECTION_KEY, direction || 'ltr');
    } else {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(DIRECTION_KEY);
    }
  } catch { /* the choice simply will not survive a reload */ }
}

/** Put the document in the right language and direction. */
function applyDocument(code, direction) {
  const root = document.documentElement;
  root.setAttribute('lang', code);
  root.setAttribute('dir', direction);
  // A hook for the few styles that genuinely need to know, without every rule
  // having to repeat the attribute selector.
  root.classList.toggle('is-rtl', direction === 'rtl');
}

export function LanguageProvider({ children, user }) {
  const [available, setAvailable] = useState([]);
  const [defaultCode, setDefaultCode] = useState(FALLBACK_LANGUAGE);
  const [language, setLanguage] = useState(i18n.language || FALLBACK_LANGUAGE);
  const [ready, setReady] = useState(false);
  // False until the remembered language is in place. Children are held back
  // for that moment so the first thing painted is not the wrong language.
  const [booted, setBooted] = useState(() => !readStored()
    || readStored() === FALLBACK_LANGUAGE);

  // Optimistic: apply what this browser last chose, without waiting for the
  // catalogue. If an administrator has since disabled that language, the chain
  // below moves off it a moment later.
  useEffect(() => {
    const stored = readStored();
    if (!stored || stored === FALLBACK_LANGUAGE) return undefined;

    let cancelled = false;
    (async () => {
      try {
        if (await loadLanguage(stored)) {
          if (cancelled) return;
          await i18n.changeLanguage(stored);
          setLanguage(stored);
          applyDocument(stored, readStoredDirection());
        }
      } finally {
        if (!cancelled) setBooted(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The catalogue is public so the login page can offer a choice before there
  // is a user to have one.
  useEffect(() => {
    let cancelled = false;
    languagesApi.publicList()
      .then((data) => {
        if (cancelled) return;
        setAvailable(data.languages || []);
        setDefaultCode(data.default || FALLBACK_LANGUAGE);
      })
      .catch(() => {
        if (!cancelled) setAvailable([]);      // fall back to English alone
      })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  const codes = useMemo(() => available.map((l) => l.code), [available]);

  const activate = useCallback(async (code) => {
    const target = codes.includes(code) ? code : null;
    if (!target) return false;
    const loadedOk = target === FALLBACK_LANGUAGE || await loadLanguage(target);
    if (!loadedOk) return false;              // keep the current language

    await i18n.changeLanguage(target);
    setLanguage(target);
    const meta = available.find((l) => l.code === target);
    applyDocument(target, meta?.direction || 'ltr');
    return true;
  }, [codes, available]);

  // Resolve the chain once the catalogue is known, and again whenever the
  // signed-in user changes (sign in, sign out, preference saved elsewhere).
  useEffect(() => {
    if (!ready) return;
    const wanted = [user?.language, readStored(), defaultCode, FALLBACK_LANGUAGE]
      .filter(Boolean)
      .find((code) => codes.includes(code)) || FALLBACK_LANGUAGE;
    activate(wanted);
  }, [ready, user?.language, defaultCode, codes, activate]);

  /** A deliberate choice by the user: remembered, and saved to their profile. */
  const choose = useCallback(async (code) => {
    const ok = await activate(code);
    if (!ok) return false;
    writeStored(code, available.find((l) => l.code === code)?.direction || 'ltr');
    if (user?.id) {
      // Best effort: the interface has already changed, and failing to persist
      // must not undo that.
      languagesApi.savePreference(code).catch(() => {});
    }
    return true;
  }, [activate, user?.id, available]);

  const current = available.find((l) => l.code === language) || null;

  const value = useMemo(() => ({
    language,
    languages: available,
    defaultCode,
    direction: current?.direction || 'ltr',
    isRtl: current?.direction === 'rtl',
    locale: current?.locale || language,
    choose,
    ready,
  }), [language, available, defaultCode, current, choose, ready]);

  return (
    <LanguageContext.Provider value={value}>
      {booted ? children : null}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext) || {
    language: FALLBACK_LANGUAGE,
    languages: [],
    defaultCode: FALLBACK_LANGUAGE,
    direction: 'ltr',
    isRtl: false,
    locale: FALLBACK_LANGUAGE,
    choose: async () => false,
    ready: false,
  };
}
