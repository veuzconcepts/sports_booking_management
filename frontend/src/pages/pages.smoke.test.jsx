import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Every listing page, actually rendered.
 *
 * A build passes whether or not a component references a variable that does not
 * exist: `canInvoice is not defined` only appears when React runs the function.
 * These tests run it. They assert almost nothing about what is on screen, on
 * purpose: their job is to catch a page that throws, which is exactly what a
 * refactor across many pages puts at risk.
 */
vi.mock('../services/apiClient', () => {
  const ok = (data) => Promise.resolve({ data });
  const client = {
    get: vi.fn(() => ok({ results: [], count: 0 })),
    post: vi.fn(() => ok({})),
    patch: vi.fn(() => ok({})),
    put: vi.fn(() => ok({})),
    delete: vi.fn(() => ok({})),
  };
  return { default: client, STORAGE_KEYS: { user: 'cw_user' } };
});

// A signed-in user who may do everything: the pages then exercise every
// permission-gated branch rather than rendering a stripped-down version.
vi.mock('../hooks/useAuth.jsx', () => ({
  useAuth: () => ({
    user: { id: 1, email: 'admin@example.com', role: 'super_admin', language: '' },
    role: 'super_admin',
    hasPerm: () => true,
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }) => children,
}));

const RENDER_TIMEOUT_MS = 20000;

const PAGES = [
  ['Bookings', () => import('./bookings/BookingsListPage.jsx')],
  ['Customers', () => import('./customers/CustomersListPage.jsx')],
  ['Staff', () => import('./staff/StaffListPage.jsx')],
  ['Payments', () => import('./payments/PaymentsPage.jsx')],
  ['Invoices', () => import('./payments/InvoicesListPage.jsx')],
  ['Credit notes', () => import('./payments/RefundsListPage.jsx')],
  ['Promo codes', () => import('./promotions/PromoCodesPage.jsx')],
  ['Audit logs', () => import('./auditlogs/AuditLogsPage.jsx')],
  ['Notifications', () => import('./notifications/NotificationsPage.jsx')],
  ['Facilities', () => import('./facilities/FacilitiesPage.jsx')],
  ['Languages', () => import('./settings/LanguagesPage.jsx')],
  ['Users', () => import('./users/UsersPage.jsx')],
];

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});

describe.each(PAGES)('%s page', (name, load) => {
  it('renders without throwing', async () => {
    const Page = (await load()).default;
    const errors = [];
    // React logs a render error before rethrowing; capture it either way.
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(String(args[0]));
    });

    let thrown = null;
    try {
      render(<MemoryRouter><Page /></MemoryRouter>);
      await waitFor(() => {});
    } catch (e) {
      thrown = e;
    } finally {
      spy.mockRestore();
    }

    expect(thrown, `${name} threw: ${thrown?.message}`).toBeNull();

    const fatal = errors.filter((e) => /is not defined|is not a function|Cannot read/.test(e));
    expect(fatal, `${name} logged: ${fatal[0]}`).toEqual([]);
    // These render entire pages, several of which mount a table, a card grid
    // and a calendar. The default 5s is not enough under a parallel run.
  }, RENDER_TIMEOUT_MS);

  it('asks the API for its rows', async () => {
    const Page = (await load()).default;
    const api = (await import('../services/apiClient')).default;
    api.get.mockClear();

    render(<MemoryRouter><Page /></MemoryRouter>);
    // Every listing page fetches something on mount; a page that never calls
    // the API is a page whose data wiring broke.
    await waitFor(() => expect(api.get).toHaveBeenCalled());
  }, RENDER_TIMEOUT_MS);
});


/**
 * The CMS collections need a route, not just a render.
 *
 * `CmsResourcePage` reads `:resource` from the URL and shows an "unknown
 * section" notice when it is missing, so mounting it bare would pass while
 * proving nothing about the listing it actually draws. Each collection has
 * its own columns, so each one is rendered.
 */
const CMS_RESOURCES = ['sections', 'banners', 'stats', 'testimonials',
                       'brands', 'faqs', 'seo'];

describe.each(CMS_RESOURCES)('Website CMS: %s', (resource) => {
  it('renders its listing without throwing', async () => {
    const Page = (await import('./website/CmsResourcePage.jsx')).default;
    const errors = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(String(args[0]));
    });

    let thrown = null;
    try {
      render(
        <MemoryRouter initialEntries={[`/website/${resource}`]}>
          <Routes>
            <Route path="/website/:resource" element={<Page />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {});
    } catch (e) {
      thrown = e;
    } finally {
      spy.mockRestore();
    }

    expect(thrown, `${resource} threw: ${thrown?.message}`).toBeNull();
    const fatal = errors.filter((e) => /is not defined|is not a function|Cannot read/.test(e));
    expect(fatal, `${resource} logged: ${fatal[0]}`).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('asks the API for its rows', async () => {
    const Page = (await import('./website/CmsResourcePage.jsx')).default;
    const api = (await import('../services/apiClient')).default;
    api.get.mockClear();
    render(
      <MemoryRouter initialEntries={[`/website/${resource}`]}>
        <Routes>
          <Route path="/website/:resource" element={<Page />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.get).toHaveBeenCalled());
  }, RENDER_TIMEOUT_MS);
});
