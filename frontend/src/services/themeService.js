import api from './apiClient';

/**
 * The organization theme and its saved presets.
 *
 * `publicTheme` is deliberately separate: it is the only call here that works
 * without a session, because the sign-in screen has to be branded before
 * anyone has signed in.
 */
export const themeApi = {
  /** Active theme, the token catalogue, and the contrast report. */
  get: () => api.get('/settings/theme/').then((r) => r.data),

  /** Save and apply. `theme` holds only the tokens that differ from default. */
  save: (theme, presetName = '') =>
    api.put('/settings/theme/', { theme, preset_name: presetName }).then((r) => r.data),

  /** Restore the system default palette. */
  reset: () => api.delete('/settings/theme/').then((r) => r.data),

  /** Score a theme that has not been saved yet. */
  contrast: (theme) =>
    api.post('/settings/theme/contrast/', { theme }).then((r) => r.data),

  /** Palette, logo and display name for a signed-out visitor. */
  publicTheme: () => api.get('/settings/theme/public/').then((r) => r.data),
};

export const themePresetsApi = {
  list: (params) => api.get('/settings/theme-presets/', { params }).then((r) => r.data),
  create: (data) => api.post('/settings/theme-presets/', data).then((r) => r.data),
  update: (id, data) => api.patch(`/settings/theme-presets/${id}/`, data).then((r) => r.data),
  /** Archives rather than deletes, so the audit trail stays readable. */
  remove: (id) => api.delete(`/settings/theme-presets/${id}/`),
  apply: (id) => api.post(`/settings/theme-presets/${id}/apply/`).then((r) => r.data),
  duplicate: (id) => api.post(`/settings/theme-presets/${id}/duplicate/`).then((r) => r.data),
};
