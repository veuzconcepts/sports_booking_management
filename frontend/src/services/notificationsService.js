import api from './apiClient';

export const notificationsApi = {
  list:   (params) => api.get('/notifications/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/notifications/${id}/`).then((r) => r.data),
  resend: (id)     => api.post(`/notifications/${id}/resend/`).then((r) => r.data),
  // In-app bell feed (the signed-in user's own notifications).
  mine:        ()   => api.get('/notifications/mine/').then((r) => r.data),
  unreadCount: ()   => api.get('/notifications/unread-count/').then((r) => r.data),
  markRead:    (id) => api.post(`/notifications/${id}/read/`).then((r) => r.data),
  markAllRead: ()   => api.post('/notifications/mark-all-read/').then((r) => r.data),
};

export const templatesApi = {
  list:   (params) => api.get('/notifications/templates/', { params }).then((r) => r.data),
  create: (data)   => api.post('/notifications/templates/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/notifications/templates/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/notifications/templates/${id}/`),
};

export const notificationChannels = (t) => [
  { value: 'email', label: t('common:labels.email') },
  { value: 'sms',   label: 'SMS' },
  { value: 'push',  label: t('notifications:push') },
];

export const notificationStatuses = (t) => [
  { value: 'pending', label: t('notifications:pending') },
  { value: 'sent',    label: t('notifications:sent') },
  { value: 'failed',  label: t('common:state.failed') },
];
