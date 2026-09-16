import api from './apiClient';

// Generic CRUD + publish for a website CMS collection under /website/<base>/.
const crud = (base) => ({
  base,
  list:   (params) => api.get(`/website/${base}/`, { params }).then((r) => r.data),
  get:    (id) => api.get(`/website/${base}/${id}/`).then((r) => r.data),
  create: (data) => api.post(`/website/${base}/`, data).then((r) => r.data),
  update: (id, data) => api.patch(`/website/${base}/${id}/`, data).then((r) => r.data),
  remove: (id) => api.delete(`/website/${base}/${id}/`),
  setPublished: (id, is_published) =>
    api.post(`/website/${base}/${id}/set-published/`, { is_published }).then((r) => r.data),
});

export const websiteApi = {
  sections:    crud('sections'),
  banners:     crud('banners'),
  processSteps: crud('process-steps'),
  whyChooseUs: crud('why-choose-us'),
  stats:       crud('stats'),
  testimonials: crud('testimonials'),
  brands:      crud('brands'),
  faqs:        crud('faqs'),
  seo:         crud('seo'),
};

// Media Library - uploads are multipart (file + metadata).
export const mediaApi = {
  list: (params) => api.get('/website/media/', { params }).then((r) => r.data),
  upload: (file, { title = '', alt_text = '', kind = 'image' } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    if (title) fd.append('title', title);
    if (alt_text) fd.append('alt_text', alt_text);
    if (kind) fd.append('kind', kind);
    return api.post('/website/media/', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((r) => r.data);
  },
  remove: (id) => api.delete(`/website/media/${id}/`),
};

// Singleton footer config.
export const footerApi = {
  get: () => api.get('/website/footer/').then((r) => r.data),
  update: (data) => api.patch('/website/footer/', data).then((r) => r.data),
};

export const MEDIA_KINDS = [
  { value: 'image', label: 'Image' },
  { value: 'icon', label: 'Icon' },
  { value: 'logo', label: 'Logo' },
  { value: 'video', label: 'Video' },
];

export const SECTION_KEYS = [
  { value: 'hero', label: 'Hero' },
  { value: 'how_it_works', label: 'How It Works' },
  { value: 'why_choose_us', label: 'Why Choose Us' },
  { value: 'services', label: 'Services' },
  { value: 'packages', label: 'Packages' },
  { value: 'membership', label: 'Membership Highlights' },
  { value: 'projects', label: 'Latest Projects' },
  { value: 'stats', label: 'Stats' },
  { value: 'brands', label: 'Trusted Brands' },
  { value: 'testimonials', label: 'Testimonials' },
  { value: 'faq', label: 'FAQ' },
  { value: 'cta_band', label: 'Call To Action' },
  { value: 'app_promo', label: 'App Promo' },
];

