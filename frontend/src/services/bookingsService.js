import api from './apiClient';

export const bookingsApi = {
  list:    (params) => api.get('/bookings/', { params }).then((r) => r.data),
  get:     (id)     => api.get(`/bookings/${id}/`).then((r) => r.data),
  create:  (data)   => api.post('/bookings/', data).then((r) => r.data),
  // Duplicate = create a new booking from a cloned payload (own permission gate).
  duplicate: (data) => api.post('/bookings/duplicate/', data).then((r) => r.data),
  update:  (id, d)  => api.patch(`/bookings/${id}/`, d).then((r) => r.data),
  // Delete requires a mandatory reason (audited). `body` = { reason, reason_note }.
  remove:  (id, body) => api.delete(`/bookings/${id}/`, { data: body }),
  deletionReasons: () => api.get('/bookings/deletion-reasons/').then((r) => r.data),
  // Loyalty points redemption against a booking (pre-payment).
  redeemPoints:   (id, points) => api.post(`/bookings/${id}/redeem-points/`, { points }).then((r) => r.data),
  unredeemPoints: (id)         => api.post(`/bookings/${id}/unredeem-points/`).then((r) => r.data),

  // Slot availability. `facilityType` matters: capacity is the units that can
  // host that type, and each slot is tested against the type's full duration.
  availability: (date, club, facilityType) =>
    api.get('/bookings/availability/', {
      params: {
        date,
        ...(club ? { club } : {}),
        ...(facilityType ? { facility_type: facilityType } : {}),
      },
    }).then((r) => r.data),
  // Units that could still take this booking's slot (drives the staff override).
  freeFacilities: (id) =>
    api.get(`/bookings/${id}/free-facilities/`).then((r) => r.data),
  pricePreview: (payload) =>
    api.post('/bookings/price-preview/', payload).then((r) => r.data),
  // Validate a promo against a draft booking (no save) -> { valid, message, discount, ... }.
  validatePromo: (payload) =>
    api.post('/bookings/validate-promo/', payload).then((r) => r.data),
  // Consolidated financial history: { invoices[], payments[] (with nested refunds[]) }.
  finance: (id) => api.get(`/bookings/${id}/finance/`).then((r) => r.data),

  transition: (id, status, note) =>
    api.post(`/bookings/${id}/transition/`, { status, note }).then((r) => r.data),
  cancel: (id, note) =>
    api.post(`/bookings/${id}/cancel/`, { note }).then((r) => r.data),
  noShow: (id, note) =>
    api.post(`/bookings/${id}/no-show/`, { note }).then((r) => r.data),
  reopen: (id, note) =>
    api.post(`/bookings/${id}/reopen/`, { note }).then((r) => r.data),
  applyPromo: (id, code) =>
    api.post(`/bookings/${id}/apply-promo/`, { code }).then((r) => r.data),
  removePromo: (id) =>
    api.post(`/bookings/${id}/remove-promo/`).then((r) => r.data),
  assign: (id, assignedTo, facility, override = false) =>
    api.post(`/bookings/${id}/assign/`, { assigned_to: assignedTo, facility, override })
      .then((r) => r.data),
  skipAssignment: (id) =>
    api.post(`/bookings/${id}/skip-assignment/`).then((r) => r.data),
  // Turn a saved draft into a real booking. A draft holds no court, so this
  // is the first moment availability matters and it can legitimately fail
  // with 409 if the slot went while the draft was sitting there.
  finishDraft: (id) =>
    api.post(`/bookings/${id}/finish-draft/`).then((r) => r.data),
  // Apply / remove subscription coverage on an existing booking (no full edit).
  redeemSubscription: (id) =>
    api.post(`/bookings/${id}/redeem-subscription/`).then((r) => r.data),
  unapplySubscription: (id, reason) =>
    api.post(`/bookings/${id}/unapply-subscription/`, { note: reason }).then((r) => r.data),
  // Completion & payment wizard: record payment (when owed) then complete.
  complete: (id, payload) =>
    api.post(`/bookings/${id}/complete/`, payload).then((r) => r.data),
  // Manual "Generate Invoice & take payment" before completion: captures the
  // outstanding amount and raises its paid invoice + receipt (no status change).
  bill: (id, payload) =>
    api.post(`/bookings/${id}/bill/`, payload).then((r) => r.data),
  generateRecurrences: (id, occurrences) =>
    api.post(`/bookings/${id}/generate-recurrences/`, { occurrences }).then((r) => r.data),
};

/** Booking rules: when a slot may be booked, how many slots one booking may
 *  hold, and when a customer may cancel. One organization default row, plus an
 *  optional row per club and per facility. */
