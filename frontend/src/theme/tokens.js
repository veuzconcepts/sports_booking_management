/**
 * The bridge between a stored theme and the stylesheet.
 *
 * The backend owns the token catalogue (apps/settings_app/theme.py); this file
 * owns only the mapping from a token to the CSS variables it drives, plus a
 * copy of the defaults so the interface is styled before the first request
 * returns and stays styled if it never does.
 *
 * Adding a token means adding it in both places: the backend decides what may
 * be stored, this decides what it paints.
 */

/** Mirrors theme.DEFAULTS. Used until the API answers, and if it cannot. */
export const DEFAULT_THEME = {
  primary: '#6f4a9e',
  primaryHover: '#593c80',
  secondary: '#201b50',
  accent: '#e0b43a',

  success: '#059669',
  warning: '#d97706',
  danger: '#dc2626',
  info: '#4f46b5',

  sidebarBg: '#ffffff',
  sidebarText: '#1c1a36',
  sidebarHoverBg: '#efeef6',
  sidebarActiveBg: '#ece2f6',
  sidebarActiveText: '#593c80',
  submenuBg: '#eef1f8',
  headerBg: '#201b50',
  headerText: '#ffffff',

  pageBg: '#f6f6fb',
  cardBg: '#ffffff',
  borderColor: '#e4e2ee',
  textPrimary: '#1c1a36',
  textSecondary: '#6b6a85',

  buttonPrimaryBg: '#6f4a9e',
  buttonPrimaryText: '#ffffff',
  buttonPrimaryHover: '#593c80',
  inputFocus: '#8460b4',
  linkColor: '#6f4a9e',
  linkHoverColor: '#593c80',
  tableHeaderBg: '#fafbfd',
  tableRowHover: '#f5f1fa',
  tableRowSelected: '#ece2f6',

  cornerStyle: 'soft',
};

const CORNERS = {
  square: { sm: '2px', md: '3px', lg: '4px', xl: '6px' },
  soft: { sm: '6px', md: '10px', lg: '14px', xl: '20px' },
  rounded: { sm: '10px', md: '16px', lg: '22px', xl: '28px' },
};

/** Which CSS variables each token writes. One token may drive several. */
const VARIABLES = {
  primary: ['--color-primary-600'],
  primaryHover: ['--color-primary-700'],
  secondary: ['--color-navy'],
  accent: ['--color-gold-500'],

  success: ['--color-success-600'],
  warning: ['--color-warning-600'],
  danger: ['--color-danger-600'],
  info: ['--color-info-600'],

  sidebarBg: ['--sidebar-bg'],
  sidebarText: ['--sidebar-text'],
  sidebarHoverBg: ['--sidebar-hover-bg'],
  sidebarActiveBg: ['--sidebar-active-bg'],
  sidebarActiveText: ['--sidebar-active-text'],
  submenuBg: ['--submenu-bg'],
  headerBg: ['--header-bg'],
  headerText: ['--header-text'],

  pageBg: ['--color-bg'],
  cardBg: ['--color-surface'],
  borderColor: ['--color-border'],
  textPrimary: ['--color-text'],
  textSecondary: ['--color-text-muted'],

  buttonPrimaryBg: ['--btn-primary-bg'],
  buttonPrimaryText: ['--btn-primary-text'],
  buttonPrimaryHover: ['--btn-primary-bg-hover'],
  inputFocus: ['--color-focus'],
  linkColor: ['--color-link'],
  linkHoverColor: ['--color-link-hover'],
  tableHeaderBg: ['--table-header-bg'],
  tableRowHover: ['--table-row-hover'],
  tableRowSelected: ['--table-row-selected'],
};

/** #rrggbb -> "r, g, b", so a token can also be used at partial opacity. */
function channels(hex) {
  const value = String(hex || '').replace('#', '');
  if (value.length !== 6) return null;
  const n = parseInt(value, 16);
  if (Number.isNaN(n)) return null;
  // eslint-disable-next-line no-bitwise
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** Shades used for soft fills (hover tints, badge backgrounds). */
function mix(hex, withWhite) {
  const rgb = channels(hex);
  if (!rgb) return hex;
  const parts = rgb.split(', ').map(Number).map(
    (c) => Math.round(c + (255 - c) * withWhite),
  );
  return `#${parts.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Write a resolved theme onto an element as CSS variables.
 *
 * Passing the preview container instead of `document.documentElement` is what
 * keeps the Branding screen's preview local: the same function, a different
 * scope, so the preview can never be a second implementation that drifts.
 */
export function applyTheme(element, theme) {
  if (!element) return;
  const resolved = { ...DEFAULT_THEME, ...(theme || {}) };
  const style = element.style;

  Object.entries(VARIABLES).forEach(([token, names]) => {
    const value = resolved[token];
    if (!value) return;
    names.forEach((name) => style.setProperty(name, value));
    const rgb = channels(value);
    if (rgb) style.setProperty(`${names[0]}-rgb`, rgb);
  });

  // A few tokens are also used at partial opacity (focus rings, the sign-in
  // hero glow), which needs the channels rather than the hex.
  ['--color-focus', '--color-gold-500'].forEach((name) => {
    const rgb = channels(style.getPropertyValue(name).trim() || resolved.inputFocus);
    if (rgb) style.setProperty(`${name}-rgb`, rgb);
  });

  // Derived steps, so a brand colour brings its own tints with it rather than
  // leaving the soft fills on the previous palette.
  style.setProperty('--color-primary-50', mix(resolved.primary, 0.92));
  style.setProperty('--color-primary-100', mix(resolved.primary, 0.85));
  style.setProperty('--color-primary-200', mix(resolved.primary, 0.72));
  style.setProperty('--color-primary-400', mix(resolved.primary, 0.32));
  style.setProperty('--color-primary-500', mix(resolved.primary, 0.14));
  style.setProperty('--color-success-50', mix(resolved.success, 0.9));
  style.setProperty('--color-warning-50', mix(resolved.warning, 0.9));
  style.setProperty('--color-danger-50', mix(resolved.danger, 0.9));
  style.setProperty('--color-info-50', mix(resolved.info, 0.9));
  style.setProperty('--color-border-soft', mix(resolved.borderColor, 0.5));

  const radius = CORNERS[resolved.cornerStyle] || CORNERS.soft;
  style.setProperty('--radius-sm', radius.sm);
  style.setProperty('--radius-md', radius.md);
  style.setProperty('--radius-lg', radius.lg);
  style.setProperty('--radius-xl', radius.xl);
}

/** WCAG 2.1 relative luminance, for the local contrast hint. */
function luminance(hex) {
  const rgb = channels(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.split(', ').map(Number).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast ratio between two colours, 1 to 21.
 *
 * The backend is authoritative and its report is what gets saved against; this
 * exists so a picker can warn while the administrator is still dragging,
 * without a request per movement.
 */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
}

/** Whichever of near-black or white is legible on this background. */
export function readableTextOn(background) {
  return contrastRatio(background, '#1c1a36') >= contrastRatio(background, '#ffffff')
    ? '#1c1a36'
    : '#ffffff';
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColour(value) {
  return HEX.test(String(value || '').trim());
}

/** `#abc` -> `#aabbcc`, lowercase; anything invalid comes back unchanged. */
export function normaliseColour(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!HEX.test(raw)) return value;
  return raw.length === 4
    ? `#${raw.slice(1).split('').map((c) => c + c).join('')}`
    : raw;
}
