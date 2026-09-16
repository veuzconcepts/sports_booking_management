import api from './apiClient';

export const customersApi = {
  list:   (params) => api.get('/customers/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/customers/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/customers/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/customers/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/customers/${id}/`),
  // Find an existing customer by email/phone (for duplicate "use existing" prompts).
  lookup: (params) => api.get('/customers/lookup/', { params }).then((r) => r.data),
  // Per-customer Activity Log (audit entries whose subject is this customer).
  activity: (id, params) => api.get(`/customers/${id}/activity/`, { params }).then((r) => r.data),
  // Duplicate records sharing this customer's email/phone (merge candidates).
  duplicates: (id) => api.get(`/customers/${id}/duplicates/`).then((r) => r.data),
  // Merge the given source records INTO this one (survivor keeps its number).
  merge: (id, sourceIds) =>
    api.post(`/customers/${id}/merge/`, { source_ids: sourceIds }).then((r) => r.data),
  // Manually mark a customer verified (requires customers.verify).
  verify: (id) => api.post(`/customers/${id}/verify/`).then((r) => r.data),
  adjustLoyalty: (id, payload) =>
    api.post(`/customers/${id}/adjust-loyalty/`, payload).then((r) => r.data),
  // Login management (mobile-app login only; there is no customer web portal).
  createLogin:  (id, payload) => api.post(`/customers/${id}/create-login/`, payload || {}).then((r) => r.data),
  inviteLogin:  (id)          => api.post(`/customers/${id}/invite-login/`).then((r) => r.data),
  linkUser:     (id, userId)  => api.post(`/customers/${id}/link-user/`, { user: userId }).then((r) => r.data),
  disableLogin: (id)          => api.post(`/customers/${id}/disable-login/`).then((r) => r.data),
  enableLogin:  (id)          => api.post(`/customers/${id}/enable-login/`).then((r) => r.data),
};

export const addressesApi = {
  list:   (params) => api.get('/customers/addresses/', { params }).then((r) => r.data),
  create: (data)   => api.post('/customers/addresses/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/customers/addresses/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/customers/addresses/${id}/`),
};
