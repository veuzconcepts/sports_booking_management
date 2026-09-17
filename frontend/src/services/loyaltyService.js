import api from './apiClient';

export const loyaltyApi = {
  getConfig:    ()      => api.get('/loyalty/config/').then((r) => r.data),
  updateConfig: (d)     => api.put('/loyalty/config/', d).then((r) => r.data),

  listTiers:    ()      => api.get('/loyalty/tiers/').then((r) => r.data),
  createTier:   (d)     => api.post('/loyalty/tiers/', d).then((r) => r.data),
  updateTier:   (id, d) => api.patch(`/loyalty/tiers/${id}/`, d).then((r) => r.data),
  deleteTier:   (id)    => api.delete(`/loyalty/tiers/${id}/`),

  // Per-customer ledger (append-only) + summary.
  ledger:       (params) => api.get('/customers/loyalty/', { params }).then((r) => r.data),
  summary:      (id)     => api.get(`/customers/${id}/loyalty/`).then((r) => r.data),
  reverseEntry: (id)     => api.post(`/customers/loyalty/${id}/reverse/`).then((r) => r.data),

  reports: {
    summary:  (params) => api.get('/loyalty/reports/summary/', { params }).then((r) => r.data),
    tiers:    ()       => api.get('/loyalty/reports/tier-distribution/').then((r) => r.data),
    top:      (params) => api.get('/loyalty/reports/top-customers/', { params }).then((r) => r.data),
    liability:()       => api.get('/loyalty/reports/liability/').then((r) => r.data),
  },
};
