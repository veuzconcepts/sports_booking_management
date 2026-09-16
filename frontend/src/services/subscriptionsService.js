import api from './apiClient';

// Subscriptions = membership plans (the catalogue) + customer memberships.
// The REST paths stay under /payments/ (where the models live, and what the
// mobile app calls); the admin UI + permissions are a separate Subscriptions
// module. Writes are gated by subscriptions.* capabilities on the backend.

export const membershipPlansApi = {
  list:   (params) => api.get('/payments/membership-plans/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/payments/membership-plans/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/payments/membership-plans/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/payments/membership-plans/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/payments/membership-plans/${id}/`),
  // Live included-value / savings for a DRAFT plan (unsaved entitlements).
  valuePreview: (payload) =>
    api.post('/payments/membership-plans/value-preview/', payload).then((r) => r.data),
  activity: (id, params) =>
    api.get(`/payments/membership-plans/${id}/activity/`, { params }).then((r) => r.data),
};

export const membershipsApi = {
  list:  (params) => api.get('/payments/memberships/', { params }).then((r) => r.data),
  get:   (id)     => api.get(`/payments/memberships/${id}/`).then((r) => r.data),
  issue: (customer, plan, { club, method, promo, autoRenew = true } = {}) =>
    api.post('/payments/memberships/issue/',
      { customer, plan, club, method, promo_code: promo, auto_renew: autoRenew })
      .then((r) => r.data),
  download: (id) =>
    api.get(`/payments/memberships/${id}/download/`, { responseType: 'blob' }).then((r) => r.data),
  renew:   (id, method, { confirmEarly = false } = {}) =>
    api.post(`/payments/memberships/${id}/renew/`, { method, confirm_early: confirmEarly }).then((r) => r.data),
  suspend: (id, reason) => api.post(`/payments/memberships/${id}/suspend/`, { reason }).then((r) => r.data),
  resume:  (id) => api.post(`/payments/memberships/${id}/resume/`).then((r) => r.data),
  cancel:  (id, reason) => api.post(`/payments/memberships/${id}/cancel/`, { reason }).then((r) => r.data),
  extend:  (id, body) => api.post(`/payments/memberships/${id}/extend/`, body).then((r) => r.data),
  adjustUsage: (id, body) => api.post(`/payments/memberships/${id}/adjust-usage/`, body).then((r) => r.data),
  usage:   (id, params) => api.get(`/payments/memberships/${id}/usage/`, { params }).then((r) => r.data),
  activity: (id, params) => api.get(`/payments/memberships/${id}/activity/`, { params }).then((r) => r.data),
};

export const MEMBERSHIP_PAYMENT_METHODS = [
  { value: 'card',   label: 'Card' },
  { value: 'cash',   label: 'Cash' },
  { value: 'wallet', label: 'Wallet' },
];

export const MEMBERSHIP_INTERVALS = [
  { value: 'monthly',     label: 'Monthly' },
  { value: 'quarterly',   label: 'Quarterly' },
  { value: 'half_yearly', label: 'Half-yearly' },
  { value: 'annual',      label: 'Yearly' },
  { value: 'custom',      label: 'Custom duration' },
];

export const VALIDITY_MODES = [
  { value: 'rolling', label: 'Rolling from purchase date' },
  { value: 'fixed',   label: 'Fixed start & end date' },
];

export const ENTITLEMENT_TARGETS = [
  { value: 'facility_type', label: 'Service item' },
  { value: 'category',     label: 'Service category' },
  { value: 'addon',        label: 'Add-on' },
];

export const ENTITLEMENT_LIMITS = [
  { value: 'unlimited', label: 'Unlimited' },
  { value: 'limited',   label: 'Limited' },
];

export const ENTITLEMENT_PERIODS = [
  { value: 'lifetime', label: 'Per membership (lifetime)' },
  { value: 'monthly',  label: 'Per month' },
  { value: 'weekly',   label: 'Per week' },
  { value: 'daily',    label: 'Per day' },
];

export const MEMBERSHIP_STATUS_TONE = {
  draft: 'muted', active: 'success', suspended: 'warning',
  expired: 'muted', cancelled: 'danger',
};
export const MEMBERSHIP_STATUS_LABELS = {
  draft: 'Draft', active: 'Active', suspended: 'Suspended',
  expired: 'Expired', cancelled: 'Cancelled',
};
