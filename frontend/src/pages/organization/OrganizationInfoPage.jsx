import { useEffect, useRef, useState } from 'react';
import {
  Facebook, Instagram, Twitter, Linkedin, Youtube, Music2, MessageCircle,
  Search, ExternalLink, MapPin, Info, Plus, X, ChevronDown, ChevronUp,
  Building2, Clock, Coins, FileText, Share2, Image as ImageIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../components/PageHeader.jsx';
import { FormField } from '../../components/FormField.jsx';
import { ImageUploader } from '../../components/ImageUploader.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { ScheduleEditor, WeeklyTimeline } from '../../components/ScheduleEditor.jsx';
import { useTimeFormat } from '../../services/timeformat.jsx';
import { PhoneField, isPhoneValid } from '../../components/PhoneField.jsx';
import { countryOptions } from '../../utils/countries.js';
import { useCurrency, CurrencySymbol } from '../../services/currency.jsx';
import { organizationApi, currencyApi } from '../../services/settingsService.js';
import ClubsAndFacilities from '../settings/ClubsAndFacilities.jsx';
import { RichTextEditor } from '../../components/RichTextEditor.jsx';
import { useTabParam } from '../../hooks/useTabParam.js';
import { ThemeSettings } from '../../theme/ThemeSettings.jsx';
import { apiErrorMessage } from '../../utils/apiError.js';

const orgTabBtn = (active) => ({
  padding: '8px 14px', border: 'none', background: 'transparent',
  borderBottom: active ? '2px solid var(--color-primary-600)' : '2px solid transparent',
  color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
  fontWeight: 600, fontSize: 13.5, cursor: 'pointer',
});

// Timezone options formatted like "(UTC +03:00) Asia/Riyadh", sorted by offset.
const TZ_OPTIONS = (() => {
  const zones = (typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : ['Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'UTC', 'Europe/London', 'America/New_York']);
  const now = new Date();
  const gmt = (tz) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    } catch { return 'GMT'; }
  };
  const minutes = (g) => {
    const m = g.match(/GMT([+-])(\d{2}):(\d{2})/);
    return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
  };
  return zones
    .map((tz) => {
      const g = gmt(tz);
      const utc = g === 'GMT' ? 'UTC +00:00' : g.replace('GMT', 'UTC ');
      return { value: tz, label: `(${utc}) ${tz}`, _m: minutes(g) };
    })
    .sort((a, b) => a._m - b._m || a.value.localeCompare(b.value));
})();

// Each platform: brand icon + brand colour for the icon badge. First SOCIAL_VISIBLE
// show by default; the rest expand under "View More".
const socials = (t) => [
  { key: 'twitter', label: 'X', icon: Twitter, color: '#000000', ph: 'https://www.x.com/xyz' },
  { key: 'facebook', label: t('facebook'), icon: Facebook, color: '#1877F2', ph: 'https://facebook.com/…' },
  { key: 'linkedin', label: t('linkedin'), icon: Linkedin, color: '#0A66C2', ph: 'https://linkedin.com/company/…' },
  { key: 'youtube', label: t('youtube'), icon: Youtube, color: '#FF0000', ph: 'https://youtube.com/@…' },
  { key: 'instagram', label: t('instagram'), icon: Instagram,
    color: 'radial-gradient(circle at 30% 110%, #fdf497 0%, #fd5949 45%, #d6249f 60%, #285AEB 90%)',
    ph: 'https://instagram.com/…' },
  { key: 'tiktok', label: t('tiktok'), icon: Music2, color: '#111111', ph: 'https://tiktok.com/@…' },
  { key: 'whatsapp', label: t('whatsapp'), icon: MessageCircle, color: '#25D366', ph: '+971 50 000 0000' },
];
const SOCIAL_VISIBLE = 5;
const LINK_BTN = { border: 'none', background: 'none', color: 'var(--color-primary-600)', cursor: 'pointer', fontWeight: 600, fontSize: 13 };

const DEFAULT_HOURS = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    .map((d) => [d, { closed: false, shifts: [{ open: '08:00', close: '20:00' }] }]),
);

