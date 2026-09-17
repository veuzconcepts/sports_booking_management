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
  campaigns:   crud('campaigns'),
};

/** Campaign type / frequency / placement vocabularies, translated for display.
 *  The values are the backend's stable codes and are never translated. */
export const campaignTypes = (t) => [
  'offer', 'holiday', 'ramadan', 'eid', 'national_day', 'event', 'tournament',
  'membership', 'new_facility', 'announcement', 'maintenance', 'marketing', 'custom',
].map((value) => ({ value, label: t(`website:campaigns.types.${value}`) }));

export const campaignFrequencies = (t) => [
  'session', 'every_visit', 'daily', 'once', 'until_closed',
].map((value) => ({ value, label: t(`website:campaigns.frequency.${value}`) }));

export const campaignPlacements = (t) => [
  'home', 'booking', 'all',
].map((value) => ({ value, label: t(`website:campaigns.placement.${value}`) }));

export const campaignAudiences = (t) => [
  'everyone', 'guests', 'members',
].map((value) => ({ value, label: t(`website:campaigns.audience.${value}`) }));

export const campaignPriorities = (t) => [
  { value: 30, label: t('website:campaigns.priority.high') },
  { value: 20, label: t('website:campaigns.priority.normal') },
  { value: 10, label: t('website:campaigns.priority.low') },
];

export const campaignStatuses = (t) => [
  'draft', 'scheduled', 'active', 'expired', 'disabled',
].map((value) => ({ value, label: t(`website:campaigns.status.${value}`) }));

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

export const mediaKinds = (t) => [
  { value: 'image', label: t('website:image') },
  { value: 'icon', label: t('website:icon') },
  { value: 'logo', label: t('website:logo') },
  { value: 'video', label: t('website:video') },
];

export const sectionKeys = (t) => [
  { value: 'hero', label: t('website:hero') },
  { value: 'how_it_works', label: t('website:howItWorks') },
  { value: 'why_choose_us', label: t('website:whyChooseUs') },
  { value: 'services', label: t('website:services') },
  { value: 'packages', label: t('website:packages') },
  { value: 'membership', label: t('website:membershipHighlights') },
  { value: 'projects', label: t('website:latestProjects') },
  { value: 'stats', label: t('website:stats') },
  { value: 'brands', label: t('website:trustedBrands') },
  { value: 'testimonials', label: t('website:testimonials') },
  { value: 'faq', label: 'FAQ' },
  { value: 'cta_band', label: t('website:callAction') },
  { value: 'app_promo', label: t('website:appPromo') },
];

