import api from './apiClient';

/** Clubs - the venues that own bookable facilities. */
export const clubsApi = {
  list:   (params) => api.get('/clubs/', { params }).then((r) => r.data),
  get:    (id)     => api.get(`/clubs/${id}/`).then((r) => r.data),
  create: (data)   => api.post('/clubs/', data).then((r) => r.data),
  update: (id, d)  => api.patch(`/clubs/${id}/`, d).then((r) => r.data),
  remove: (id)     => api.delete(`/clubs/${id}/`),
};
