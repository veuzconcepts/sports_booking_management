import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor as rtlWaitFor } from '@testing-library/react';

// Activating a language loads its bundle over a dynamic import, so these waits
// are for real async work, not for a render tick.
const WAIT = { timeout: 8000 };
const waitFor = (fn) => rtlWaitFor(fn, WAIT);

import i18n, { FALLBACK_LANGUAGE, NAMESPACES } from './index.js';
import en from './locales/en/index.js';

const publicList = vi.fn();
const savePreference = vi.fn(() => Promise.resolve({}));
vi.mock('../services/languagesService.js', () => ({
  languagesApi: {
    publicList: (...a) => publicList(...a),
    savePreference: (...a) => savePreference(...a),
  },
}));

const { LanguageProvider, useLanguage } = await import('./LanguageProvider.jsx');
const { LanguageSelector } = await import('../components/LanguageSelector.jsx');

const ENGLISH = {
  code: 'en', locale: 'en', name: 'English', native_name: 'English',
  direction: 'ltr', is_default: true,
};
const ARABIC = {
  code: 'ar', locale: 'ar', name: 'Arabic', native_name: 'العربية',
  direction: 'rtl', is_default: false,
};

function Probe() {
  const { language, direction, isRtl, locale } = useLanguage();
  return (
    <div>
      <span data-testid="lang">{language}</span>
      <span data-testid="dir">{direction}</span>
      <span data-testid="rtl">{String(isRtl)}</span>
      <span data-testid="locale">{locale}</span>
    </div>
  );
}

function renderApp({ user = null, languages = [ENGLISH], defaultCode = 'en' } = {}) {
  publicList.mockResolvedValue({ default: defaultCode, languages });
  return render(
    <LanguageProvider user={user}>
      <Probe />
      <LanguageSelector />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
  publicList.mockReset();
  savePreference.mockClear();
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
});

afterEach(async () => {
  await i18n.changeLanguage(FALLBACK_LANGUAGE);
});

// --------------------------------------------------------------------------- //
describe('configuration', () => {
  it('is initialised once, with English as the fallback', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.options.fallbackLng).toContain(FALLBACK_LANGUAGE);
  });

  it('ships every declared namespace in English', () => {
    // English is the fallback for every key, so a namespace missing here would
    // leave whole screens untranslatable.
    NAMESPACES.forEach((ns) => {
      expect(Object.keys(en), `missing namespace: ${ns}`).toContain(ns);
    });
  });

  it('resolves a real string rather than echoing the key', () => {
    expect(i18n.t('common:actions.save')).toBe('Save');
    expect(i18n.t('table:filters')).toBe('Filters');
  });

  it('falls back to English for a key a language has not translated', async () => {
    i18n.addResourceBundle('xx', 'common', { actions: { save: 'Guardar' } }, true, true);
    await i18n.changeLanguage('xx');
    expect(i18n.t('common:actions.save')).toBe('Guardar');
    // Untranslated keys must not surface as raw identifiers.
    expect(i18n.t('common:actions.cancel')).toBe('Cancel');
  });

  it('interpolates rather than concatenating fragments', () => {
    expect(i18n.t('table:selected', { count: 3 })).toBe('3 selected');
    expect(i18n.t('table:sortBy', { column: 'Club' })).toBe('Sort by Club');
  });

  it('handles singular and plural through the key, not string maths', () => {
    expect(i18n.t('table:selected', { count: 1 })).toBe('1 selected');
    expect(i18n.t('table:selected', { count: 9 })).toBe('9 selected');
  });
});

// --------------------------------------------------------------------------- //
describe('resolving which language to use', () => {
  it('uses the organization default when nothing else is set', async () => {
    renderApp({ languages: [ENGLISH, ARABIC], defaultCode: 'ar' });
    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('ar'));
  });

  it('a signed-in user preference beats the default', async () => {
    renderApp({
      user: { id: 1, language: 'ar' },
      languages: [ENGLISH, ARABIC],
      defaultCode: 'en',
    });
    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('ar'));
  });

  it('a language that has been disabled falls back to the default', async () => {
    // Arabic is not in the enabled list, so a stale preference must not strand
    // the user on a language nobody maintains.
    renderApp({ user: { id: 1, language: 'ar' }, languages: [ENGLISH], defaultCode: 'en' });
    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('en'));
  });

  it('falls back to English when the catalogue cannot be loaded', async () => {
    publicList.mockRejectedValue(new Error('offline'));
    render(<LanguageProvider user={null}><Probe /></LanguageProvider>);
    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('en'));
  });

  it('remembers a choice made in this browser', async () => {
    localStorage.setItem('ui_language', 'ar');
    renderApp({ languages: [ENGLISH, ARABIC], defaultCode: 'en' });
    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('ar'));
  });

  it('the user profile beats the browser', async () => {
    localStorage.setItem('ui_language', 'ar');
    renderApp({
      user: { id: 1, language: 'en' },
      languages: [ENGLISH, ARABIC],
      defaultCode: 'ar',
    });
    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('en'));
  });
});

