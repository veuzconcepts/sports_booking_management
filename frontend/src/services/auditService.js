import api from './apiClient';

export const auditApi = {
  list: (params) => api.get('/auditlogs/', { params }).then((r) => r.data),
  get:  (id)     => api.get(`/auditlogs/${id}/`).then((r) => r.data),
};

export const AUDIT_METHODS = [
  { value: 'POST',   label: 'POST' },
  { value: 'PUT',    label: 'PUT' },
  { value: 'PATCH',  label: 'PATCH' },
  { value: 'DELETE', label: 'DELETE' },
];
