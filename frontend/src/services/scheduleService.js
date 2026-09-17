import api from './apiClient';

/**
 * Scheduling: the effective week at any scope, special dates, and the
 * "what would this break?" check.
 *
 * The weekly pattern itself is saved through the scope that owns it - the
 * organization, club or facility endpoint - so there is one writable home per
 * scope rather than a parallel schedule API.
 */
export const scheduleApi = {
  /** The resolved week for a scope, each day tagged with where it came from. */
  effective: (scope) => api.get('/settings/schedule/effective/', {
    params: scope || undefined,
  }).then((r) => r.data),

  /** Live bookings the CURRENT schedule would no longer allow. */
  impact: (params) => api.get('/settings/schedule/impact/', { params })
    .then((r) => r.data),
};

/** Special dates: holidays, Ramadan hours, tournaments, temporary closures. */
export const scheduleExceptionsApi = {
  list:   (params) => api.get('/settings/schedule-exceptions/', { params }).then((r) => r.data),
  create: (data)   => api.post('/settings/schedule-exceptions/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/settings/schedule-exceptions/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/settings/schedule-exceptions/${id}/`),

  /**
   * Bookings a special date would strand, asked BEFORE anything is saved.
   * Send the same body the save would send; nothing is written.
   */
  impact: (data) => api.post('/settings/schedule-exceptions/impact/', data)
    .then((r) => r.data),

  /** Bookings that would fall outside the schedule if this row were removed. */
  removalImpact: (id) => api.get(`/settings/schedule-exceptions/${id}/removal-impact/`)
    .then((r) => r.data),
};
