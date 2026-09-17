import api from './apiClient';

/**
 * Languages: the admin catalogue, the public list a visitor may choose from,
 * and the signed-in user's own preference.
 *
 * The preference is saved on the user profile through the existing `/auth/me/`
 * endpoint rather than a separate preferences store, so there is one place a
 * user's settings live.
 */
export const languagesApi = {
  /** Enabled languages plus the default. Unauthenticated: the login page needs it. */
  publicList: () => api.get('/settings/languages/public/').then((r) => r.data),

  list:   (params) => api.get('/settings/languages/', { params }).then((r) => r.data),
  create: (data)   => api.post('/settings/languages/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/settings/languages/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/settings/languages/${id}/`),
  makeDefault: (id) => api.post(`/settings/languages/${id}/make-default/`).then((r) => r.data),

  /** Remember the signed-in user's choice. Blank follows the organization default. */
  savePreference: (code) => api.patch('/auth/me/', { language: code }).then((r) => r.data),
};
