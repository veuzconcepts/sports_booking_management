import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutTemplate, GalleryHorizontal, ListOrdered, BadgeCheck,
  BarChart3, MessageSquareQuote, Building2, HelpCircle, PanelBottom, Search, Images, ExternalLink,
} from 'lucide-react';

import { PageHeader } from '../../components/PageHeader.jsx';
import { organizationApi } from '../../services/settingsService.js';

const links = (t) => [
  { to: '/website/sections', label: t('homeSections'), desc: 'Headings & copy per section', icon: LayoutTemplate },
  { to: '/website/banners', label: t('heroBanners'), desc: 'Rotating hero slides', icon: GalleryHorizontal },
  { to: '/website/process-steps', label: t('howItWorks'), desc: 'Process steps', icon: ListOrdered },
  { to: '/website/why-choose-us', label: t('whyChooseUs'), desc: 'Selling points', icon: BadgeCheck },
  { to: '/website/stats', label: t('stats'), desc: 'Headline figures', icon: BarChart3 },
  { to: '/website/testimonials', label: t('testimonials'), desc: 'Customer reviews', icon: MessageSquareQuote },
  { to: '/website/brands', label: t('trustedBrands'), desc: 'Partner logos', icon: Building2 },
  { to: '/website/faqs', label: 'FAQ', desc: 'Common questions', icon: HelpCircle },
  { to: '/website/footer', label: t('footer'), desc: 'Footer links & newsletter', icon: PanelBottom },
  { to: '/website/seo', label: t('seoSettings'), desc: 'Meta titles & descriptions', icon: Search },
  { to: '/website/media', label: t('mediaLibrary'), desc: 'Images, icons & logos', icon: Images },
];

export default function WebsiteDashboard() {
  const { t } = useTranslation('website');
  // The customer club URL is sourced dynamically from the Organization profile
  // (Organization Info → Website), falling back to a build-time env var.
  const [siteUrl, setSiteUrl] = useState('');

  useEffect(() => {
    organizationApi.get()
      .then((o) => setSiteUrl(o?.website || ''))
      .catch(() => {});
  }, []);

  const url = siteUrl || import.meta.env.VITE_CUSTOMER_SITE_URL || '';

  return (
    <>
      <PageHeader
        title={t('website')}
        subtitle={t('managePublicCustomerWebsiteContent')}
        actions={url ? (
          <a className="btn btn-primary" href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} /> {t('previewWebsite')}
          </a>
        ) : (
          /* A dead button with a tooltip leaves somebody wondering what is
             broken. Nothing is: the address has simply never been set, so
             this goes to the one screen where it can be. */
          <Link className="btn btn-secondary" to="/organization">
            <ExternalLink size={15} /> {t('setWebsiteUrl')}
          </Link>
        )}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
        {links(t).map(({ to, label, desc, icon: Icon }) => (
          <Link key={to} to={to} className="card" style={{
            padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start', textDecoration: 'none',
            color: 'inherit',
          }}>
            <span style={{
              width: 38, height: 38, borderRadius: 10, flexShrink: 0,
              background: 'var(--color-primary-50, #f5f1fa)', color: 'var(--color-primary-600)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><Icon size={19} /></span>
            <span>
              <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{label}</span>
              <span className="muted" style={{ fontSize: 12.5 }}>{desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}
