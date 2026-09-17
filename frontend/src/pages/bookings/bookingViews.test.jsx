import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Mock the HTTP client, not the service - the real service maps params to the
// request, and that mapping is part of what these tests are checking.
vi.mock('../../services/apiClient', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: { results: [], count: 0 } })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

const api = (await import('../../services/apiClient')).default;
const { BookingCalendar } = await import('./BookingCalendar.jsx');
const { BookingCards } = await import('./BookingCards.jsx');

/** Every GET the calendar made against the bookings list endpoint. */
const bookingCalls = () => api.get.mock.calls.filter((c) => c[0] === '/bookings/');
function mockRows(results) {
  api.get.mockImplementation((url) => {
    if (url === '/bookings/') {
      return Promise.resolve({ data: { results, count: results.length } });
    }
    return Promise.resolve({ data: {} });
  });
}

const booking = (over = {}) => ({
  id: 1,
  reference: 'BK-000001',
  status: 'confirmed',
  facility_type_name: 'Tennis Court',
  facility_name: 'Court 1',
  club_name: 'Riverside Club',
  customer_label: 'Layla Ahmed',
  scheduled_date: '2026-09-18',
  scheduled_time: '10:00:00',
  end_time: '11:00:00',
  duration_minutes: 60,
  assigned_to_name: 'Sam Okafor',
  total_amount: '120.00',
  currency: 'AED',
  booking_type: 'standard',
  can_modify: true,
  can_delete: true,
  ...over,
});

/** The params of the most recent bookings request. */
const params = () => {
  const calls = bookingCalls();
  return calls[calls.length - 1][1].params;
};

beforeEach(() => {
  api.get.mockReset();
  mockRows([]);
});

