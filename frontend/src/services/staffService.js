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

export const TRANSFER_SHIFT_OPTIONS = [
  { value: 'apply_club', label: 'Apply destination club schedule' },
  { value: 'retain_custom', label: 'Retain employee custom schedule' },
  { value: 'configure', label: 'Configure new schedule later' },
];
export const TRANSFER_STATUS_LABELS = {
  pending_approval: 'Pending approval', approved: 'Scheduled',
  completed: 'Completed', cancelled: 'Cancelled',
};

export const shiftsApi = {
  list:   (params) => api.get('/staff/shifts/', { params }).then((r) => r.data),
  create: (data)   => api.post('/staff/shifts/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/staff/shifts/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/staff/shifts/${id}/`),
};

export const EMPLOYMENT_TYPES = [
  { value: 'full_time', label: 'Full-time' },
  { value: 'part_time', label: 'Part-time' },
  { value: 'contract',  label: 'Contract' },
];

// Internal roles a staff profile can hold (mirrors accounts.Role minus customer).
export const STAFF_ROLE_OPTIONS = [
  { value: 'manager',      label: 'Manager' },
  { value: 'facility_operator', label: 'Facility Operator' },
  { value: 'facility_staff',         label: 'Facility Staff' },
  { value: 'admin',        label: 'Admin' },
];
