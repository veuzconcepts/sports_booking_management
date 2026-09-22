import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { ReservationSettings } from './ReservationSettings.jsx';

/**
 * Reservation timeouts and payment methods, at two scopes.
 *
 * The bug this screen can cause is quiet rather than loud: an editor that
 * materialises the inherited values into a club's own boxes looks identical to
 * one that leaves them blank, and detaches the club from the organization the
 * first time anybody opens it. After that a change to the organization default
 * stops reaching that club and nobody can see why.
 *
 * So the assertions are about what is SENT, not about what is drawn.
 */

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => fallback || key }),
}));

const orgGet = vi.fn();
const orgUpdate = vi.fn((d) => Promise.resolve(d));
const clubList = vi.fn();
const clubUpdate = vi.fn((id, d) => Promise.resolve({ id, name: 'Riverside', ...d }));

vi.mock('../../services/settingsService.js', () => ({
  organizationApi: {
    get: (...a) => orgGet(...a),
    update: (...a) => orgUpdate(...a),
  },
}));

vi.mock('../../services/clubsService.js', () => ({
  clubsApi: {
    list: (...a) => clubList(...a),
    update: (...a) => clubUpdate(...a),
  },
}));

const ORG = {
  name: 'Nadena', logo_light: 'https://cdn.example/logo.png',
  hold_unpaid_minutes: 10, hold_partly_paid_minutes: 30, hold_max_minutes: 120,
  split_enabled: true, split_hold_minutes: 30, split_max_shares: 20,
  cash_enabled: true,
};

// A club that follows the organization in every respect.
const PLAIN_CLUB = {
  id: 1, name: 'Riverside',
  hold_unpaid_minutes: null, hold_partly_paid_minutes: null, hold_max_minutes: null,
  split_enabled: null, split_hold_minutes: null, split_max_shares: null,
  cash_enabled: null,
  effective_booking_policy: {
    hold_unpaid_minutes: 10, hold_partly_paid_minutes: 30, hold_max_minutes: 120,
    split_enabled: true, split_hold_minutes: 30, split_max_shares: 20,
    cash_enabled: true,
  },
};

// A club that has already said something of its own.
const OVERRIDING_CLUB = {
  ...PLAIN_CLUB, id: 2, name: 'Marina', cash_enabled: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  orgGet.mockResolvedValue({ ...ORG });
  clubList.mockResolvedValue({ results: [PLAIN_CLUB] });
});

describe('reservation and payment settings', () => {
  it('shows the organization defaults', async () => {
    render(<ReservationSettings canManage />);
    await waitFor(() => expect(screen.getByDisplayValue('10')).toBeTruthy());
    expect(screen.getByDisplayValue('120')).toBeTruthy();
  });

  it('lists only the clubs that actually override something', async () => {
    clubList.mockResolvedValue({ results: [PLAIN_CLUB, OVERRIDING_CLUB] });
    render(<ReservationSettings canManage />);
    await waitFor(() => expect(screen.getByText('Marina')).toBeTruthy());
    expect(screen.queryByText('Riverside')).toBeNull();
  });

  it('sends only its own fields, never the whole organization profile', async () => {
    // A PUT carrying `logo_light` as a URL string would be read as a new upload.
    render(<ReservationSettings canManage />);
    await waitFor(() => expect(screen.getByDisplayValue('10')).toBeTruthy());
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(orgUpdate).toHaveBeenCalled());
    const sent = orgUpdate.mock.calls[0][0];
    expect(sent.logo_light).toBeUndefined();
    expect(sent.name).toBeUndefined();
    expect(sent.hold_unpaid_minutes).toBe(10);
  });

  it('keeps a boolean the user switched off rather than dropping it', async () => {
    render(<ReservationSettings canManage />);
    await waitFor(() => expect(screen.getByDisplayValue('10')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Accept Payment At The Venue/i));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(orgUpdate).toHaveBeenCalled());
    expect(orgUpdate.mock.calls[0][0].cash_enabled).toBe(false);
  });

  it('sends null, not zero, for a club field left blank', async () => {
    // Null means inherit. Zero would mean the court is released the instant it
    // is held, which is the same screen producing the opposite outcome.
    clubList.mockResolvedValue({ results: [OVERRIDING_CLUB] });
    render(<ReservationSettings canManage />);
    await waitFor(() => expect(screen.getByText('Marina')).toBeTruthy());
    fireEvent.click(screen.getAllByText('Save')[1]);
    await waitFor(() => expect(clubUpdate).toHaveBeenCalled());
    const [, sent] = clubUpdate.mock.calls[0];
    expect(sent.hold_unpaid_minutes).toBeNull();
    expect(sent.cash_enabled).toBe(false);
  });

  it('shows what a blank club field will inherit', async () => {
    clubList.mockResolvedValue({ results: [OVERRIDING_CLUB] });
    render(<ReservationSettings canManage />);
    await waitFor(() => expect(screen.getByText('Marina')).toBeTruthy());
    expect(screen.getAllByPlaceholderText('Inherits 10').length).toBeGreaterThan(0);
  });

  it('offers nothing to change without the permission', async () => {
    render(<ReservationSettings canManage={false} />);
    await waitFor(() => expect(screen.getByDisplayValue('10')).toBeTruthy());
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('says so when the settings cannot be loaded', async () => {
    orgGet.mockRejectedValue(new Error('offline'));
    clubList.mockRejectedValue(new Error('offline'));
    render(<ReservationSettings canManage />);
    await waitFor(() => expect(screen.queryByDisplayValue('10')).toBeNull());
  });
});