// --------------------------------------------------------------------------- //
describe('direction', () => {
  it('sets the document to RTL for an RTL language', async () => {
    renderApp({ languages: [ENGLISH, ARABIC], defaultCode: 'ar' });
    // The document attributes and the context flag settle in the same effect,
    // but not necessarily in the same commit, so wait for all three together.
    await waitFor(() => {
      expect(document.documentElement.getAttribute('dir')).toBe('rtl');
      expect(document.documentElement.getAttribute('lang')).toBe('ar');
      expect(screen.getByTestId('rtl').textContent).toBe('true');
    });
  });

  it('returns to LTR when switching back', async () => {
    renderApp({ languages: [ENGLISH, ARABIC], defaultCode: 'ar' });
    await waitFor(() => expect(document.documentElement.getAttribute('dir')).toBe('rtl'));

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    // For English the native and English names are the same string, so pick the
    // option by its language rather than by text.
    fireEvent.click(document.querySelector('[role="option"][lang="en"]'));

    await waitFor(() => {
      expect(document.documentElement.getAttribute('dir')).toBe('ltr');
      expect(document.documentElement.getAttribute('lang')).toBe('en');
    });
  });

  it('exposes the locale for formatting, separate from the language', async () => {
    renderApp({
      languages: [{ ...ARABIC, locale: 'ar-SA' }, ENGLISH],
      defaultCode: 'ar',
    });
    await waitFor(() => expect(screen.getByTestId('locale').textContent).toBe('ar-SA'));
  });
});

// --------------------------------------------------------------------------- //
describe('the language selector', () => {
  it('stays hidden when there is nothing to choose between', async () => {
    renderApp({ languages: [ENGLISH] });
    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('en'));
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
  });

  it('offers every enabled language, in its own script', async () => {
    renderApp({ languages: [ENGLISH, ARABIC] });
    await waitFor(() => expect(screen.getByRole('button', { expanded: false })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    const arabic = screen.getByText('العربية');
    expect(arabic).toBeTruthy();

    // The name is isolated so it renders in its own script, while the column
    // and the row keep the interface's direction and stay aligned.
    expect(arabic.tagName.toLowerCase()).toBe('bdi');
    expect(arabic.getAttribute('dir')).toBe('rtl');
    expect(arabic.closest('button').getAttribute('dir')).toBeNull();
    expect(arabic.closest('.lang__native').getAttribute('dir')).toBeNull();

    // A language is listed once, by its own name.
    expect(screen.queryByText('Arabic')).toBeNull();
  });

  it('never offers a disabled language', async () => {
    renderApp({ languages: [ENGLISH] });
    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('en'));
    expect(screen.queryByText('العربية')).toBeNull();
  });

  it('switches immediately and remembers the choice', async () => {
    renderApp({ languages: [ENGLISH, ARABIC], defaultCode: 'en' });
    await waitFor(() => expect(screen.getByRole('button', { expanded: false })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByText('العربية'));

    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('ar'));
    expect(localStorage.getItem('ui_language')).toBe('ar');
  });

  it('saves the choice to the profile of a signed-in user', async () => {
    renderApp({ user: { id: 7, language: '' }, languages: [ENGLISH, ARABIC] });
    await waitFor(() => expect(screen.getByRole('button', { expanded: false })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByText('العربية'));

    await waitFor(() => expect(savePreference).toHaveBeenCalledWith('ar'));
  });

  it('does not save a preference for someone who is not signed in', async () => {
    renderApp({ user: null, languages: [ENGLISH, ARABIC] });
    await waitFor(() => expect(screen.getByRole('button', { expanded: false })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByText('العربية'));

    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('ar'));
    expect(savePreference).not.toHaveBeenCalled();
  });

  it('a failed save does not undo the change the user just saw', async () => {
    savePreference.mockRejectedValueOnce(new Error('offline'));
    renderApp({ user: { id: 7, language: '' }, languages: [ENGLISH, ARABIC] });
    await waitFor(() => expect(screen.getByRole('button', { expanded: false })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByText('العربية'));

    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('ar'));
  });
});

// --------------------------------------------------------------------------- //
describe('translation resources', () => {
  it('English and Arabic declare the same namespaces', async () => {
    const ar = (await import('./locales/ar/index.js')).default;
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
  });

  it('no English value is left as an empty string', () => {
    const empties = [];
    const walk = (node, path) => {
      Object.entries(node).forEach(([key, value]) => {
        if (typeof value === 'string') {
          if (!value.trim()) empties.push(`${path}.${key}`);
        } else if (value && typeof value === 'object') {
          walk(value, `${path}.${key}`);
        }
      });
    };
    Object.entries(en).forEach(([ns, bundle]) => walk(bundle, ns));
    expect(empties).toEqual([]);
  });

  it('no translation uses an em dash', () => {
    const EM_DASH = String.fromCharCode(0x2014);
    // The project-wide rule applies to translation resources too.
    const offenders = [];
    const walk = (node, path) => {
      Object.entries(node).forEach(([key, value]) => {
        if (typeof value === 'string') {
          if (value.includes(EM_DASH)) offenders.push(`${path}.${key}`);
        } else if (value && typeof value === 'object') {
          walk(value, `${path}.${key}`);
        }
      });
    };
    Object.entries(en).forEach(([ns, bundle]) => walk(bundle, ns));
    expect(offenders).toEqual([]);
  });
});
