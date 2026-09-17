import { useEffect, useMemo, useState } from 'react';
import { Monitor, Smartphone, Tablet, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { MediaPicker } from '../../components/MediaPicker.jsx';
import { useFilterOptions, asOptions } from '../../hooks/useFilterOptions.js';
import {
  websiteApi, campaignTypes, campaignFrequencies, campaignPlacements,
  campaignAudiences, campaignPriorities,
} from '../../services/websiteService.js';
import { promoCodesApi } from '../../services/promotionsService.js';
import { scheduleExceptionsApi } from '../../services/scheduleService.js';
import { apiErrorMessage } from '../../utils/apiError.js';
import { CampaignPreview } from './CampaignPreview.jsx';
import './campaigns.css';

/**
 * Create or edit a campaign, with the card beside the form.
 *
 * The preview is the point of this screen. Marketing artwork is judged by
 * looking at it, and a campaign that is only checked after it is live has
 * already been seen by customers. The preview renders the same card the website
 * does, at each device width and in both themes, from the draft in the form
 * rather than from anything saved.
 *
 * Linked promo codes and special dates are references. Picking a holiday offers
 * to borrow its dates; it never alters the holiday, and picking a promo code
 * never changes what that code is worth.
 */

const BLANK = {
  name: '',
  campaign_type: 'offer',
  title: '',
  subtitle: '',
  description: '',
  image: null,
  mobile_image: null,
  alt_text: '',
  cta_label: '',
  cta_url: '',
  secondary_cta_label: '',
  secondary_cta_url: '',
  starts_at: '',
  ends_at: '',
  frequency: 'session',
  placement: 'home',
  audience: 'everyone',
  priority: 20,
  dismissible: true,
  clubs: [],
  promo_code: null,
  schedule_exception: null,
  internal_notes: '',
  is_enabled: true,
  display_order: 0,
};

/** The artwork presets: a wide card, and a portrait one for phones. */
const WIDE = { aspect: 16 / 10, output: { width: 1280, height: 800, type: 'image/jpeg', quality: 0.9 } };
const TALL = { aspect: 3 / 4, output: { width: 900, height: 1200, type: 'image/jpeg', quality: 0.9 } };

/** `2027-03-01T00:00:00Z` -> `2027-03-01T00:00`, what a datetime-local wants. */
const toLocalInput = (value) => (value ? String(value).slice(0, 16) : '');

const DEVICES = [
  { key: 'desktop', Icon: Monitor },
  { key: 'tablet', Icon: Tablet },
  { key: 'mobile', Icon: Smartphone },
];

export function CampaignFormModal({ open, record, onClose, onSaved }) {
  const { t } = useTranslation('website');
  const { t: tc } = useTranslation('common');
  const [form, setForm] = useState(BLANK);
  const [media, setMedia] = useState({ image: null, mobile_image: null });
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState('desktop');
  const [dark, setDark] = useState(false);

  const editing = Boolean(record?.id);

  useEffect(() => {
    if (!open) return;
    const source = record?.id ? record : {};
    setForm({
      ...BLANK,
      ...source,
      starts_at: toLocalInput(source.starts_at),
      ends_at: toLocalInput(source.ends_at),
      clubs: source.clubs || [],
    });
    setMedia({
      image: source.image_detail || null,
      mobile_image: source.mobile_image_detail || null,
    });
  }, [open, record]);

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  // The shared hook already caches the club list for every filter in the app.
  const { clubs } = useFilterOptions();
  const clubOptions = useMemo(() => asOptions(clubs), [clubs]);
  const [promos, setPromos] = useState([]);
  const [holidays, setHolidays] = useState([]);

  useEffect(() => {
    if (!open) return;
    promoCodesApi.list({ page_size: 200, is_active: 'true' })
      .then((d) => setPromos(d.results || d)).catch(() => setPromos([]));
    scheduleExceptionsApi.list({ page_size: 200 })
      .then((d) => setHolidays(d.results || d)).catch(() => setHolidays([]));
  }, [open]);

  const promoOptions = useMemo(
    () => promos.map((p) => ({ value: p.id, label: p.code })), [promos]);
  const holidayOptions = useMemo(
    () => holidays.map((h) => ({ value: h.id, label: `${h.name} (${h.start_date})` })), [holidays]);

  /**
   * Borrow a holiday's dates when one is chosen and no dates are set yet.
   * Prefilling only, and never the other way round: the schedule is not this
   * screen's to change.
   */
  function pickHoliday(id) {
    const holiday = holidays.find((h) => h.id === id);
    set({
      schedule_exception: id || null,
      ...(holiday && !form.starts_at ? {
        starts_at: `${holiday.start_date}T00:00`,
        ends_at: `${holiday.end_date || holiday.start_date}T23:59`,
      } : {}),
    });
  }

  async function save() {
    if (!form.name.trim()) { toast.error(t('campaigns.nameRequired')); return; }
    if (!form.starts_at || !form.ends_at) { toast.error(t('campaigns.datesRequired')); return; }

    const payload = {
      ...form,
      name: form.name.trim(),
      priority: Number(form.priority) || 20,
      clubs: form.clubs || [],
      // A datetime-local carries no zone; sending it as written lets the server
      // read it in the organization's timezone, which is the one that counts.
      starts_at: form.starts_at,
      ends_at: form.ends_at,
    };
    delete payload.image_detail;
    delete payload.mobile_image_detail;

    setBusy(true);
    try {
      if (editing) await websiteApi.campaigns.update(record.id, payload);
      else await websiteApi.campaigns.create(payload);
      toast.success(editing ? t('campaigns.updated') : t('campaigns.created'));
      onSaved();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('campaigns.saveFailed')));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      size="xl"
      title={editing ? t('campaigns.editCampaign') : t('campaigns.newCampaign')}
      footer={(
        <>
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>
            {tc('actions.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? tc('state.saving') : tc('actions.save')}
          </button>
        </>
      )}
    >
      <div className="cmpf">
        <div className="cmpf__form">
          <FormField label={`${t('campaigns.name')} *`} hint={t('campaigns.nameHint')}>
            <input className="form-input" value={form.name}
              onChange={(e) => set({ name: e.target.value })} />
          </FormField>

          <div className="form-grid form-grid--2">
            <FormField label={t('campaigns.type')}>
              <Select2 options={campaignTypes(t)} value={form.campaign_type}
                onChange={(v) => set({ campaign_type: v })} />
            </FormField>
            <FormField label={t('campaigns.priority.label')}
              hint={t('campaigns.priorityHint')}>
              <Select2 options={campaignPriorities(t)} value={form.priority}
                onChange={(v) => set({ priority: v })} />
            </FormField>
          </div>

          <div className="form-grid form-grid--2">
            <FormField label={`${t('campaigns.starts')} *`}>
              <input className="form-input" type="datetime-local" value={form.starts_at}
                onChange={(e) => set({ starts_at: e.target.value })} />
            </FormField>
            <FormField label={`${t('campaigns.ends')} *`} hint={t('campaigns.timezoneHint')}>
              <input className="form-input" type="datetime-local" value={form.ends_at}
                min={form.starts_at || undefined}
                onChange={(e) => set({ ends_at: e.target.value })} />
            </FormField>
          </div>

          <div className="modal-section">{t('campaigns.content')}</div>

          <FormField label={t('campaigns.headline')}>
            <input className="form-input" value={form.title}
              onChange={(e) => set({ title: e.target.value })} />
          </FormField>
          <FormField label={t('campaigns.subheadline')}>
            <input className="form-input" value={form.subtitle}
              onChange={(e) => set({ subtitle: e.target.value })} />
          </FormField>
          <FormField label={t('campaigns.body')}>
            <textarea className="form-textarea" rows={3} value={form.description}
              onChange={(e) => set({ description: e.target.value })} />
          </FormField>

          <MediaPicker
            label={t('campaigns.artwork')}
            hint={t('campaigns.artworkHint')}
            value={form.image} detail={media.image} {...WIDE}
            onChange={(id, detail) => { set({ image: id }); setMedia((m) => ({ ...m, image: detail })); }}
          />
          <MediaPicker
            label={t('campaigns.mobileArtwork')}
            hint={t('campaigns.mobileArtworkHint')}
            value={form.mobile_image} detail={media.mobile_image} {...TALL}
            onChange={(id, detail) => {
              set({ mobile_image: id });
              setMedia((m) => ({ ...m, mobile_image: detail }));
            }}
          />
          <FormField label={t('campaigns.altText')} hint={t('campaigns.altTextHint')}>
            <input className="form-input" value={form.alt_text}
              onChange={(e) => set({ alt_text: e.target.value })} />
          </FormField>

          <div className="modal-section">{t('campaigns.buttons')}</div>
          <div className="form-grid form-grid--2">
            <FormField label={t('campaigns.ctaLabel')}>
              <input className="form-input" value={form.cta_label}
                onChange={(e) => set({ cta_label: e.target.value })} />
            </FormField>
            <FormField label={t('campaigns.ctaUrl')} hint={t('campaigns.ctaUrlHint')}>
              <input className="form-input" value={form.cta_url}
                onChange={(e) => set({ cta_url: e.target.value })} />
            </FormField>
          </div>
          <div className="form-grid form-grid--2">
            <FormField label={t('campaigns.secondaryLabel')}>
              <input className="form-input" value={form.secondary_cta_label}
                onChange={(e) => set({ secondary_cta_label: e.target.value })} />
            </FormField>
            <FormField label={t('campaigns.secondaryUrl')}>
              <input className="form-input" value={form.secondary_cta_url}
                onChange={(e) => set({ secondary_cta_url: e.target.value })} />
            </FormField>
          </div>

          <div className="modal-section">{t('campaigns.whereAndWhen')}</div>
          <div className="form-grid form-grid--2">
            <FormField label={t('campaigns.placement.label')}>
              <Select2 options={campaignPlacements(t)} value={form.placement}
                onChange={(v) => set({ placement: v })} />
            </FormField>
            <FormField label={t('campaigns.frequency.label')}
              hint={t('campaigns.frequencyHint')}>
              <Select2 options={campaignFrequencies(t)} value={form.frequency}
                onChange={(v) => set({ frequency: v })} />
            </FormField>
          </div>
          <div className="form-grid form-grid--2">
            <FormField label={t('campaigns.audience.label')}>
              <Select2 options={campaignAudiences(t)} value={form.audience}
                onChange={(v) => set({ audience: v })} />
            </FormField>
            <FormField label={t('campaigns.scope')} hint={t('campaigns.scopeHint')}>
              <Select2 options={clubOptions} value={form.clubs} multiple
                onChange={(v) => set({ clubs: v })}
                placeholder={t('campaigns.wholeWebsite')} clearable />
            </FormField>
          </div>

          <div className="modal-section">{t('campaigns.linked')}</div>
          <div className="form-grid form-grid--2">
            <FormField label={t('campaigns.promoCode')} hint={t('campaigns.promoHint')}>
              <Select2 options={promoOptions} value={form.promo_code}
                onChange={(v) => set({ promo_code: v || null })}
                placeholder={tc('state.none')} clearable />
            </FormField>
            <FormField label={t('campaigns.holiday')} hint={t('campaigns.holidayHint')}>
              <Select2 options={holidayOptions} value={form.schedule_exception}
                onChange={pickHoliday} placeholder={tc('state.none')} clearable />
            </FormField>
          </div>

          <Toggle label={t('campaigns.dismissible')} description={t('campaigns.dismissibleHint')}
            checked={form.dismissible}
            onChange={(e) => set({ dismissible: e.target.checked })} />
          <Toggle label={tc('state.enabled')} description={t('campaigns.enabledHint')}
            checked={form.is_enabled}
            onChange={(e) => set({ is_enabled: e.target.checked })} />

          <FormField label={t('campaigns.internalNotes')} hint={t('campaigns.internalNotesHint')}>
            <textarea className="form-textarea" rows={2} value={form.internal_notes}
              onChange={(e) => set({ internal_notes: e.target.value })} />
          </FormField>
        </div>

        <div className="cmpf__preview">
          <div className="cmpf__preview-bar">
            <span className="cmpf__preview-title">{t('campaigns.preview')}</span>
            <div className="cmpf__devices" role="group" aria-label={t('campaigns.preview')}>
              {DEVICES.map(({ key, Icon }) => (
                <button key={key} type="button" aria-pressed={device === key}
                  className={device === key ? 'is-on' : ''}
                  title={t(`campaigns.device.${key}`)}
                  aria-label={t(`campaigns.device.${key}`)}
                  onClick={() => setDevice(key)}>
                  <Icon size={14} />
                </button>
              ))}
              <button type="button" aria-pressed={dark} className={dark ? 'is-on' : ''}
                title={t(dark ? 'campaigns.lightMode' : 'campaigns.darkMode')}
                aria-label={t(dark ? 'campaigns.lightMode' : 'campaigns.darkMode')}
                onClick={() => setDark((v) => !v)}>
                {dark ? <Sun size={14} /> : <Moon size={14} />}
              </button>
            </div>
          </div>

          <CampaignPreview
            campaign={form}
            image={media.image}
            mobileImage={media.mobile_image}
            promoLabel={promos.find((p) => p.id === form.promo_code)?.code || ''}
            device={device}
            dark={dark}
          />

          <p className="cmpf__note">{t('campaigns.previewNote')}</p>
        </div>
      </div>
    </Modal>
  );
}
