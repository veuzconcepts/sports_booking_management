// Shared E2E support: sign in as an admin and answer every /api/v1 call from a
// fixture, so the suite exercises real page-level layout and routing without a
// backend or a database.

import { ALL_PERMISSIONS } from './permissions.js';

export const ADMIN = {
  id: 1,
  email: 'admin@example.com',
  full_name: 'Alex Administrator',
  role: 'admin',
  is_super_admin: true,
  language: '',
  effective_permissions: ALL_PERMISSIONS,
};

const ENGLISH = {
  code: 'en', locale: 'en', name: 'English', native_name: 'English',
  direction: 'ltr', is_default: true,
};
const ARABIC = {
  code: 'ar', locale: 'ar', name: 'Arabic', native_name: 'العربية',
  direction: 'rtl', is_default: false,
};

function page(results) {
  return { results, count: results.length, next: null, previous: null };
}

/** A club with a long name, to prove long text does not blow out a layout. */
export const CLUB = {
  id: 1,
  name: 'Riverside Sports and Recreation Club, North Campus',
  is_active: true,
  timezone: 'Asia/Riyadh',
  country: 'Saudi Arabia',
};

/**
 * Dates in the week the calendar opens on, so a booking actually lands in the
 * grid. Fixed dates fall outside the visible range and render nothing, which
 * makes a calendar test look green while testing an empty page.
 */
