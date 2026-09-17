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

    const bar = document.querySelector('.bk-cal__bar');
    fireEvent.click(within(bar).getByLabelText('Next'));
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

  it('colours an event by its status', async () => {
    // Opening is covered separately: a click now shows the quick look first.
    const row = booking({ scheduled_date: new Date().toISOString().slice(0, 10) });
    mockRows([row]);

    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    const event = await screen.findByRole('button', { name: /Layla Ahmed/ });
    expect(event.className).toContain('bk-st--confirmed');   // green = confirmed
  });

  it('marks a cancelled booking as no longer occupying its slot', async () => {
    const row = booking({
      status: 'cancelled',
      scheduled_date: new Date().toISOString().slice(0, 10),
    });
    mockRows([row]);

    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    const event = await screen.findByRole('button', { name: /Layla Ahmed/ });
    expect(event.className).toContain('bk-st--cancelled');
    expect(event.className).toContain('bk-cal__event--inactive');
  });

  it('lists only the statuses in view, with their counts, in the rail', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockRows([
      booking({ id: 1, status: 'confirmed', scheduled_date: today }),
      booking({ id: 2, status: 'booked', scheduled_date: today, scheduled_time: '12:00:00', end_time: '13:00:00' }),
    ]);
    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    const rail = await screen.findByRole('complementary');
    await waitFor(() => expect(within(rail).getByText('Pending')).toBeTruthy());
    expect(within(rail).getByText('Confirmed')).toBeTruthy();
    expect(within(rail).queryByText('Cancelled')).toBeNull();
  });

  it('hides a status from the grid when it is unticked in the rail', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockRows([booking({ id: 1, status: 'confirmed', scheduled_date: today })]);
    render(<BookingCalendar filters={{}} onOpen={() => {}} />);
    const rail = await screen.findByRole('complementary');
    await screen.findByRole('button', { name: /Layla Ahmed/ });

    fireEvent.click(within(rail).getByRole('checkbox'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Layla Ahmed/ })).toBeNull());
  });

  it('a clicked event offers a quick look before the full record', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const onOpen = vi.fn();
    mockRows([booking({ id: 1, status: 'confirmed', scheduled_date: today })]);
    render(<BookingCalendar filters={{}} onOpen={onOpen} />);

    fireEvent.click(await screen.findByRole('button', { name: /Layla Ahmed/ }));
    const peek = await screen.findByRole('dialog');
    expect(within(peek).getByText('BK-000001')).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(within(peek).getByRole('button', { name: /open booking/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
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
describe('BookingCards board', () => {
  const board = (rows, props = {}) => render(
    <BookingCards
      rows={rows}
      loading={false}
      onOpen={props.onOpen || (() => {})}
      onEdit={props.onEdit || (() => {})}
      onDuplicate={props.onDuplicate || (() => {})}
      onDelete={props.onDelete || (() => {})}
      canEdit={props.canEdit ?? true}
      canDuplicate={props.canDuplicate ?? true}
      canDelete={props.canDelete ?? true}
      {...props}
    />,
  );

  const column = (name) => screen.getByRole('region', { name })
    || document.querySelector(`[aria-label="${name}"]`);

  it('sorts each booking into the column for its stage', () => {
    board([
      booking({ id: 1, status: 'booked' }),
      booking({ id: 2, status: 'confirmed' }),
      booking({ id: 3, status: 'in_progress' }),
    ]);
    const columns = document.querySelectorAll('.bkb-col');
    expect(columns).toHaveLength(5);
    expect(within(columns[0]).getAllByRole('button', { name: /BK-000001/ })).toHaveLength(1);
  });

  it('counts the cards in each column', () => {
    board([booking({ id: 1, status: 'booked' }), booking({ id: 2, status: 'booked' })]);
    const pending = document.querySelectorAll('.bkb-col')[0];
    expect(within(pending).getByText('2')).toBeInTheDocument();
  });

  it('groups finished bookings under Closed with their own breakdown', () => {
    board([
      booking({ id: 1, status: 'completed' }),
      booking({ id: 2, status: 'cancelled' }),
    ]);
    const closed = document.querySelectorAll('.bkb-col')[4];
    expect(within(closed).getByText('Completed')).toBeInTheDocument();
    expect(within(closed).getByText('Cancelled')).toBeInTheDocument();
  });

  it('shows the facility, club and customer without opening the booking', () => {
    board([booking()]);
    expect(screen.getByText('Court 1')).toBeInTheDocument();
    expect(screen.getByText('Riverside Club')).toBeInTheDocument();
    expect(screen.getByText('Layla Ahmed')).toBeInTheDocument();
    expect(screen.getByText('BK-000001')).toBeInTheDocument();
  });

  it('marks a booking that is still unpaid', () => {
    board([booking({ payment_status: 'pending' })]);
    expect(screen.getByText('Pay pending')).toBeInTheDocument();
  });

  it('does not mark a paid booking', () => {
    board([booking({ payment_status: 'paid' })]);
    expect(screen.queryByText('Pay pending')).not.toBeInTheDocument();
  });

  it('flags the booking happening right now', () => {
    board([booking({ status: 'in_progress' })]);
    expect(screen.getByText('Live now')).toBeInTheDocument();
  });

  it('strikes through a cancelled booking so it never reads as live', () => {
    board([booking({ status: 'cancelled' })]);
    expect(document.querySelector('.bkb-card--void')).toBeTruthy();
  });

  it('opens the booking when a card is clicked', () => {
    const onOpen = vi.fn();
    board([booking()], { onOpen });
    fireEvent.click(screen.getByRole('button', { name: /BK-000001/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('only allows a move the booking engine actually permits', () => {
    const onStatusChange = vi.fn();
    // `booked` may only go to `confirmed`, so the Assigned column must refuse.
    board([booking({ status: 'booked' })], { onStatusChange });
    const card = screen.getByRole('button', { name: /BK-000001/ });
    const columns = document.querySelectorAll('.bkb-col');

    fireEvent.dragStart(card);
    fireEvent.drop(columns[1]);            // Assigned
    expect(onStatusChange).not.toHaveBeenCalled();

    fireEvent.dragStart(card);
    fireEvent.drop(columns[2]);            // Confirmed
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }), 'confirmed',
    );
  });

  it('never offers the terminal column as a drop target', () => {
    const onStatusChange = vi.fn();
    board([booking({ status: 'in_progress' })], { onStatusChange });
    fireEvent.dragStart(screen.getByRole('button', { name: /BK-000001/ }));
    fireEvent.drop(document.querySelectorAll('.bkb-col')[4]);   // Closed
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('does not allow dragging at all without the edit permission', () => {
    board([booking()], { canEdit: false, onStatusChange: undefined });
    const card = screen.getByRole('button', { name: /BK-000001/ });
    expect(card).not.toHaveAttribute('draggable', 'true');
  });

  it('says a column is empty rather than leaving a blank', () => {
    board([]);
    expect(screen.getAllByText('Nothing here.').length).toBe(5);
  });

  it('tells the reader how to move a booking', () => {
    board([booking()]);
    expect(screen.getByText(/drag a card to change its status/i)).toBeInTheDocument();
  });
});
