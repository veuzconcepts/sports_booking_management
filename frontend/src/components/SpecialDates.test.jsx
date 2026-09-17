import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../services/timeformat.jsx', () => ({
  useTimeFormat: () => ({ format24: true }),
  formatDate: (value) => value,
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const listed = vi.fn();
const created = vi.fn();
const updated = vi.fn();
const removed = vi.fn();
const impact = vi.fn();
const removalImpact = vi.fn();

vi.mock('../services/scheduleService.js', () => ({
  scheduleExceptionsApi: {
    list: (...args) => listed(...args),
    create: (...args) => created(...args),
    update: (...args) => updated(...args),
    remove: (...args) => removed(...args),
    impact: (...args) => impact(...args),
    removalImpact: (...args) => removalImpact(...args),
  },
}));

vi.mock('../services/clubsService.js', () => ({
  clubsApi: { list: () => Promise.resolve({ results: [{ id: 1, name: 'Riverside' }] }) },
}));

vi.mock('../services/facilitiesService.js', () => ({
  facilitiesApi: { list: () => Promise.resolve({ results: [{ id: 7, name: 'Court 1' }] }) },
}));

import { SpecialDates } from './SpecialDates.jsx';

/** Far enough ahead that "upcoming" stays true whenever the suite is run. */
const FUTURE = '2099-01-01';
const PAST = '2000-01-01';

const holiday = (over = {}) => ({
  id: 1, name: 'National Day', club: 1, facility: null, facility_club: null,
  scope_label: 'Riverside', start_date: FUTURE, end_date: null,
  closed: true, shifts: [], breaks: [], slot_minutes: null,
  is_active: true, notes: '', ...over,
});

function renderList(rows = [holiday()], props = {}) {
  listed.mockResolvedValue({ results: rows, count: rows.length });
  return render(<SpecialDates canManage {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  impact.mockResolvedValue({ count: 0, bookings: [] });
  removalImpact.mockResolvedValue({ count: 0, bookings: [] });
  created.mockResolvedValue({});
  updated.mockResolvedValue({});
  removed.mockResolvedValue({});
});

async function openForm() {
  fireEvent.click(await screen.findByRole('button', { name: /add special date/i }));
  return screen.findByRole('dialog');
}

function fillRequired(dialog) {
  fireEvent.change(within(dialog).getByRole('textbox', { name: /^name/i }),
    { target: { value: 'National Day' } });
}

describe('existing bookings are protected', () => {
  it('checks the impact of a proposed date before saving it', async () => {
    renderList([]);
    const dialog = await openForm();
    fillRequired(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(impact).toHaveBeenCalled());
    expect(impact.mock.calls[0][0]).toMatchObject({ name: 'National Day', closed: true });
  });

  it('saves straight away when nothing would be stranded', async () => {
    renderList([]);
    const dialog = await openForm();
    fillRequired(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(created).toHaveBeenCalled());
  });

  it('refuses to save silently when live bookings would be stranded', async () => {
    impact.mockResolvedValue({
      count: 2,
      bookings: [
        { id: 1, reference: 'BK-1', date: FUTURE, time: '09:00', facility: 'Court 1', reason: 'closed' },
        { id: 2, reference: 'BK-2', date: FUTURE, time: '10:00', facility: 'Court 1', reason: 'closed' },
      ],
    });
    renderList([]);
    const dialog = await openForm();
    fillRequired(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/affects existing bookings/i)).toBeInTheDocument();
    expect(created).not.toHaveBeenCalled();
  });

  it('names the bookings so they can be found and moved', async () => {
    impact.mockResolvedValue({
      count: 1,
      bookings: [{ id: 1, reference: 'BK-1', date: FUTURE, time: '09:00', facility: 'Court 1', reason: 'closed' }],
    });
    renderList([]);
    const dialog = await openForm();
    fillRequired(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/BK-1/)).toBeInTheDocument();
    expect(screen.getByText(/review and\s+move these bookings yourself/i)).toBeInTheDocument();
  });

  it('saves once the warning is deliberately accepted', async () => {
    impact.mockResolvedValue({
      count: 1,
      bookings: [{ id: 1, reference: 'BK-1', date: FUTURE, time: '09:00', facility: '', reason: 'closed' }],
    });
    renderList([]);
    const dialog = await openForm();
    fillRequired(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    fireEvent.click(await screen.findByRole('button', { name: /save anyway/i }));
    await waitFor(() => expect(created).toHaveBeenCalled());
  });

  it('warns before removing a date that other bookings now depend on', async () => {
    removalImpact.mockResolvedValue({
      count: 1,
      bookings: [{ id: 3, reference: 'BK-9', date: FUTURE, time: '20:00', facility: '', reason: 'outside hours' }],
    });
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: /remove/i }));

    await waitFor(() => expect(removalImpact).toHaveBeenCalledWith(1));
    expect(await screen.findByText(/BK-9/)).toBeInTheDocument();
  });
});

