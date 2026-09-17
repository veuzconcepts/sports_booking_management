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

export const badgeStatuses = (t) => [
  { value: 'hide', label: t('facilities:hide') },
  { value: 'show', label: t('facilities:show') },
];

export const facilityBadges = (t) => [
  { value: 'premium',     label: t('facilities:premium') },
  { value: 'recommended', label: t('facilities:recommended') },
  { value: 'bestseller',  label: t('facilities:bestseller') },
];

/** Broad nature of a facility category (mirrors facilities.FacilityKind). */
export const facilityKinds = (t) => [
  { value: 'outdoor_court', label: t('facilities:outdoorCourt') },
  { value: 'indoor_court',  label: t('facilities:indoorCourt') },
  { value: 'pitch',         label: t('facilities:pitchField') },
  { value: 'aquatic',       label: t('facilities:aquatic') },
  { value: 'hall',          label: t('facilities:hall') },
  { value: 'meeting_room',  label: t('facilities:meetingRoom') },
  { value: 'other',         label: t('facilities:other') },
];

export const ruleTypes = (t) => [
  { value: 'club',       label: t('facilities:clubPricing') },
  { value: 'membership', label: t('facilities:membershipDiscount') },
  { value: 'promo',      label: t('facilities:promoPricing') },
  { value: 'date_range', label: t('facilities:dateRangePricing') },
  { value: 'weekend',    label: t('facilities:weekendPricing') },
  { value: 'peak_hour',  label: t('facilities:peakHourPricing') },
  { value: 'custom',     label: t('facilities:customPricing') },
];

export const adjustmentTypes = (t) => [
  { value: 'fixed_increase',   label: t('facilities:fixedAmountIncrease') },
  { value: 'fixed_discount',   label: t('facilities:fixedAmountDiscount') },
  { value: 'percent_increase', label: t('facilities:percentageIncrease') },
  { value: 'percent_discount', label: t('facilities:percentageDiscount') },
  { value: 'override',         label: t('facilities:overridePrice') },
];

export const daysOfWeek = (t) => [
  { value: 0, label: t('facilities:monday') },
  { value: 1, label: t('facilities:tuesday') },
  { value: 2, label: t('facilities:wednesday') },
  { value: 3, label: t('facilities:thursday') },
  { value: 4, label: t('facilities:friday') },
  { value: 5, label: t('facilities:saturday') },
  { value: 6, label: t('facilities:sunday') },
];

export const customerTypes = (t) => [
  { value: 'bronze',   label: t('facilities:bronze') },
  { value: 'silver',   label: t('facilities:silver') },
  { value: 'gold',     label: t('facilities:gold') },
  { value: 'platinum', label: t('facilities:platinum') },
];
