import api from './apiClient';

export const staffApi = {
  list:   (params) => api.get('/staff/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/staff/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/staff/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/staff/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/staff/${id}/`),
  performanceHistory: (id) =>
    api.get(`/staff/${id}/performance-history/`).then((r) => r.data),
  // Set/clear the employee's custom weekly shift schedule (empty = inherit).
  setSchedule: (id, shiftHours) =>
    api.put(`/staff/${id}/schedule/`, { shift_hours: shiftHours }).then((r) => r.data),
  activity: (id, params) =>
    api.get(`/staff/${id}/activity/`, { params }).then((r) => r.data),
  transferImpact: (id) =>
    api.get(`/staff/${id}/transfer-impact/`).then((r) => r.data),
};

export const transfersApi = {
  list:    (params) => api.get('/staff/transfers/', { params }).then((r) => r.data),
  create:  (data)   => api.post('/staff/transfers/', data).then((r) => r.data),
  approve: (id)     => api.post(`/staff/transfers/${id}/approve/`).then((r) => r.data),
  cancel:  (id, reason) => api.post(`/staff/transfers/${id}/cancel/`, { reason }).then((r) => r.data),
};

export const transferShiftOptions = (t) => [
  { value: 'apply_club', label: t('staff:applyDestinationClubSchedule') },
  { value: 'retain_custom', label: t('staff:retainEmployeeCustomSchedule') },
  { value: 'configure', label: t('staff:configureNewScheduleLater') },
];
export const transferStatusLabels = (t) => ({
  pending_approval: 'Pending approval', approved: 'Scheduled',
  completed: 'Completed', cancelled: 'Cancelled',
});

export const shiftsApi = {
  list:   (params) => api.get('/staff/shifts/', { params }).then((r) => r.data),
  create: (data)   => api.post('/staff/shifts/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/staff/shifts/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/staff/shifts/${id}/`),
};

export const employmentTypes = (t) => [
  { value: 'full_time', label: t('staff:fullTime') },
  { value: 'part_time', label: t('staff:partTime') },
  { value: 'contract',  label: t('staff:contract') },
];

// Internal roles a staff profile can hold (mirrors accounts.Role minus customer).
export const staffRoleOptions = (t) => [
  { value: 'manager',      label: t('staff:manager') },
  { value: 'facility_operator', label: t('staff:facilityOperator') },
  { value: 'facility_staff',         label: t('staff:facilityStaff') },
  { value: 'admin',        label: t('staff:admin') },
];
