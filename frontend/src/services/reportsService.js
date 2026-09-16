import api from './apiClient';

export const reportsApi = {
  summary:     ()       => api.get('/reports/summary/').then((r) => r.data),
  revenue:     (params) => api.get('/reports/revenue/', { params }).then((r) => r.data),
  bookings:    (params) => api.get('/reports/bookings/', { params }).then((r) => r.data),
  services:    (params) => api.get('/reports/services/', { params }).then((r) => r.data),
  performance: (params) => api.get('/reports/performance/', { params }).then((r) => r.data),
  memberships: (params) => api.get('/reports/memberships/', { params }).then((r) => r.data),
  // `fmt` is xlsx | pdf (avoid `format` - DRF reserves it). Returns a Blob.
  export: (report, fmt, params = {}) =>
    api.get('/reports/export/', { params: { report, fmt, ...params }, responseType: 'blob' })
      .then((r) => r.data),
};
