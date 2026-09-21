import { describe, it, expect } from 'vitest';

import { slotState } from './BookingFormModal.jsx';

/**
 * What staff are told about a slot they cannot book.
 *
 * "Full" and "somebody is mid-checkout" are different operational facts. One
 * is gone for the day; the other is probably free again in minutes. A
 * receptionist with a customer at the desk acts differently on each, and the
 * payload has carried both since holds were added.
 */
describe('admin slot capacity label', () => {
  it('says how many are free', () => {
    expect(slotState({ available: 2, held: 0 })).toBe('2 free');
  });

  it('distinguishes a reservation from a real booking', () => {
    expect(slotState({ available: 0, held: 1 })).toBe('being booked');
    expect(slotState({ available: 0, held: 0 })).toBe('full');
  });

  it('prefers the free count when a court is still bookable', () => {
    // One court held, another free: staff can still take this booking.
    expect(slotState({ available: 1, held: 1 })).toBe('1 free');
  });

  it('reads as it always did without a held count', () => {
    expect(slotState({ available: 0 })).toBe('full');
    expect(slotState({ available: 3 })).toBe('3 free');
  });
});
