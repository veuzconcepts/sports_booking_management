import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./apiClient', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: {} })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

const api = (await import('./apiClient')).default;
const {
  BOOKING_STATUSES,
  bookingPoliciesApi,
  bookingWindowApi,
  BOOKING_SOURCES,
  NEXT_STATUSES,
  bookingDuplicateInitial,
  bookingEditInitial,
  bookingsApi,
} = await import('./bookingsService.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('status vocabulary', () => {
  it('has no quality-check stage', () => {
    expect(BOOKING_STATUSES.map((s) => s.value)).not.toContain('qc');
    expect(NEXT_STATUSES).not.toHaveProperty('qc');
  });

  it('uses domain-neutral labels', () => {
    const byValue = Object.fromEntries(BOOKING_STATUSES.map((s) => [s.value, s.label]));
    expect(byValue.arrived).toBe('Checked in');
    expect(byValue.in_progress).toBe('In progress');
  });

  it('offers only the sources the platform actually has', () => {
    expect(BOOKING_SOURCES.map((s) => s.value)).toEqual(
      ['admin', 'website', 'phone', 'walk_in', 'other'],
    );
  });

  it('walks the lifecycle forward only', () => {
    expect(NEXT_STATUSES.booked).toEqual(['confirmed']);
    expect(NEXT_STATUSES.in_progress).toEqual(['completed']);
    expect(NEXT_STATUSES.closed).toEqual([]);
  });
});

describe('availability', () => {
  it('queries by date, club and facility type', async () => {
    await bookingsApi.availability('2026-06-04', 7, 3);
    expect(api.get).toHaveBeenCalledWith('/bookings/availability/',
      { params: { date: '2026-06-04', club: 7, facility_type: 3 } });
  });

  it('omits the club and type when neither is chosen', async () => {
    await bookingsApi.availability('2026-06-04');
    expect(api.get).toHaveBeenCalledWith('/bookings/availability/',
      { params: { date: '2026-06-04' } });
  });

  it('asks the server which units could take a booking', async () => {
    await bookingsApi.freeFacilities(42);
    expect(api.get).toHaveBeenCalledWith('/bookings/42/free-facilities/');
  });
});

describe('booking rules', () => {
  it('reads the policy rows', async () => {
    await bookingPoliciesApi.list({ page_size: 100 });
    expect(api.get).toHaveBeenCalledWith('/bookings/policies/', { params: { page_size: 100 } });
  });

  it('creates a per-club override', async () => {
    await bookingPoliciesApi.create({ club: 4, max_advance_days: 7 });
    expect(api.post).toHaveBeenCalledWith('/bookings/policies/',
      { club: 4, max_advance_days: 7 });
  });

  it('asks for the bookable window of a club', async () => {
    await bookingWindowApi.get(4);
    expect(api.get).toHaveBeenCalledWith('/bookings/booking-window/', { params: { club: 4 } });
  });

  it('asks for the organization window when no club is given', async () => {
    await bookingWindowApi.get();
    expect(api.get).toHaveBeenCalledWith('/bookings/booking-window/', { params: undefined });
  });
});

describe('assign', () => {
  it('sends the facility id, not a free-text label', async () => {
    await bookingsApi.assign(3, 12, 5, false);
    expect(api.post).toHaveBeenCalledWith('/bookings/3/assign/',
      { assigned_to: 12, facility: 5, override: false });
  });
});

describe('bookingDuplicateInitial', () => {
  const booking = {
    id: 9,
    customer: 4,
    customer_label: 'Layla Ahmed',
    facility_type: 2,
    facility_category: null,
    club: 1,
    facility: 6,
    add_ons: [3],
    booking_type: 'advance',
    priority: 'normal',
    recurrence: 'weekly',
    assigned_to: 8,
    walk_in_name: '',
    customer_notes: 'Bring rackets',
    payment_status: 'paid',
    payment_method: 'card',
    scheduled_date: '2026-06-04',
    scheduled_time: '10:00',
  };

  it('carries the catalogue and location selection', () => {
    const out = bookingDuplicateInitial(booking);
    expect(out).toMatchObject({
      customer: 4, facility_type: 2, club: 1, facility: 6, add_ons: [3],
    });
  });

  it('drops the schedule and resets payment', () => {
    const out = bookingDuplicateInitial(booking);
    expect(out.scheduled_date).toBeUndefined();
    expect(out.payment_status).toBe('pending');
  });

  it('carries no legacy fields', () => {
    const out = bookingDuplicateInitial(booking);
    for (const key of ['vehicle', 'channel', 'address', 'site', 'bay',   // legacy-term-guard: allow
                       'walk_in_vehicle', 'walk_in_vehicle_category']) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('pins the chosen customer for the picker', () => {
    expect(bookingDuplicateInitial(booking).__customerPin)
      .toEqual({ value: 4, label: 'Layla Ahmed' });
  });

  it('bookingEditInitial keeps the schedule and real payment state', () => {
    const out = bookingEditInitial(booking);
    expect(out.scheduled_date).toBe('2026-06-04');
    expect(out.scheduled_time).toBe('10:00');
    expect(out.payment_status).toBe('paid');
    expect(out.payment_method).toBe('card');
  });
});
