import { useTranslation } from 'react-i18next';

/**
 * Translated display labels for the status codes the backend stores.
 *
 * The CODE is the contract: `confirmed` is what the API sends, what a filter
 * submits and what the database holds. Only the label a person reads is
 * translated, and a translated label is never stored or sent back.
 *
 * A code with no entry here falls back to its own text with underscores
 * removed, so a status added to the backend shows something sensible rather
 * than breaking the screen before anyone gets round to translating it.
 */
const KEYS = {
  // Booking lifecycle
  booked: 'bookings:status.booked',
  confirmed: 'bookings:status.confirmed',
  assigned: 'bookings:status.assigned',
  arrived: 'bookings:status.arrived',
  in_progress: 'bookings:status.in_progress',
  completed: 'bookings:status.completed',
  closed: 'bookings:status.closed',
  cancelled: 'bookings:status.cancelled',
  no_show: 'bookings:status.no_show',

  // Money
  pending: 'bookings:paymentStatus.pending',
  paid: 'bookings:paymentStatus.paid',
  partially_paid: 'bookings:paymentStatus.partially_paid',
  refunded: 'bookings:paymentStatus.refunded',
  covered: 'bookings:paymentStatus.covered',
  no_payment_required: 'bookings:paymentStatus.no_payment_required',

  // Generic record states
  active: 'common:state.active',
  inactive: 'common:state.inactive',
  enabled: 'common:state.enabled',
  disabled: 'common:state.disabled',
  draft: 'common:state.draft',
  failed: 'common:state.failed',
  expired: 'common:state.expired',

  // Reservation (BookingHold) outcomes. `active`, `expired` and `cancelled`
  // above already say the right thing for a hold; these two are its own.
  converted: 'bookings:reservations.status.converted',
  released: 'bookings:reservations.status.released',
};

/** Humanise an unknown code rather than showing it raw. */
function fallback(status) {
  return String(status || '').replace(/_/g, ' ');
}

/**
 * `label(status, explicit)` - an explicit label always wins, because some
 * callers pass text that is already domain-specific or already translated.
 */
export function useStatusLabel() {
  const { t } = useTranslation(['bookings', 'common']);
  return (status, explicit) => {
    if (explicit !== undefined && explicit !== null && explicit !== '') return explicit;
    const key = KEYS[status];
    return key ? t(key) : fallback(status);
  };
}

export { KEYS as STATUS_LABEL_KEYS };