const EMPTY = {
  name: '', legal_name: '', trn: '', website: '', email: '', phone: '',
  address: '', city: '', country: '', timezone: 'Asia/Dubai', time_format_24h: false,
  require_refund_approval: true,
  allow_multiple_memberships: false,
  slot_minutes: 60, booking_hours: DEFAULT_HOURS,
  buffer_before_minutes: 0, buffer_after_minutes: 0,
  summary: '', description: '',
  facebook: '', instagram: '', twitter: '', linkedin: '', youtube: '', tiktok: '', whatsapp: '',
  meta_title: '', meta_description: '',
  logo_light: null, logo_dark: null, logo_light_vertical: null,
  logo_dark_vertical: null, favicon: null, og_image: null,
};

// Branding image fields - not part of the JSON profile save (uploaded separately).
const BRANDING_IMG_KEYS = [
  'logo_light', 'logo_dark', 'logo_light_vertical', 'logo_dark_vertical',
  'favicon', 'og_image',
];

const hydrate = (d) => ({ ...EMPTY, ...d });

const SUMMARY_MAX = 140;
const DESCRIPTION_MAX = 10000;
const plainLen = (html) => (html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim().length;

// In-page section navigator (left rail) for the Organization Info tab.
const orgSections = (t) => [
  { id: 'org-profile', label: t('profile'), icon: Building2 },
  { id: 'org-branding', label: t('branding'), icon: ImageIcon },
  { id: 'org-location', label: t('locationTimeZone'), icon: MapPin },
  { id: 'org-hours', label: t('businessHours'), icon: Clock },
  { id: 'org-currency', label: t('common:labels.currency'), icon: Coins },
  { id: 'org-other', label: t('otherDetails'), icon: FileText },
  { id: 'org-social', label: t('socialMedia'), icon: Share2 },
];

function SectionNav() {
  const { t } = useTranslation('organization');
  const [active, setActive] = useState(orgSections(t)[0].id);
  useEffect(() => {
    const els = orgSections(t).map((s) => document.getElementById(s.id)).filter(Boolean);
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(e.target.id); });
    }, { rootMargin: '-15% 0px -75% 0px', threshold: 0 });
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);
  const go = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    // Scroll the section just below the fixed top bar + the sticky page header,
    // so the page title/tabs stay visible (only the section area moves).
    const sticky = document.querySelector('.org-stickytop');
    const offset = 64 + (sticky ? sticky.offsetHeight : 0) + 14;
    const top = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    el.classList.remove('section-flash'); void el.offsetWidth; el.classList.add('section-flash');
  };
  return (
    <nav className="org-nav">
      {orgSections(t).map((s) => {
        const Icon = s.icon;
        return (
          <button key={s.id} type="button" onClick={() => go(s.id)}
            className={`org-nav__item${active === s.id ? ' is-active' : ''}`}>
            <Icon size={16} /><span>{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
}


// Sample time (17:00) formatted for the chosen 12h/24h mode.
function sampleTime(is24) {
  const d = new Date();
  d.setHours(17, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !is24 });
}

// Branding & SEO: upload the logo variants (per theme + layout), favicon, default
// social image, and the SEO fallback title/description. Logos use "contain" so the
// whole mark is kept (transparent padding, no clipping). Saved via multipart.
const logoSlots = (t) => [
  { key: 'logo_light', label: t('logoLightModeHorizontal'),
    hint: '', aspect: 3.2,
    output: { width: 960, height: 300, type: 'image/png' }, fit: 'contain' },
  { key: 'logo_dark', label: t('logoDarkModeHorizontal'),
    hint: '', aspect: 3.2,
    output: { width: 960, height: 300, type: 'image/png' }, fit: 'contain' },
  { key: 'logo_light_vertical', label: t('logoLightModeVertical'),
    hint: '', aspect: 0.8,
    output: { width: 360, height: 450, type: 'image/png' }, fit: 'contain' },
  { key: 'logo_dark_vertical', label: t('logoDarkModeVertical'),
    hint: '', aspect: 0.8,
    output: { width: 360, height: 450, type: 'image/png' }, fit: 'contain' },
  { key: 'favicon', label: t('favicon'),
    hint: t('browserTabIconSquareKeep'), aspect: 1,
    output: { width: 128, height: 128, type: 'image/png' }, fit: 'contain' },
  { key: 'og_image', label: t('defaultSocialImageOpenGraph'),
    hint: '', aspect: 1.91,
    output: { width: 1200, height: 630, type: 'image/jpeg', quality: 0.9 }, fit: 'cover' },
];

// Controlled branding section - image picks live in the parent's `files` state and
// the SEO fallbacks in the parent's `form`, so the page's main "Save changes"
// button persists everything in one go (no separate save button here).
function BrandingCard({ org, files, setFiles, form, set }) {
  const { t } = useTranslation('organization');
  return (
    <div className="card org-anchor" id="org-branding">
      <div className="card-header">
        <div>
          <h3 className="card-title">{t('branding')}</h3>
          <p className="card-subtitle">{t('logosFaviconSearchSocialDefaults')}</p>
        </div>
      </div>
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {logoSlots(t).map((s) => (
          <ImageUploader
            key={s.key}
            label={s.label}
            hint={s.hint}
            aspect={s.aspect}
            output={s.output}
            fit={s.fit}
            stack
            noCrop={!!s.noCrop}
            currentUrl={typeof org[s.key] === 'string' ? org[s.key] : null}
            file={files[s.key] instanceof File ? files[s.key] : null}
            onChange={(f) => setFiles((prev) => ({ ...prev, [s.key]: f }))}
          />
        ))}
        <FormField label={t('seoTitleFallback')} hint={t('usedWhenPageHasNo')}>
          <input className="form-input" value={form.meta_title || ''} onChange={set('meta_title')}
            placeholder={t('clubBookingCourtsPitchesHalls')} />
        </FormField>
        <FormField label={t('seoDescriptionFallback')} hint={t('usedWhenPageHasNo2')}>
          <textarea className="form-textarea" rows={3} value={form.meta_description || ''} onChange={set('meta_description')}
            placeholder={t('bookCourtsPitchesHallsYour')} />
        </FormField>
      </div>
    </div>
  );
}

export default function OrganizationInfoPage() {
  const { t } = useTranslation('organization');
  const [tab, setTab] = useTabParam('info');
  const [form, setForm] = useState(EMPTY);
  // The timeline is a read-only preview of the week, hidden until asked for so
  // the configuration view stays the short one.
  const [timeline, setTimeline] = useState(false);
  const { format24 } = useTimeFormat();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Branding image picks: key -> File (new) | null (cleared); absent = unchanged.
  const [brandingFiles, setBrandingFiles] = useState({});
  // Social media inline editing (one row at a time) + View More expander.
  const [editingKey, setEditingKey] = useState(null);
  const [draft, setDraft] = useState('');
  const [showAllSocials, setShowAllSocials] = useState(false);

  useEffect(() => {
    organizationApi.get()
      .then((d) => setForm(hydrate(d)))
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadOrganizationInfoPlease'))))
      .finally(() => setLoading(false));
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  const startEditSocial = (key) => { setEditingKey(key); setDraft(form[key] || ''); };
  const cancelEditSocial = () => { setEditingKey(null); setDraft(''); };
  async function saveSocial(key) {
    const v = draft.trim();
    if (!v) return;                       // nothing to save for an empty field
    setForm((f) => ({ ...f, [key]: v }));
    try { await organizationApi.update({ [key]: v }); toast.success(t('linkSaved')); }
    catch (e) { toast.error(apiErrorMessage(e, t('unableSaveLinkPleaseTry'))); }
    setEditingKey(null); setDraft('');
  }
  async function removeSocial(key) {
    setForm((f) => ({ ...f, [key]: '' }));
    try { await organizationApi.update({ [key]: '' }); toast.success(t('linkRemoved')); }
    catch (e) { toast.error(apiErrorMessage(e, t('unableRemoveLinkPleaseTry'))); }
  }

  async function save() {
    if (form.phone && !isPhoneValid(form.phone)) {
      toast.error(t('enterValidPhoneNumberSelected'));
      return;
    }
    setSaving(true);
    try {
      // 1) Profile + SEO text fields as JSON (image URL fields stripped - they're
      //    read-only strings here and would fail ImageField validation).
      const jsonPayload = { ...form };
      BRANDING_IMG_KEYS.forEach((k) => delete jsonPayload[k]);
      let d = await organizationApi.update(jsonPayload);
      // 2) Any new/cleared branding images as one multipart request.
      const picks = Object.entries(brandingFiles);
      if (picks.length) {
        const fd = new FormData();
        for (const [key, val] of picks) {
          fd.append(key, val instanceof File ? val : '');   // '' clears it
        }
        d = await organizationApi.updateForm(fd);
        setBrandingFiles({});
      }
      setForm(hydrate(d));
      toast.success(t('organizationInfoSaved'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableSaveOrganizationInfoPlease')));
    } finally { setSaving(false); }
  }

  return (
    <>
      <div className="org-stickytop">
        <PageHeader
          title={t('organizationInfo')}
          subtitle={t('companyProfileClubsFacilitiesCurrency')}
          actions={tab === 'info' && !loading
            ? <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? t('common:state.saving') : t('common:actions.saveChanges')}</button>
            : null}
        />

        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', marginBottom: 18 }}>
          <button style={orgTabBtn(tab === 'info')} onClick={() => setTab('info')}>{t('organizationInfo')}</button>
          <button style={orgTabBtn(tab === 'theme')} onClick={() => setTab('theme')}>{t('theme.tab')}</button>
          <button style={orgTabBtn(tab === 'clubs')} onClick={() => setTab('clubs')}>{t('clubsAndFacilities')}</button>
        </div>
      </div>

      {tab === 'clubs' ? <ClubsAndFacilities /> : tab === 'theme' ? <ThemeSettings /> : loading ? (
        <div className="card"><div className="card-body center" style={{ padding: 56 }}><span className="muted">{t('common:state.loading')}</span></div></div>
      ) : (
      <div className="org-layout">
        <SectionNav />
        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        {/* Profile */}
        <div className="card org-anchor" id="org-profile">
          <div className="card-header"><h3 className="card-title">{t('profile')}</h3></div>
          <div className="card-body form-grid form-grid--2" style={{ gap: 14 }}>
            <FormField label={t('organizationName')}><input className="form-input" value={form.name} onChange={set('name')} placeholder={t('veuzConcepts')} /></FormField>
            <FormField label={t('legalName')}><input className="form-input" value={form.legal_name} onChange={set('legal_name')} placeholder={t('veuzConceptsLlc')} /></FormField>
            <FormField label={t('trnTaxRegistrationNumber')} hint={t('printedTaxInvoicesReceiptsCredit')}>
              <input className="form-input" value={form.trn} onChange={set('trn')} placeholder="100xxxxxxxxxxxx" />
            </FormField>
            <FormField label={t('website')}><input className="form-input" value={form.website} onChange={set('website')} placeholder="https://example.com" /></FormField>
            <FormField label={t('common:labels.email')}><input className="form-input" type="email" value={form.email} onChange={set('email')} placeholder={t('helloExampleCom')} /></FormField>
            <FormField label={t('common:labels.phone')} error={form.phone && !isPhoneValid(form.phone) ? 'Enter a valid phone number for the selected country' : undefined}>
              <PhoneField value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} invalid={!!form.phone && !isPhoneValid(form.phone)} />
            </FormField>
          </div>
        </div>

        {/* Branding */}
        <BrandingCard org={form} files={brandingFiles} setFiles={setBrandingFiles} form={form} set={set} />

        {/* Location & timezone */}
        <div className="card org-anchor" id="org-location">
          <div className="card-header"><h3 className="card-title">{t('locationTimeZone')}</h3></div>
          <div className="card-body" style={{ display: 'grid', gap: 16 }}>
            <FormField label={t('location')}>
              <LocationField value={form.address} onChange={(v) => setForm((f) => ({ ...f, address: v }))} />
            </FormField>
            <FormField label={t('country')}>
              <Select2 options={countryOptions()} value={form.country} onChange={set('country')}
                placeholder={t('selectCountry')} clearable />
            </FormField>
            <FormField label={t('timeZone')}>
              <Select2 options={TZ_OPTIONS} value={form.timezone} onChange={set('timezone')} />
            </FormField>
            <div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13.5 }}>
                <input
                  type="checkbox" checked={!!form.time_format_24h}
                  onChange={(e) => setForm((f) => ({ ...f, time_format_24h: e.target.checked }))}
                />
                24-Hour Format
                <Info size={14} style={{ color: 'var(--color-text-muted)' }}
                      title={t('displayTimes24HourFormat')} />
              </label>
              <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                {t('preview')} <strong>{sampleTime(form.time_format_24h)}</strong>
              </p>
            </div>
            <div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13.5 }}>
                <input
                  type="checkbox" checked={!!form.require_refund_approval}
                  onChange={(e) => setForm((f) => ({ ...f, require_refund_approval: e.target.checked }))}
                />
                {t('requireRefundApproval')}
                <Info size={14} style={{ color: 'var(--color-text-muted)' }}
                      title={t('whenRefundCreditNoteNeeds')} />
              </label>
              <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                {form.require_refund_approval
                  ? t('refundsSubmittedApprovalBeforeProcessing')
                  : t('refundsProcessedImmediatelyWithoutApproval')}
              </p>
            </div>
            <div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13.5 }}>
                <input
                  type="checkbox" checked={!!form.allow_multiple_memberships}
                  onChange={(e) => setForm((f) => ({ ...f, allow_multiple_memberships: e.target.checked }))}
                />
                {t('allowMultipleActiveMemberships')}
                <Info size={14} style={{ color: 'var(--color-text-muted)' }}
                      title={t('whenOffCustomerCanHold')} />
              </label>
              <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                {form.allow_multiple_memberships
                  ? t('customersMayHoldSeveralActive')
                  : t('oneActiveMembershipPerCustomer')}
              </p>
            </div>
          </div>
        </div>

        {/* Business hours - drives the booking time-slot engine */}
        <div className="card org-anchor" id="org-hours">
          <div className="card-header">
            <div>
              <h3 className="card-title">{t('businessHours')}</h3>
              <p className="card-subtitle">
                {t('defaultEveryClubFacilityFollows')}
              </p>
            </div>
            <button type="button" className="btn btn-secondary"
              onClick={() => setTimeline((v) => !v)}>
              {timeline ? t('hideTimeline') : t('weeklyTimeline')}
            </button>
          </div>
          <div className="card-body" style={{ display: 'grid', gap: 14 }}>
            <ScheduleEditor
              scope="organization"
              value={form.booking_hours}
              onChange={(v) => setForm((f) => ({ ...f, booking_hours: v }))}
              slotMinutes={form.slot_minutes ?? 60}
              onSlotMinutes={(v) => setForm((f) => ({ ...f, slot_minutes: v }))}
              bufferBefore={form.buffer_before_minutes ?? 0}
              bufferAfter={form.buffer_after_minutes ?? 0}
              onBuffers={(before, after) => setForm((f) => ({
                ...f, buffer_before_minutes: before, buffer_after_minutes: after }))}
            />
            {timeline && (
              <WeeklyTimeline week={form.booking_hours || {}} format24={format24} />
            )}
          </div>
        </div>

        {/* Default currency (moved from System Settings) */}
        <div className="org-anchor" id="org-currency"><CurrencyCard /></div>

        {/* Other details - summary + rich description */}
        <div className="card org-anchor" id="org-other">
          <div className="card-header"><h3 className="card-title">{t('otherDetails')}</h3></div>
          <div className="card-body" style={{ display: 'grid', gap: 18 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span className="form-label" style={{ fontWeight: 600, margin: 0 }}>{t('summary')}</span>
                <span className="muted" style={{ fontSize: 12 }}>{(form.summary || '').length} / {SUMMARY_MAX}</span>
              </div>
              <textarea
                className="form-input" rows={2} maxLength={SUMMARY_MAX}
                value={form.summary} onChange={set('summary')}
                placeholder={t('shortSummaryYourOrganization')} style={{ resize: 'vertical' }}
              />
              <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                {t('useRelevantKeywordsYourSummary')}
              </p>
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span className="form-label" style={{ fontWeight: 600, margin: 0 }}>{t('description')}</span>
                <span className="muted" style={{ fontSize: 12 }}>{plainLen(form.description)}/{DESCRIPTION_MAX}</span>
              </div>
              <RichTextEditor
                value={form.description}
                onChange={(html) => setForm((f) => ({ ...f, description: html }))}
                placeholder={t('describeYourOrganization')}
              />
            </div>
          </div>
        </div>

        {/* Social media - per-row inline "Link" (last) */}
        <div className="card org-anchor" id="org-social">
          <div className="card-header"><h3 className="card-title">{t('socialMedia')}</h3></div>
          <div className="card-body" style={{ padding: 0 }}>
            {(showAllSocials ? socials(t) : socials(t).slice(0, SOCIAL_VISIBLE)).map((s, i) => {
              const Icon = s.icon;
              const val = form[s.key];
              const isEditing = editingKey === s.key;
              return (
                <div key={s.key} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px',
                  borderTop: i ? '1px solid var(--color-border-soft, #eef0f4)' : 'none',
                }}>
                  <span style={{
                    width: 30, height: 30, borderRadius: '50%', background: s.color, color: '#fff',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}><Icon size={16} /></span>
                  <span style={{ fontWeight: 600, color: 'var(--color-primary-600)', flex: 1 }}>{s.label}</span>

                  {isEditing ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ display: 'inline-flex' }}>
                        <input
                          className="form-input" autoFocus value={draft} placeholder={s.ph}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (draft.trim()) saveSocial(s.key); } if (e.key === 'Escape') cancelEditSocial(); }}
                          style={{ flex: '1 1 200px', minWidth: 0, borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                        />
                        <button type="button" className="btn btn-primary" onClick={() => saveSocial(s.key)} disabled={!draft.trim()}
                          style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}>{t('common:actions.save')}</button>
                      </span>
                      <button type="button" className="icon-btn" title={t('common:actions.cancel')} onClick={cancelEditSocial}
                        style={{ borderRadius: '50%', border: '1px solid var(--color-border)' }}><X size={15} /></button>
                    </span>
                  ) : val ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
                      <a href={val} target="_blank" rel="noreferrer" className="muted"
                         style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{val}</a>
                      <button type="button" onClick={() => startEditSocial(s.key)} style={LINK_BTN}>{t('common:actions.edit')}</button>
                      <button type="button" onClick={() => removeSocial(s.key)} style={{ ...LINK_BTN, color: '#dc2626' }}>{t('common:actions.remove')}</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => startEditSocial(s.key)}
                      style={{ ...LINK_BTN, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Plus size={15} /> {t('link')}
                    </button>
                  )}
                </div>
              );
            })}
            {socials(t).length > SOCIAL_VISIBLE && (
              <button type="button" onClick={() => setShowAllSocials((v) => !v)}
                style={{
                  width: '100%', padding: '11px', border: 'none', cursor: 'pointer',
                  borderTop: '1px solid var(--color-border-soft, #eef0f4)',
                  background: 'rgba(99,102,241,0.06)', color: 'var(--color-primary-600)', fontWeight: 600,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}>
                {showAllSocials ? <>{t('viewLess')} <ChevronUp size={16} /></> : <>{t('viewMore')} <ChevronDown size={16} /></>}
              </button>
            )}
          </div>
        </div>
        </div>
      </div>
      )}
    </>
  );
}


