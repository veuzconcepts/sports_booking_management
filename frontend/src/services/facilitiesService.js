import api from './apiClient';

// Use multipart automatically when a FormData payload is passed (image uploads).
const multipartCfg = (data) =>
  (typeof FormData !== 'undefined' && data instanceof FormData)
    ? { headers: { 'Content-Type': 'multipart/form-data' } }
    : undefined;

/** Facility categories - the merchandising groups shown on the website. */
export const facilityCategoriesApi = {
  list:   (params) => api.get('/facilities/categories/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/facilities/categories/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/facilities/categories/', data, multipartCfg(data)).then((r) => r.data),
  update: (id, d)  => api.patch(`/facilities/categories/${id}/`, d, multipartCfg(d)).then((r) => r.data),
  remove: (id)     => api.delete(`/facilities/categories/${id}/`),
};

/** Facility types - the bookable, priced offerings. */
export const facilityTypesApi = {
  list:   (params) => api.get('/facilities/types/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/facilities/types/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/facilities/types/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/facilities/types/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/facilities/types/${id}/`),
  // Image/video are uploaded separately as multipart (avoids nested-multipart issues).
  uploadMedia: (id, formData) =>
    api.patch(`/facilities/types/${id}/`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data),
};

/** Facilities - the physical bookable units (courts, pitches, lanes, rooms). */
export const facilitiesApi = {
  list:   (params) => api.get('/facilities/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/facilities/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/facilities/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/facilities/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/facilities/${id}/`),
};

export const addonsApi = {
  list:   (params) => api.get('/facilities/addons/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/facilities/addons/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/facilities/addons/', data, multipartCfg(data)).then((r) => r.data),
  update: (id, d)  => api.patch(`/facilities/addons/${id}/`, d, multipartCfg(d)).then((r) => r.data),
  remove: (id)     => api.delete(`/facilities/addons/${id}/`),
};

/** Periods a facility is out of service (drops it from bookable capacity). */
export const maintenanceBlocksApi = {
  list:   (params) => api.get('/facilities/maintenance-blocks/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/facilities/maintenance-blocks/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/facilities/maintenance-blocks/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/facilities/maintenance-blocks/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/facilities/maintenance-blocks/${id}/`),
};

export const pricingRulesApi = {
  list:    (params) => api.get('/facilities/pricing-rules/', { params }).then((r) => r.data),
  get:     (id)     => api.get(`/facilities/pricing-rules/${id}/`).then((r) => r.data),
  create:  (data)   => api.post('/facilities/pricing-rules/', data).then((r) => r.data),
  update:  (id, d)  => api.patch(`/facilities/pricing-rules/${id}/`, d).then((r) => r.data),
  remove:  (id)     => api.delete(`/facilities/pricing-rules/${id}/`),
  preview: (data)   => api.post('/facilities/pricing-rules/preview/', data).then((r) => r.data),
};

export const BADGE_STATUSES = [
  { value: 'hide', label: 'Hide' },
  { value: 'show', label: 'Show' },
];

export const FACILITY_BADGES = [
  { value: 'premium',     label: 'Premium' },
  { value: 'recommended', label: 'Recommended' },
  { value: 'bestseller',  label: 'Bestseller' },
];

/** Broad nature of a facility category (mirrors facilities.FacilityKind). */
export const FACILITY_KINDS = [
  { value: 'outdoor_court', label: 'Outdoor Court' },
  { value: 'indoor_court',  label: 'Indoor Court' },
  { value: 'pitch',         label: 'Pitch / Field' },
  { value: 'aquatic',       label: 'Aquatic' },
  { value: 'hall',          label: 'Hall' },
  { value: 'meeting_room',  label: 'Meeting Room' },
  { value: 'other',         label: 'Other' },
];

export const RULE_TYPES = [
  { value: 'club',       label: 'Club Pricing' },
  { value: 'membership', label: 'Membership Discount' },
  { value: 'promo',      label: 'Promo Pricing' },
  { value: 'date_range', label: 'Date Range Pricing' },
  { value: 'weekend',    label: 'Weekend Pricing' },
  { value: 'peak_hour',  label: 'Peak Hour Pricing' },
  { value: 'custom',     label: 'Custom Pricing' },
];

export const ADJUSTMENT_TYPES = [
  { value: 'fixed_increase',   label: 'Fixed Amount Increase' },
  { value: 'fixed_discount',   label: 'Fixed Amount Discount' },
  { value: 'percent_increase', label: 'Percentage Increase' },
  { value: 'percent_discount', label: 'Percentage Discount' },
  { value: 'override',         label: 'Override Price' },
];

export const DAYS_OF_WEEK = [
  { value: 0, label: 'Monday' },
  { value: 1, label: 'Tuesday' },
  { value: 2, label: 'Wednesday' },
  { value: 3, label: 'Thursday' },
  { value: 4, label: 'Friday' },
  { value: 5, label: 'Saturday' },
  { value: 6, label: 'Sunday' },
];

export const CUSTOMER_TYPES = [
  { value: 'bronze',   label: 'Bronze' },
  { value: 'silver',   label: 'Silver' },
  { value: 'gold',     label: 'Gold' },
  { value: 'platinum', label: 'Platinum' },
];