export const bookingPoliciesApi = {
  list:   (params) => api.get('/bookings/policies/', { params }).then((r) => r.data),
  create: (data)   => api.post('/bookings/policies/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/bookings/policies/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/bookings/policies/${id}/`),

  /** What applies at a scope once inheritance is resolved, whether or not a
   *  row exists there. The editor uses it to show what "inherit" would give. */
  effective: (params) => api.get('/bookings/policies/effective/', { params })
    .then((r) => r.data),

  /** Clear the slot-rule overrides under a scope so everything below it
   *  follows that scope again. Omit the club to reach every club. */
  clearOverrides: (club) => api.post('/bookings/policies/clear-overrides/',
    club ? { club } : {}).then((r) => r.data),
};

/** The dates/times the policy allows, so a picker can bound itself. */
export const bookingWindowApi = {
  get: (club) => api.get('/bookings/booking-window/', {
    params: club ? { club } : undefined,
  }).then((r) => r.data),
};

// Prefill payload for a DUPLICATE: copy the booking's inputs only. Date/time,
// status history, invoices and payments are deliberately NOT carried.
export function bookingDuplicateInitial(b) {
  return {
    customer: b.customer ?? undefined,
    facility_type: b.facility_type ?? undefined,
    facility_category: b.facility_category ?? undefined,
    add_ons: b.add_ons || [],
    booking_type: b.booking_type,
    priority: b.priority,
    recurrence: b.recurrence || 'none',
    club: b.club ?? undefined,
    facility: b.facility ?? undefined,
    assigned_to: b.assigned_to ?? undefined,
    walk_in_name: b.walk_in_name || '',
    walk_in_phone: b.walk_in_phone || '',
    walk_in_email: b.walk_in_email || '',
    customer_notes: b.customer_notes || '',
    special_instructions: b.special_instructions || '',
    internal_notes: b.internal_notes || '',
    payment_status: 'pending',
    __customerPin: b.customer
      ? { value: b.customer, label: b.customer_label || b.customer_name || `#${b.customer}` }
      : null,
  };
}

// Prefill payload for an EDIT: like duplicate but keeps the existing schedule
// and real payment status. Pair with the form's `editId` so it PATCHes in place.
export function bookingEditInitial(b) {
  return {
    ...bookingDuplicateInitial(b),
    scheduled_date: b.scheduled_date,
    scheduled_time: b.scheduled_time,
    payment_status: b.payment_status || 'pending',
    payment_method: b.payment_method || '',
  };
}

// One vocabulary: the same `status.*` keys the badges and the calendar use.
export const BOOKING_STATUS_VALUES = [
  // `draft` leads because it comes before the lifecycle rather than being
  // part of it: an admin's unfinished form, holding no court.
  'draft',
  'booked', 'confirmed', 'assigned', 'arrived', 'in_progress',
  'completed', 'closed', 'cancelled', 'no_show',
];

export const bookingStatuses = (t) => BOOKING_STATUS_VALUES.map((value) => ({
  value, label: t(`bookings:status.${value}`),
}));

export const bookingSources = (t) => [
  { value: 'admin',   label: t('bookings:admin') },
  { value: 'website', label: t('bookings:website') },
  { value: 'phone',   label: t('common:labels.phone') },
  { value: 'walk_in', label: t('bookings:walk') },
  { value: 'other',   label: t('bookings:other') },
];

export const recurrenceRules = (t) => [
  { value: 'none',        label: t('bookings:oneOff') },
  { value: 'weekly',      label: t('bookings:weekly') },
  { value: 'fortnightly', label: t('bookings:fortnightly') },
];

export const bookingTypes = (t) => [
  { value: 'walk_in', label: t('bookings:walk') },
  { value: 'advance', label: t('bookings:advance') },
];

export const bookingPriorities = (t) => [
  { value: 'normal', label: t('bookings:normal') },
  { value: 'urgent', label: t('bookings:urgent') },
  { value: 'vip',    label: 'VIP' },
];

export const BOOKING_PAYMENT_STATUS_VALUES = [
  'pending', 'paid', 'partially_paid', 'covered', 'no_payment_required',
];

export const paymentStatuses = (t) => BOOKING_PAYMENT_STATUS_VALUES.map((value) => ({
  value, label: t(`bookings:paymentStatus.${value}`),
}));

export const paymentMethods = (t) => [
  { value: 'cash',          label: t('bookings:cash') },
  { value: 'card',          label: t('bookings:card2') },
  { value: 'online',        label: t('bookings:online') },
  { value: 'bank_transfer', label: t('bookings:bankTransfer') },
];

// Forward transitions offered in the UI, keyed by current status. Cancel is a
// separate action available from any non-terminal status.
export const NEXT_STATUSES = {
  booked:      ['confirmed'],
  confirmed:   ['assigned'],
  assigned:    ['arrived', 'in_progress'],
  arrived:     ['in_progress'],
  in_progress: ['completed'],
  completed:   ['closed'],
  closed:      [],
  cancelled:   [],
  no_show:     [],
};