function LocationField({ value, onChange }) {
  const { t } = useTranslation('organization');
  const [editing, setEditing] = useState(!value);
  const [draft, setDraft] = useState(value || '');
  useEffect(() => { setDraft(value || ''); setEditing(!value); }, [value]);

  const q = encodeURIComponent(value || '');
  const embed = `https://www.google.com/maps?q=${q}&output=embed`;
  const openUrl = `https://www.google.com/maps/search/?api=1&query=${q}`;

  function apply() {
    const v = draft.trim();
    onChange(v);
    setEditing(!v);
  }

  if (editing || !value) {
    return (
      <div style={{ position: 'relative' }}>
        <input
          className="form-input" value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
          placeholder={t('searchAddressPlaceName')} style={{ paddingRight: 38 }}
        />
        <button
          type="button" onClick={apply} title={t('common:actions.search')} aria-label={t('searchLocation')}
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)' }}
        >
          <Search size={16} />
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
        <iframe
          title={t('locationMap')} src={embed}
          style={{ width: '100%', height: 300, border: 0, display: 'block' }}
          loading="lazy" referrerPolicy="no-referrer-when-downgrade"
        />
        <a
          href={openUrl} target="_blank" rel="noreferrer" className="btn btn-secondary"
          style={{ position: 'absolute', top: 10, left: 10, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {t('openMaps')} <ExternalLink size={14} />
        </a>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginTop: 10 }}>
        <span style={{ display: 'inline-flex', gap: 8, fontSize: 13.5 }}>
          <MapPin size={16} style={{ color: 'var(--color-primary-600)', flexShrink: 0, marginTop: 1 }} />
          {value}
        </span>
        <span style={{ display: 'inline-flex', gap: 12, fontSize: 13, whiteSpace: 'nowrap' }}>
          <button type="button" onClick={() => setEditing(true)} style={{ border: 'none', background: 'none', color: 'var(--color-primary-600)', cursor: 'pointer', fontWeight: 600 }}>{t('common:actions.edit')}</button>
          <button type="button" onClick={() => onChange('')} style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontWeight: 600 }}>{t('common:actions.remove')}</button>
        </span>
      </div>
    </div>
  );
}

