import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutTemplate, GalleryHorizontal, ListOrdered, BadgeCheck,
  BarChart3, MessageSquareQuote, Building2, HelpCircle, PanelBottom, Search, Images, ExternalLink,
} from 'lucide-react';

import { PageHeader } from '../../components/PageHeader.jsx';
import { organizationApi } from '../../services/settingsService.js';

const LINKS = [
  { to: '/website/sections', label: 'Home Sections', desc: 'Headings & copy per section', icon: LayoutTemplate },
  { to: '/website/banners', label: 'Hero Banners', desc: 'Rotating hero slides', icon: GalleryHorizontal },
  { to: '/website/process-steps', label: 'How It Works', desc: 'Process steps', icon: ListOrdered },
  { to: '/website/why-choose-us', label: 'Why Choose Us', desc: 'Selling points', icon: BadgeCheck },
  { to: '/website/stats', label: 'Stats', desc: 'Headline figures', icon: BarChart3 },
  { to: '/website/testimonials', label: 'Testimonials', desc: 'Customer reviews', icon: MessageSquareQuote },
  { to: '/website/brands', label: 'Trusted Brands', desc: 'Partner logos', icon: Building2 },
  { to: '/website/faqs', label: 'FAQ', desc: 'Common questions', icon: HelpCircle },
  { to: '/website/footer', label: 'Footer', desc: 'Footer links & newsletter', icon: PanelBottom },
  { to: '/website/seo', label: 'SEO Settings', desc: 'Meta titles & descriptions', icon: Search },
  { to: '/website/media', label: 'Media Library', desc: 'Images, icons & logos', icon: Images },
];

export default function WebsiteDashboard() {
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
        title="Website"
        subtitle="Manage the public customer website content."
        actions={url ? (
          <a className="btn btn-primary" href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} /> Preview Website
          </a>
        ) : (
          <button className="btn btn-secondary" disabled
            title="Set the customer website URL in Organization Info → Website.">
            <ExternalLink size={15} /> Preview Website
          </button>
        )}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
        {LINKS.map(({ to, label, desc, icon: Icon }) => (
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
