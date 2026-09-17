import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { themeApi } from '../services/themeService.js';
import { DEFAULT_THEME, applyTheme } from './tokens.js';

/**
 * Resolves the organization theme once, for the whole application.
 *
 * It writes CSS variables onto <html>, so components keep reading
 * `var(--color-primary-600)` and never learn that a theme exists. That is the
 * point: no component branches on the active theme, and a rebrand is one
 * request and one write rather than a change in every page.
 *
 * The palette is fetched from the PUBLIC endpoint so the sign-in screen is
 * branded too. A failure is not an error state: the shipped defaults are
 * already in the stylesheet, so the interface simply stays on them.
 */

const ThemeContext = createContext({
  theme: DEFAULT_THEME,
  branding: {},
  loading: true,
  reload: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

/** Point the browser tab icon at the organization's own favicon. */
function applyFavicon(href) {
  if (!href) return;
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [branding, setBranding] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await themeApi.publicTheme();
      // The endpoint returns a fully resolved palette, but merging over the
      // defaults means an older server that has not learned a new token yet
      // still produces a complete theme.
      setTheme({ ...DEFAULT_THEME, ...(data?.theme || {}) });
      setBranding({
        name: data?.name || '',
        logoLight: data?.logo_light || null,
        logoDark: data?.logo_dark || null,
        favicon: data?.favicon || null,
      });
    } catch {
      setTheme(DEFAULT_THEME);      // bad branding must not break the app
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => { applyTheme(document.documentElement, theme); }, [theme]);
  useEffect(() => { applyFavicon(branding.favicon); }, [branding.favicon]);

  const value = useMemo(
    () => ({ theme, branding, loading, reload: load }),
    [theme, branding, loading, load],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