function CurrencyCard() {
  const { t } = useTranslation('organization');
  const { reload: reloadCurrency } = useCurrency();
  const [choices, setChoices] = useState([]);
  const [currency, setCurrency] = useState('');
  const [initial, setInitial] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    currencyApi.get()
      .then((d) => {
        setChoices(d?.choices || []);
        setCurrency(d?.currency || '');
        setInitial(d?.currency || '');
      })
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadCurrencySettingsPlease'))));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const d = await currencyApi.update(currency);
      setInitial(d.currency);
      await reloadCurrency();
      toast.success(t('defaultCurrencyUpdated'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUpdateDefaultCurrencyPlease')));
    } finally { setSaving(false); }
  }

  const selected = (choices || []).find((c) => c.code === currency);

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">{t('defaultCurrency')}</h3>
          <p className="card-subtitle">{t('usedNewBookingsPaymentsWallets')}</p>
        </div>
      </div>
      <div className="card-body" style={{ maxWidth: 460 }}>
        <FormField label={t('common:labels.currency')} hint={t('appliesRecordsCreatedNowDecimal')}>
          <Select2
            options={choices.map((c) => ({
              value: c.code,
              label: c.symbol === c.code ? `${c.code} - ${c.label}` : `${c.code} - ${c.label} (${c.symbol})`,
            }))}
            value={currency} onChange={setCurrency}
          />
        </FormField>
        {selected && (() => {
          const dp = Number.isInteger(selected.decimals) ? selected.decimals : 2;
          const sample = (1250).toLocaleString(undefined, {
            minimumFractionDigits: dp, maximumFractionDigits: dp,
          });
          return (
            <p className="muted" style={{ fontSize: 13 }}>
              {t('sample')} <strong><CurrencySymbol code={selected.code} /> {sample}</strong>
              {' '}({selected.code} · {dp} decimal{dp === 1 ? '' : 's'})
            </p>
          );
        })()}
        <div style={{ marginTop: 14 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || currency === initial}>
            {saving ? t('common:state.saving') : t('saveCurrency')}
          </button>
        </div>
      </div>
    </div>
  );
}