describe('scope', () => {
  it('offers a facility so one court can close without shutting the club', async () => {
    renderList([]);
    const dialog = await openForm();
    expect(within(dialog).getByText(/^facility$/i)).toBeInTheDocument();
  });

  it('sends the facility alone, never together with its club', async () => {
    renderList([]);
    const dialog = await openForm();
    fillRequired(dialog);

    // Choosing a club then a facility: the backend refuses both being set.
    fireEvent.click(within(dialog).getByText('Whole organization'));
    fireEvent.click(await screen.findByText('Riverside'));
    fireEvent.click(await within(dialog).findByText('Whole club'));
    fireEvent.click(await screen.findByText('Court 1'));

    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(impact).toHaveBeenCalled());
    expect(impact.mock.calls[0][0]).toMatchObject({ club: null, facility: 7 });
  });
});

describe('the list stays usable as holidays accumulate', () => {
  it('shows upcoming dates first and hides past ones', async () => {
    renderList([holiday(), holiday({ id: 2, name: 'Old Closure', start_date: PAST })]);

    expect(await screen.findByText('National Day')).toBeInTheDocument();
    expect(screen.queryByText('Old Closure')).not.toBeInTheDocument();
  });

  it('can show past dates on request', async () => {
    renderList([holiday(), holiday({ id: 2, name: 'Old Closure', start_date: PAST })]);
    fireEvent.click(await screen.findByRole('button', { name: /^past$/i }));

    expect(await screen.findByText('Old Closure')).toBeInTheDocument();
    expect(screen.queryByText('National Day')).not.toBeInTheDocument();
  });

  it('searches by name', async () => {
    renderList([holiday(), holiday({ id: 2, name: 'Ramadan Hours' })]);
    fireEvent.change(await screen.findByLabelText(/search special dates/i),
      { target: { value: 'ramadan' } });

    expect(screen.getByText('Ramadan Hours')).toBeInTheDocument();
    expect(screen.queryByText('National Day')).not.toBeInTheDocument();
  });

  it('turns a date off without deleting its record', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: /turn off/i }));

    await waitFor(() => expect(updated).toHaveBeenCalledWith(1, { is_active: false }));
    expect(removed).not.toHaveBeenCalled();
  });

  it('marks a disabled date rather than hiding it', async () => {
    renderList([holiday({ is_active: false })]);
    expect(await screen.findByText('Off')).toBeInTheDocument();
  });
});

describe('custom hours', () => {
  it('offers breaks and a slot interval, matching the weekly editor', async () => {
    renderList([]);
    const dialog = await openForm();
    fireEvent.click(within(dialog).getByLabelText(/closed all day/i));

    expect(within(dialog).getByText(/^breaks$/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/slot interval on these dates/i)).toBeInTheDocument();
  });

  it('never sends hours for a date that is closed all day', async () => {
    renderList([]);
    const dialog = await openForm();
    fillRequired(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(impact).toHaveBeenCalled());
    expect(impact.mock.calls[0][0]).toMatchObject({ shifts: [], breaks: [], slot_minutes: null });
  });
});
