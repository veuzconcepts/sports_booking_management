import api from './apiClient';

export const promoCodesApi = {
  list:   (params) => api.get('/promotions/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/promotions/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/promotions/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/promotions/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/promotions/${id}/`),
  bulkGenerate: (data) => api.post('/promotions/bulk-generate/', data).then((r) => r.data),
  redemptions:  (id)   => api.get(`/promotions/${id}/redemptions/`).then((r) => r.data),
};

export const discountTypes = (t) => [
  { value: 'percent', label: t('promotions:percentage') },
  { value: 'fixed',   label: t('promotions:fixedAmount') },
];

export const PROMO_STATUS_TONE = {
  active: 'success', scheduled: 'info', expired: 'muted', exhausted: 'warning', inactive: 'muted',
};
