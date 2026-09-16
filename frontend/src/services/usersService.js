import api from './apiClient';

// Admin user management (accounts.UserViewSet, admin-only).
export const usersApi = {
  list:   (params) => api.get('/auth/users/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/auth/users/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/auth/users/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/auth/users/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/auth/users/${id}/`),
  activate:    (id) => api.post(`/auth/users/${id}/activate/`).then((r) => r.data),
  deactivate:  (id) => api.post(`/auth/users/${id}/deactivate/`).then((r) => r.data),
  unlock:      (id) => api.patch(`/auth/users/${id}/unlock/`).then((r) => r.data),
  forcePasswordChange: (id) => api.post(`/auth/users/${id}/force-password-change/`).then((r) => r.data),
  setPassword: (id, newPassword) =>
    api.post(`/auth/users/${id}/set-password/`, { new_password: newPassword }).then((r) => r.data),
  disableMfa:  (id) => api.post(`/auth/users/${id}/disable-mfa/`).then((r) => r.data),
  resetMfa:    (id) => api.post(`/auth/users/${id}/reset-mfa/`).then((r) => r.data),
  setMfaPolicy: (id, policy) =>
    api.post(`/auth/users/${id}/mfa-policy/`, { policy }).then((r) => r.data),
  // Owner-only: move the single super admin to this user (demotes the caller).
  transferSuperAdmin: (id) =>
    api.post(`/auth/users/${id}/transfer-super-admin/`).then((r) => r.data),
};

// JWT session inventory (accounts.SessionViewSet). GET returns a plain array.
// `userId` omitted = own sessions; passing it scopes to that user (admin only).
export const sessionsApi = {
  list:         (userId) => api.get('/auth/sessions/', userId ? { params: { user: userId } } : undefined).then((r) => r.data),
  listAll:      ()       => api.get('/auth/sessions/', { params: { scope: 'all' } }).then((r) => r.data),
  revoke:       (id)     => api.delete(`/auth/sessions/${id}/`),
  terminateAll: (userId) => api.post('/auth/sessions/terminate-all/', null, userId ? { params: { user: userId } } : undefined).then((r) => r.data),
};

// Access management - capability catalogue + the editable role matrix.
export const accessApi = {
  permissionsCatalog: () => api.get('/auth/permissions-catalog/').then((r) => r.data),
  listRoles:  ()           => api.get('/auth/roles/').then((r) => r.data),
  createRole: (data)       => api.post('/auth/roles/', data).then((r) => r.data),
  duplicateRole: (role, data) => api.post(`/auth/roles/${role}/duplicate/`, data).then((r) => r.data),
  updateRole: (role, data) => api.put(`/auth/roles/${role}/`, data).then((r) => r.data),
  deleteRole: (role)       => api.delete(`/auth/roles/${role}/`),
};

// Behaviour templates a created role maps to. `admin` (full access, all
// clubs, senior) is super-admin-only to assign - the backend rejects others.
export const CUSTOM_BASE_ROLES = [
  { value: 'admin',        label: 'Admin (full access, all clubs)', superOnly: true },
  { value: 'manager',      label: 'Manager (club-scoped, broad)' },
  { value: 'facility_operator', label: 'Facility Operator (club-scoped)' },
  { value: 'facility_staff',         label: 'Facility Staff (club-scoped, limited)' },
];

// Self-service account actions (any authenticated user).
export const accountApi = {
  changePassword: (oldPassword, newPassword) =>
    api.post('/auth/change-password/', { old_password: oldPassword, new_password: newPassword })
      .then((r) => r.data),
  mfaSetup:   ()     => api.post('/auth/mfa/setup/').then((r) => r.data),
  mfaConfirm: (code) => api.post('/auth/mfa/confirm/', { code }).then((r) => r.data),
  mfaDisable: ({ code, password }) =>
    api.post('/auth/mfa/disable/', { code, password }).then((r) => r.data),
  // Best-effort audit of the idle-session-timeout events (never throws).
  logIdleEvent: (event) =>
    api.post('/auth/idle-event/', { event }).then((r) => r.data).catch(() => {}),
};

export const USER_ROLES = [
  { value: 'super_admin',  label: 'Super Admin' },
  { value: 'admin',        label: 'Admin' },
  { value: 'club_admin', label: 'Club Admin (club-scoped)' },
  { value: 'manager',      label: 'Manager' },
  { value: 'facility_operator', label: 'Facility Operator' },
  { value: 'facility_staff',         label: 'Facility Staff' },
  { value: 'customer',     label: 'Customer' },
];