const thisWeek = (offsetDays) => {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - day.getDay() + offsetDays);   // week starts Sunday
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}`
    + `-${String(day.getDate()).padStart(2, '0')}`;
};

// Field names match the bookings API exactly. They did not, once, and the
// calendar tests passed against a grid that was silently empty.
export const BOOKINGS = [1, 2, 3, 4, 5].map((i) => ({
  id: i,
  reference: `BK-00000${i}`,
  customer_label: 'Abdulrahman Al-Qahtani (Corporate Membership)',
  club_name: CLUB.name,
  facility_type_name: 'Indoor Tennis Court, Championship Standard',
  facility_name: `Court ${i}`,
  scheduled_date: thisWeek(i),
  scheduled_time: `0${8 + i}:00:00`,
  end_time: `0${9 + i}:00:00`,
  duration_minutes: 60,
  status: ['booked', 'confirmed', 'assigned', 'completed', 'cancelled'][i - 1],
  payment_status: 'pending',
  source: 'admin',
  source_display: 'Admin',
  total_amount: '250.000',
  currency: 'SAR',
  can_modify: true,
  can_delete: true,
}));

// Reports render several blocks from one payload shape; an empty but
// well-formed body is the realistic "no data yet" case.
const REPORT = {
  series: [],
  by_status: { booked: 2, confirmed: 3 },
  by_club: [],
  rows: [],
  totals: {},
  net: '0.00',
};

// A complete palette, the shape the theme endpoints return.
const THEME = {
  primary: '#6f4a9e', primaryHover: '#593c80', secondary: '#201b50', accent: '#e0b43a',
  success: '#059669', warning: '#d97706', danger: '#dc2626', info: '#4f46b5',
  sidebarBg: '#ffffff', sidebarText: '#1c1a36', sidebarHoverBg: '#efeef6',
  sidebarActiveBg: '#ece2f6', sidebarActiveText: '#593c80', submenuBg: '#eef1f8',
  headerBg: '#201b50', headerText: '#ffffff',
  pageBg: '#f6f6fb', cardBg: '#ffffff', borderColor: '#e4e2ee',
  textPrimary: '#1c1a36', textSecondary: '#6b6a85',
  buttonPrimaryBg: '#6f4a9e', buttonPrimaryText: '#ffffff', buttonPrimaryHover: '#593c80',
  inputFocus: '#8460b4', linkColor: '#6f4a9e', linkHoverColor: '#593c80',
  tableHeaderBg: '#fafbfd', tableRowHover: '#f5f1fa', tableRowSelected: '#ece2f6',
  cornerStyle: 'soft',
};

const CATALOGUE = [
  { token: 'primary', group: 'brand', label: 'Primary colour', default: '#6f4a9e' },
  { token: 'headerBg', group: 'navigation', label: 'Header background', default: '#201b50' },
  { token: 'headerText', group: 'navigation', label: 'Header text', default: '#ffffff' },
];

const CONTRAST = [
  {
    foreground: 'headerText', background: 'headerBg',
    label: 'Header text on header background', ratio: 14.2, minimum: 4.5, passes: true,
  },
];

const PRESETS = [
  { id: 1, name: 'Default', tokens: {}, resolved: THEME, is_builtin: true, is_archived: false },
  {
    id: 2, name: 'Professional Blue', tokens: { primary: '#2563eb' },
    resolved: { ...THEME, primary: '#2563eb' }, is_builtin: true, is_archived: false,
  },
];

function defaultResponse(method, path) {
  if (path === '/auth/me/') return ADMIN;
  if (path === '/auth/csrf/') return {};
  if (path === '/settings/languages/public/') {
    return { default: 'en', languages: [ENGLISH, ARABIC] };
  }
  if (path === '/settings/currency/') {
    return {
      currency: 'SAR',
      code: 'SAR',
      symbol: 'SAR',
      decimals: 2,
      choices: [
        { code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', decimals: 2 },
        { code: 'AED', name: 'UAE Dirham', symbol: 'AED', decimals: 2 },
      ],
    };
  }
  if (path === '/settings/organization/') {
    return {
      id: 1,
      name: 'Riverside Group Holdings International',
      country: 'Saudi Arabia',
      timezone: 'Asia/Riyadh',
      currency: 'SAR',
      time_format_24h: false,
      week: {},
      social: {},
    };
  }
  if (path === '/settings/booking-config/') return { channels: {}, rules: {} };
  if (path === '/settings/theme/public/') {
    return { name: 'Riverside', theme: THEME, logo_light: null, logo_dark: null, favicon: null };
  }
  if (path === '/settings/theme/') {
    return {
      theme: {},
      resolved: THEME,
      defaults: THEME,
      catalogue: CATALOGUE,
      groups: { brand: 'Brand', navigation: 'Navigation' },
      corner_styles: ['square', 'soft', 'rounded'],
      preset_name: '',
      contrast: CONTRAST,
    };
  }
  if (path === '/settings/theme-presets/') return PRESETS;
  if (path === '/bookings/') return page(BOOKINGS);
  // Two of the report endpoints answer with a bare list.
  if (path === '/reports/services/' || path === '/reports/performance/') return [];
  if (path.startsWith('/reports/')) return REPORT;
  if (path === '/clubs/') return page([CLUB]);
  if (path.endsWith('/finance/')) return { invoices: [], payments: [], summary: {} };
  if (path.endsWith('/effective/')) return { week: {}, source: 'organization' };
  if (path.endsWith('/impact/')) return { count: 0, bookings: [] };
  if (method === 'GET') return page([]);
  return {};
}

/**
 * Seed the session and intercept /api/v1. `routes` maps "METHOD /path" (the
 * path after /api/v1) to a body, or to { status, json }.
 */
export async function setupApp(page_, routes = {}) {
  await page_.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname.replace(/^\/api\/v1/, '');
    const key = `${method} ${path}`;
    if (key in routes) {
      const fixture = routes[key];
      // A fixture is the body itself unless it is an explicit { status, json }
      // wrapper, checked through the `json` key so a record's own `status`
      // field is never mistaken for an HTTP status.
      const wrapped = fixture && typeof fixture === 'object' && 'json' in fixture;
      return route.fulfill({
        status: wrapped ? (fixture.status || 200) : 200,
        json: (wrapped ? fixture.json : fixture) ?? {},
      });
    }
    return route.fulfill({ status: 200, json: defaultResponse(method, path) });
  });

  // Anything the app requests that is not the API (fonts, map tiles) is stubbed
  // so a slow or blocked third party cannot make a layout assertion flaky.
  await page_.route('**/maps.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '' }));
}

/** Widths the responsive standard in CLAUDE.md requires us to support. */
export const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'tablet-landscape-1024', width: 1024, height: 768 },
  { name: 'tablet-portrait-768', width: 768, height: 1024 },
  { name: 'mobile-landscape-640', width: 640, height: 480 },
  { name: 'mobile-480', width: 480, height: 800 },
  { name: 'mobile-portrait-375', width: 375, height: 812 },
];

/**
 * How far the document scrolls sideways. Anything above a rounding tolerance
 * means some element is wider than the viewport, which is what the standard
 * forbids.
 */
export async function horizontalOverflow(page_) {
  return page_.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  });
}

/** Elements that stick out past the viewport, named for a useful failure. */
export async function overflowingElements(page_) {
  return page_.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const out = [];
    document.querySelectorAll('body *').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      if (rect.right <= limit && rect.left >= -1) return;
      // A region that is allowed to scroll on its own is not a page overflow.
      let node = el.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll'
          || style.overflowX === 'hidden' || style.overflowX === 'clip') return;
        node = node.parentElement;
      }
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '',
        right: Math.round(rect.right),
        limit,
      });
    });
    return out.slice(0, 8);
  });
}
