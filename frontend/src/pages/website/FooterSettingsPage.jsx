import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { footerApi } from '../../services/websiteService.js';
import { apiErrorMessage } from '../../utils/apiError.js';

const SectionTitle = ({ children }) => (
  <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{children}</h3>
);

export default function FooterSettingsPage() {
  const { t } = useTranslation('website');
  const { hasPerm } = useAuth();
  const canEdit = hasPerm('website.edit');
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    footerApi.get()
      .then(setCfg)
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadFooterSettings'))));
  }, []);

  if (!cfg) return <div className="muted" style={{ padding: 24 }}>Loading…</div>;

  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));

  async function save() {
    setBusy(true);
    try {
      const saved = await footerApi.update({
        about_text: cfg.about_text,
        link_columns: cfg.link_columns || [],
        newsletter_enabled: cfg.newsletter_enabled,
        newsletter_heading: cfg.newsletter_heading,
        copyright_text: cfg.copyright_text,
        bottom_links: cfg.bottom_links || [],
      });
      setCfg(saved);
      toast.success(t('footerSaved'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableSaveFooterPleaseTry')));
    } finally { setBusy(false); }
  }

  const columns = cfg.link_columns || [];
  const bottom = cfg.bottom_links || [];

  return (
    <>
      <PageHeader title={t('footer')} subtitle={t('footerContentCustomerWebsite')}
        actions={canEdit && (
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? t('common:state.saving') : t('common:actions.save')}</button>
        )}
      />

      <div className="card" style={{ padding: 18, maxWidth: 820 }}>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
          <FormField label={t('aboutText')}>
            <textarea className="form-textarea" rows={3} value={cfg.about_text || ''}
              onChange={(e) => set({ about_text: e.target.value })} />
          </FormField>

          <SectionTitle>{t('linkColumns')}</SectionTitle>
          {columns.map((col, ci) => (
            <div key={ci} style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <input className="form-input" placeholder={t('columnTitle')} value={col.title || ''}
                  onChange={(e) => {
                    const next = [...columns]; next[ci] = { ...col, title: e.target.value }; set({ link_columns: next });
                  }} />
                <button type="button" className="icon-btn" title={t('removeColumn')}
                  onClick={() => set({ link_columns: columns.filter((_, i) => i !== ci) })}><X size={15} /></button>
              </div>
              {(col.links || []).map((lnk, li) => (
                <div key={li} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <input className="form-input" placeholder={t('label')} value={lnk.label || ''}
                    onChange={(e) => {
                      const next = [...columns];
                      const links = [...(col.links || [])]; links[li] = { ...lnk, label: e.target.value };
                      next[ci] = { ...col, links }; set({ link_columns: next });
                    }} />
                  <input className="form-input" placeholder="URL" value={lnk.url || ''}
                    onChange={(e) => {
                      const next = [...columns];
                      const links = [...(col.links || [])]; links[li] = { ...lnk, url: e.target.value };
                      next[ci] = { ...col, links }; set({ link_columns: next });
                    }} />
                  <button type="button" className="icon-btn" title={t('removeLink')}
                    onClick={() => {
                      const next = [...columns];
                      next[ci] = { ...col, links: (col.links || []).filter((_, i) => i !== li) };
                      set({ link_columns: next });
                    }}><X size={15} /></button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary btn-sm"
                onClick={() => {
                  const next = [...columns];
                  next[ci] = { ...col, links: [...(col.links || []), { label: '', url: '' }] };
                  set({ link_columns: next });
                }}><Plus size={14} /> {t('addLink')}</button>
            </div>
          ))}
          <button type="button" className="btn btn-secondary btn-sm"
            onClick={() => set({ link_columns: [...columns, { title: '', links: [] }] })}>
            <Plus size={14} /> {t('addColumn')}
          </button>

          <SectionTitle>{t('newsletter')}</SectionTitle>
          <Toggle label={t('newsletterEnabled')} description={t('showEmailSignUpFooter')}
            checked={Boolean(cfg.newsletter_enabled)} onChange={(e) => set({ newsletter_enabled: e.target.checked })} />
          <FormField label={t('newsletterHeading')}>
            <input className="form-input" value={cfg.newsletter_heading || ''}
              onChange={(e) => set({ newsletter_heading: e.target.value })} />
          </FormField>

          <SectionTitle>{t('bottomBar')}</SectionTitle>
          <FormField label={t('copyrightText')}>
            <input className="form-input" value={cfg.copyright_text || ''}
              onChange={(e) => set({ copyright_text: e.target.value })} />
          </FormField>
          {bottom.map((lnk, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input className="form-input" placeholder={t('label')} value={lnk.label || ''}
                onChange={(e) => { const next = [...bottom]; next[i] = { ...lnk, label: e.target.value }; set({ bottom_links: next }); }} />
              <input className="form-input" placeholder="URL" value={lnk.url || ''}
                onChange={(e) => { const next = [...bottom]; next[i] = { ...lnk, url: e.target.value }; set({ bottom_links: next }); }} />
              <button type="button" className="icon-btn" title={t('common:actions.remove')}
                onClick={() => set({ bottom_links: bottom.filter((_, idx) => idx !== i) })}><X size={15} /></button>
            </div>
          ))}
          <button type="button" className="btn btn-secondary btn-sm"
            onClick={() => set({ bottom_links: [...bottom, { label: '', url: '' }] })}>
            <Plus size={14} /> {t('addBottomLink')}
          </button>
        </fieldset>
      </div>
    </>
  );
}
