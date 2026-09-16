/**
 * Declarative config for the Website CMS collections. The generic
 * CmsResourcePage + CmsFormModal render entirely from this - adding a new
 * managed content type is a config entry, not a new page.
 *
 * field types: text | textarea | number | toggle | bullets | media | select | fk
 */
import { websiteApi, SECTION_KEYS } from '../../services/websiteService.js';

const ENABLED = { name: 'is_enabled', label: 'Enabled', type: 'toggle',
  hint: 'Show this item on the club.', default: true };
const ORDER = { name: 'display_order', label: 'Display order', type: 'number',
  hint: 'Lower numbers appear first.', default: 0 };

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

export const CMS_RESOURCES = {
  sections: {
    key: 'sections', path: 'sections', title: 'Home Sections', singular: 'Section',
    api: websiteApi.sections, hasPublish: true, modalSize: 'lg',
    columns: [
      { key: 'key_display', header: 'Section', render: (r) => r.key_display || r.key },
      { key: 'title', header: 'Title', render: (r) => r.title || '-' },
    ],
    fields: [
      { name: 'key', label: 'Section', type: 'select', options: SECTION_KEYS, required: true,
        hint: 'Which homepage section this controls (one row per section).' },
      { name: 'eyebrow', label: 'Eyebrow', type: 'text', hint: 'Small label above the title.' },
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'subtitle', label: 'Subtitle', type: 'text' },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'image', label: 'Image', type: 'media', ...CARD },
      { name: 'background_image', label: 'Background image', type: 'media', ...WIDE },
      { name: 'primary_button_label', label: 'Primary button label', type: 'text' },
      { name: 'primary_button_url', label: 'Primary button URL', type: 'text' },
      { name: 'secondary_button_label', label: 'Secondary button label', type: 'text' },
      { name: 'secondary_button_url', label: 'Secondary button URL', type: 'text' },
      { name: 'animation', label: 'Animation', type: 'text', hint: 'Optional hint, e.g. fade / slide.' },
      ENABLED, ORDER,
    ],
  },

  banners: {
    key: 'banners', path: 'banners', title: 'Hero Banners', singular: 'Banner',
    api: websiteApi.banners, hasPublish: true,
    columns: [{ key: 'heading', header: 'Heading', render: (r) => r.heading }],
    fields: [
      { name: 'heading', label: 'Heading', type: 'text', required: true },
      { name: 'subheading', label: 'Subheading', type: 'text' },
      { name: 'image', label: 'Car image (1128×617)', type: 'media', ...BANNER },
      { name: 'cta_label', label: 'Button label', type: 'text' },
      { name: 'cta_url', label: 'Button URL', type: 'text' },
      ENABLED, ORDER,
    ],
  },

  'process-steps': {
    key: 'process-steps', path: 'process-steps', title: 'How It Works', singular: 'Step',
    api: websiteApi.processSteps, hasPublish: true,
    columns: [
      { key: 'step_no', header: 'No.', render: (r) => r.step_no || '-' },
      { key: 'title', header: 'Title', render: (r) => r.title },
    ],
    fields: [
      { name: 'step_no', label: 'Step number', type: 'text', hint: 'e.g. 01' },
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'icon', label: 'Icon', type: 'media', ...ICON },
      ENABLED, ORDER,
    ],
  },

  'why-choose-us': {
    key: 'why-choose-us', path: 'why-choose-us', title: 'Why Choose Us', singular: 'Point',
    api: websiteApi.whyChooseUs, hasPublish: true,
    columns: [{ key: 'title', header: 'Title', render: (r) => r.title }],
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'icon', label: 'Icon', type: 'media', ...ICON },
      ENABLED, ORDER,
    ],
  },

  stats: {
    key: 'stats', path: 'stats', title: 'Stats', singular: 'Stat',
    api: websiteApi.stats, hasPublish: true,
    columns: [
      { key: 'value', header: 'Value', render: (r) => r.value },
      { key: 'label', header: 'Label', render: (r) => r.label },
    ],
    fields: [
      { name: 'value', label: 'Value', type: 'text', required: true, hint: 'e.g. 1830+' },
      { name: 'label', label: 'Label', type: 'text', required: true },
      ENABLED, ORDER,
    ],
  },

  testimonials: {
    key: 'testimonials', path: 'testimonials', title: 'Testimonials', singular: 'Testimonial',
    api: websiteApi.testimonials, hasPublish: true,
    columns: [
      { key: 'author_name', header: 'Author', render: (r) => r.author_name },
      { key: 'rating', header: 'Rating', render: (r) => `${r.rating}/5` },
    ],
    fields: [
      { name: 'author_name', label: 'Author name', type: 'text', required: true },
      { name: 'author_role', label: 'Author role', type: 'text' },
      { name: 'author_photo', label: 'Author photo', type: 'media', ...SQUARE },
      { name: 'rating', label: 'Rating (1–5)', type: 'number', default: 5 },
      { name: 'quote', label: 'Quote', type: 'textarea', required: true },
      ENABLED, ORDER,
    ],
  },

  brands: {
    key: 'brands', path: 'brands', title: 'Trusted Brands', singular: 'Brand',
    api: websiteApi.brands, hasPublish: true,
    columns: [{ key: 'name', header: 'Name', render: (r) => r.name }],
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'logo', label: 'Logo', type: 'media', ...LOGO },
      { name: 'url', label: 'Website URL', type: 'text' },
      ENABLED, ORDER,
    ],
  },

  faqs: {
    key: 'faqs', path: 'faqs', title: 'FAQ', singular: 'FAQ',
    api: websiteApi.faqs, hasPublish: true,
    columns: [{ key: 'question', header: 'Question', render: (r) => r.question }],
    fields: [
      { name: 'question', label: 'Question', type: 'text', required: true },
      { name: 'answer', label: 'Answer', type: 'textarea', required: true },
      ENABLED, ORDER,
    ],
  },

  seo: {
    key: 'seo', path: 'seo', title: 'SEO Settings', singular: 'SEO entry',
    api: websiteApi.seo, hasPublish: false, modalSize: 'lg',
    columns: [
      { key: 'path', header: 'Path', render: (r) => r.path },
      { key: 'meta_title', header: 'Meta title', render: (r) => r.meta_title || '-' },
    ],
    fields: [
      { name: 'path', label: 'Page path', type: 'text', required: true, hint: 'e.g. "/" for the home page.' },
      { name: 'meta_title', label: 'Meta title', type: 'text' },
      { name: 'meta_description', label: 'Meta description', type: 'textarea' },
      { name: 'og_image', label: 'Social image (OG)', type: 'media', ...OG },
      { name: 'canonical_url', label: 'Canonical URL', type: 'text' },
      { name: 'robots', label: 'Robots', type: 'text', default: 'index,follow' },
    ],
  },
};
