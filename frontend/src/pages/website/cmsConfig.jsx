/**
 * Declarative config for the Website CMS collections. The generic
 * CmsResourcePage + CmsFormModal render entirely from this - adding a new
 * managed content type is a config entry, not a new page.
 *
 * field types: text | textarea | number | toggle | bullets | media | select | fk
 *
 * `cmsResources(t)` is a factory rather than a constant so every label goes
 * through the active language. Call it from a useMemo keyed on `t`.
 */
import { websiteApi, sectionKeys } from '../../services/websiteService.js';

const enabledField = (t) => ({ name: 'is_enabled', label: t('cms.enabled'), type: 'toggle',
  hint: t('cms.enabledHint'), default: true });
const orderField = (t) => ({ name: 'display_order', label: t('cms.displayOrder'), type: 'number',
  hint: t('cms.displayOrderHint'), default: 0 });

// Media output presets.
// Hero banner: the car cut-out image (1128×617), placed inside the hero area by
// the club. PNG keeps it transparent so the background stripes show through.
const BANNER = { aspect: 1128 / 617, output: { width: 1128, height: 617, type: 'image/png' } };
const WIDE = { aspect: 1.6, output: { width: 1600, height: 1000, type: 'image/jpeg', quality: 0.9 } };
const CARD = { aspect: 1.4, output: { width: 1000, height: 720, type: 'image/jpeg', quality: 0.9 } };
const SQUARE = { aspect: 1, output: { width: 400, height: 400, type: 'image/jpeg', quality: 0.9 } };
const ICON = { aspect: 1, output: { width: 256, height: 256, type: 'image/png' }, kind: 'icon' };
const LOGO = { aspect: 2, output: { width: 480, height: 240, type: 'image/png' }, kind: 'logo' };
const OG = { aspect: 1.91, output: { width: 1200, height: 630, type: 'image/jpeg', quality: 0.9 } };

