import api from './apiClient';

export const taxRatesApi = {
  list:   (params) => api.get('/settings/tax-rates/', { params }).then((r) => r.data),
  create: (data)   => api.post('/settings/tax-rates/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/settings/tax-rates/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/settings/tax-rates/${id}/`),
};

export const configApi = {
  list:   (params)    => api.get('/settings/config/', { params }).then((r) => r.data),
  update: (key, data) => api.patch(`/settings/config/${key}/`, data).then((r) => r.data),
};

export const currencyApi = {
  get:    ()     => api.get('/settings/currency/').then((r) => r.data),
  update: (code) => api.put('/settings/currency/', { currency: code }).then((r) => r.data),
};

export const organizationApi = {
  get:    ()  => api.get('/settings/organization/').then((r) => r.data),
  update: (d) => api.put('/settings/organization/', d).then((r) => r.data),
  // Multipart update for branding images (logos / favicon / OG). `formData` is a
  // FormData with files and/or text fields; empty string clears an image.
  updateForm: (formData) =>
    api.put('/settings/organization/', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data),
};

export const bookingConfigApi = {
  get:    ()  => api.get('/settings/booking-config/').then((r) => r.data),
  update: (d) => api.put('/settings/booking-config/', d).then((r) => r.data),
};