// --------------------------------------------------------------------------- //
describe('BookingCalendar', () => {
  it('asks for the whole visible range in one unpaginated request', async () => {
    // A calendar that only showed the first page would silently hide bookings.
    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    await waitFor(() => expect(bookingCalls().length).toBeGreaterThan(0));
    const p = params();
    expect(p.date_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.date_to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.page_size).toBeGreaterThanOrEqual(500);
    expect(p.date_from <= p.date_to).toBe(true);
  });

  it('defaults to a seven-day week', async () => {
    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    await waitFor(() => expect(bookingCalls().length).toBeGreaterThan(0));
    const { date_from: a, date_to: b } = params();
    const span = (new Date(b) - new Date(a)) / 86400000;
    expect(span).toBe(6);
  });

  it('carries the toolbar filters through, but not list-only params', async () => {
    render(<BookingCalendar filters={{ status: 'confirmed', source: 'website', search: 'BK-1', page: 3, ordering: '-created_at' }}
      onOpen={() => {}} />);
    await waitFor(() => expect(bookingCalls().length).toBeGreaterThan(0));
    const p = params();
    expect(p.status).toBe('confirmed');
    expect(p.source).toBe('website');
    expect(p.search).toBe('BK-1');
    expect(p.page).toBeUndefined();          // paging would fight the range query
    expect(p.ordering).toBe('scheduled_time');
  });

  it('re-fetches a different range when you step forward', async () => {
    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    await waitFor(() => expect(bookingCalls().length).toBeGreaterThan(0));
    const first = params().date_from;

    fireEvent.click(screen.getByLabelText('Next'));
    await waitFor(() => expect(params().date_from).not.toBe(first));
    expect(new Date(params().date_from) > new Date(first)).toBe(true);
  });

  it('switching to Day narrows the range to a single day', async () => {
    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    await waitFor(() => expect(bookingCalls().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    await waitFor(() => expect(params().date_from).toBe(params().date_to));
  });

  it('switching to Month widens the range past a week', async () => {
    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    await waitFor(() => expect(bookingCalls().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    await waitFor(() => {
      const span = (new Date(params().date_to) - new Date(params().date_from)) / 86400000;
      expect(span).toBeGreaterThanOrEqual(27);
    });
  });

  it('reloads when reloadKey changes, so an edit elsewhere shows up', async () => {
    const { rerender } = render(<BookingCalendar filters={{}} reloadKey={0} onOpen={() => {}} />);
    await waitFor(() => expect(bookingCalls().length).toBe(1));
    rerender(<BookingCalendar filters={{}} reloadKey={1} onOpen={() => {}} />);
    await waitFor(() => expect(bookingCalls().length).toBe(2));
  });

  it('colours an event by its status and opens it when clicked', async () => {
    const onOpen = vi.fn();
    const row = booking({ scheduled_date: new Date().toISOString().slice(0, 10) });
    mockRows([row]);

    render(<BookingCalendar filters={{}} onOpen={onOpen} />);
    const event = await screen.findByRole('button', { name: /Tennis Court/ });
    expect(event.className).toContain('bk-st--confirmed');   // green = confirmed

    fireEvent.click(event);
    expect(onOpen).toHaveBeenCalledWith(row);
  });

  it('marks a cancelled booking as no longer occupying its slot', async () => {
    const row = booking({
      status: 'cancelled',
      scheduled_date: new Date().toISOString().slice(0, 10),
    });
    mockRows([row]);

    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    const event = await screen.findByRole('button', { name: /Tennis Court/ });
    expect(event.className).toContain('bk-st--cancelled');
    expect(event.className).toContain('bk-cal__event--inactive');
  });

  it('shows a legend of only the statuses in view', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockRows([
      booking({ id: 1, status: 'confirmed', scheduled_date: today }),
      booking({ id: 2, status: 'booked', scheduled_date: today, scheduled_time: '12:00:00', end_time: '13:00:00' }),
    ]);
    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText('Pending')).toBeTruthy());
    expect(screen.getByText('Confirmed')).toBeTruthy();
    expect(screen.queryByText('Cancelled')).toBeNull();
  });

  it('says so plainly when the range is empty', async () => {
    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    expect(await screen.findByText(/No bookings in this range/)).toBeTruthy();
  });

  it('survives a failed load instead of blanking the page', async () => {
    api.get.mockRejectedValue(new Error('boom'));
    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    expect(await screen.findByText(/Could not load the calendar/)).toBeTruthy();
  });
});

// --------------------------------------------------------------------------- //
describe('BookingCards', () => {
  const base = {
    rows: [booking()],
    loading: false,
    count: 1,
    page: 1,
    pageSize: 20,
    onPageChange: () => {},
    onOpen: () => {},
    onEdit: () => {},
    onDuplicate: () => {},
    onDelete: () => {},
    canEdit: true,
    canDuplicate: true,
    canDelete: true,
  };

  it('shows what you need to avoid opening the booking', () => {
    render(<BookingCards {...base} />);
    expect(screen.getByText('BK-000001')).toBeTruthy();
    expect(screen.getByText('Tennis Court')).toBeTruthy();
    expect(screen.getByText('Layla Ahmed')).toBeTruthy();
    expect(screen.getByText(/Riverside Club/)).toBeTruthy();
    expect(screen.getByText('Sam Okafor')).toBeTruthy();
  });

  it('carries the status colour and label', () => {
    render(<BookingCards {...base} />);
    const card = screen.getByRole('button', { name: /Booking BK-000001/ });
    expect(card.className).toContain('bk-st--confirmed');
    expect(within(card).getByText('Confirmed')).toBeTruthy();
  });

  it('labels a pending booking as Pending, matching the list view', () => {
    render(<BookingCards {...base} rows={[booking({ status: 'booked' })]} />);
    const card = screen.getByRole('button', { name: /Booking BK-000001/ });
    expect(card.className).toContain('bk-st--booked');
    expect(within(card).getByText('Pending')).toBeTruthy();
  });

  it('opens the booking on click and on Enter', async () => {
    const onOpen = vi.fn();
    render(<BookingCards {...base} onOpen={onOpen} />);
    const card = screen.getByRole('button', { name: /Booking BK-000001/ });

    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('row actions do not also open the booking', async () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    render(<BookingCards {...base} onOpen={onOpen} onDelete={onDelete} />);

    fireEvent.click(screen.getByTitle('Delete booking'));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('hides actions the user has no permission for', () => {
    render(<BookingCards {...base} canDelete={false} canEdit={false} />);
    expect(screen.queryByTitle('Delete booking')).toBeNull();
    expect(screen.queryByTitle('Edit booking')).toBeNull();
    expect(screen.getByTitle('Duplicate booking')).toBeTruthy();
  });

  it('hides edit and delete on a booking that is locked server-side', () => {
    render(<BookingCards {...base} rows={[booking({ can_modify: false, can_delete: false })]} />);
    expect(screen.queryByTitle('Edit booking')).toBeNull();
    expect(screen.queryByTitle('Delete booking')).toBeNull();
  });

  it('marks an unassigned booking rather than leaving a blank', () => {
    render(<BookingCards {...base} rows={[booking({ assigned_to_name: null })]} />);
    expect(screen.getByText('Unassigned')).toBeTruthy();
  });

  it('shows the empty state when there is nothing to show', () => {
    render(<BookingCards {...base} rows={[]} count={0} />);
    expect(screen.getByText('No bookings yet')).toBeTruthy();
  });
});