export const cmsResources = (t) => ({
  sections: {
    key: 'sections', path: 'sections', title: t('homeSections'), singular: t('cms.singular.section'),
    api: websiteApi.sections, hasPublish: true, modalSize: 'lg',
    columns: [
      { key: 'key_display', header: t('section'), render: (r) => r.key_display || r.key },
      { key: 'title', header: t('title'), render: (r) => r.title || '-' },
    ],
    fields: [
      { name: 'key', label: t('section'), type: 'select', options: sectionKeys(t), required: true,
        hint: t('whichHomepageSectionControlsOne') },
      { name: 'eyebrow', label: t('eyebrow'), type: 'text', hint: t('smallLabelAboveTitle') },
      { name: 'title', label: t('title'), type: 'text' },
      { name: 'subtitle', label: t('subtitle'), type: 'text' },
      { name: 'description', label: t('description'), type: 'textarea' },
      { name: 'image', label: t('image'), type: 'media', ...CARD },
      { name: 'background_image', label: t('backgroundImage'), type: 'media', ...WIDE },
      { name: 'primary_button_label', label: t('primaryButtonLabel'), type: 'text' },
      { name: 'primary_button_url', label: t('primaryButtonUrl'), type: 'text' },
      { name: 'secondary_button_label', label: t('secondaryButtonLabel'), type: 'text' },
      { name: 'secondary_button_url', label: t('secondaryButtonUrl'), type: 'text' },
      { name: 'animation', label: t('animation'), type: 'text', hint: t('optionalHintEGFade') },
      enabledField(t), orderField(t),
    ],
  },

  banners: {
    key: 'banners', path: 'banners', title: t('heroBanners'), singular: t('cms.singular.banner'),
    api: websiteApi.banners, hasPublish: true,
    columns: [{ key: 'heading', header: t('heading'), render: (r) => r.heading }],
    fields: [
      { name: 'heading', label: t('heading'), type: 'text', required: true },
      { name: 'subheading', label: t('subheading'), type: 'text' },
      { name: 'image', label: t('carImage1128617'), type: 'media', ...BANNER },
      { name: 'cta_label', label: t('buttonLabel'), type: 'text' },
      { name: 'cta_url', label: t('buttonUrl'), type: 'text' },
      enabledField(t), orderField(t),
    ],
  },

  'process-steps': {
    key: 'process-steps', path: 'process-steps', title: t('howItWorks'), singular: t('cms.singular.step'),
    api: websiteApi.processSteps, hasPublish: true,
    columns: [
      { key: 'step_no', header: 'No.', render: (r) => r.step_no || '-' },
      { key: 'title', header: t('title'), render: (r) => r.title },
    ],
    fields: [
      { name: 'step_no', label: t('stepNumber'), type: 'text', hint: 'e.g. 01' },
      { name: 'title', label: t('title'), type: 'text', required: true },
      { name: 'description', label: t('description'), type: 'textarea' },
      { name: 'icon', label: t('icon'), type: 'media', ...ICON },
      enabledField(t), orderField(t),
    ],
  },

  'why-choose-us': {
    key: 'why-choose-us', path: 'why-choose-us', title: t('whyChooseUs'), singular: t('cms.singular.point'),
    api: websiteApi.whyChooseUs, hasPublish: true,
    columns: [{ key: 'title', header: t('title'), render: (r) => r.title }],
    fields: [
      { name: 'title', label: t('title'), type: 'text', required: true },
      { name: 'description', label: t('description'), type: 'textarea' },
      { name: 'icon', label: t('icon'), type: 'media', ...ICON },
      enabledField(t), orderField(t),
    ],
  },

  stats: {
    key: 'stats', path: 'stats', title: t('stats'), singular: t('cms.singular.stat'),
    api: websiteApi.stats, hasPublish: true,
    columns: [
      { key: 'value', header: t('value'), render: (r) => r.value },
      { key: 'label', header: t('label'), render: (r) => r.label },
    ],
    fields: [
      { name: 'value', label: t('value'), type: 'text', required: true, hint: 'e.g. 1830+' },
      { name: 'label', label: t('label'), type: 'text', required: true },
      enabledField(t), orderField(t),
    ],
  },

  testimonials: {
    key: 'testimonials', path: 'testimonials', title: t('testimonials'), singular: t('cms.singular.testimonial'),
    api: websiteApi.testimonials, hasPublish: true,
    columns: [
      { key: 'author_name', header: t('author'), render: (r) => r.author_name },
      { key: 'rating', header: t('rating'), render: (r) => `${r.rating}/5` },
    ],
    fields: [
      { name: 'author_name', label: t('authorName'), type: 'text', required: true },
      { name: 'author_role', label: t('authorRole'), type: 'text' },
      { name: 'author_photo', label: t('authorPhoto'), type: 'media', ...SQUARE },
      { name: 'rating', label: t('rating15'), type: 'number', default: 5 },
      { name: 'quote', label: t('quote'), type: 'textarea', required: true },
      enabledField(t), orderField(t),
    ],
  },

  brands: {
    key: 'brands', path: 'brands', title: t('trustedBrands'), singular: t('cms.singular.brand'),
    api: websiteApi.brands, hasPublish: true,
    columns: [{ key: 'name', header: t('common:labels.name'), render: (r) => r.name }],
    fields: [
      { name: 'name', label: t('common:labels.name'), type: 'text', required: true },
      { name: 'logo', label: t('logo'), type: 'media', ...LOGO },
      { name: 'url', label: t('websiteUrl'), type: 'text' },
      enabledField(t), orderField(t),
    ],
  },

  faqs: {
    key: 'faqs', path: 'faqs', title: t('cms.faqs'), singular: t('cms.singular.faq'),
    api: websiteApi.faqs, hasPublish: true,
    columns: [{ key: 'question', header: t('question'), render: (r) => r.question }],
    fields: [
      { name: 'question', label: t('question'), type: 'text', required: true },
      { name: 'answer', label: t('answer'), type: 'textarea', required: true },
      enabledField(t), orderField(t),
    ],
  },

  seo: {
    key: 'seo', path: 'seo', title: t('seoSettings'), singular: t('cms.singular.seoEntry'),
    api: websiteApi.seo, hasPublish: false, modalSize: 'lg',
    columns: [
      { key: 'path', header: t('path'), render: (r) => r.path },
      { key: 'meta_title', header: t('metaTitle'), render: (r) => r.meta_title || '-' },
    ],
    fields: [
      { name: 'path', label: t('pagePath'), type: 'text', required: true, hint: 'e.g. "/" for the home page.' },
      { name: 'meta_title', label: t('metaTitle'), type: 'text' },
      { name: 'meta_description', label: t('metaDescription'), type: 'textarea' },
      { name: 'og_image', label: t('socialImageOg'), type: 'media', ...OG },
      { name: 'canonical_url', label: t('canonicalUrl'), type: 'text' },
      { name: 'robots', label: t('robots'), type: 'text', default: 'index,follow' },
    ],
  },
});
