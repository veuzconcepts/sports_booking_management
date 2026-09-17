import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Pencil, Video, Image as ImageIcon, Upload, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Controller, useForm } from 'react-hook-form';

import { PageTabs } from '../../components/PageTabs.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ListPage, ListView } from '../../components/listview/index.js';
import { Modal } from '../../components/Modal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { TimeInput } from '../../components/TimeInput.jsx';
import { FormField } from '../../components/FormField.jsx';
import { ImageUploader } from '../../components/ImageUploader.jsx';
import { RichTextEditor } from '../../components/RichTextEditor.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { useDefaultTaxPercent } from '../../hooks/useDefaultTaxPercent.js';
import { formatApiError, apiErrorMessage } from '../../utils/apiError.js';

import {
  adjustmentTypes,
  customerTypes,
  daysOfWeek,
  ruleTypes,
  facilityBadges,
  facilityKinds,
  addonsApi,
  pricingRulesApi,
  facilityTypesApi,
  facilityCategoriesApi,
} from '../../services/facilitiesService.js';
import { membershipPlansApi } from '../../services/subscriptionsService.js';
import { clubsApi } from '../../services/clubsService.js';
import { CURRENCY_OPTIONS, Money, CurrencySymbol } from '../../services/currency.jsx';
import { useTabParam } from '../../hooks/useTabParam.js';

// Pre-fill price/amount inputs without trailing-zero noise (e.g. "50.000000" ->
// "50", "10.120000" -> "10.12") while keeping genuine high precision ("10.123456").
function trimZeros(v) {
  const s = String(v ?? '');
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

const tabs = (t) => [
  { key: 'categories', label: t('categories2') },
  { key: 'types',      label: t('facilityTypes2') },
  { key: 'addons',   label: t('addOns') },
  { key: 'pricing',  label: t('pricingRules') },
];


const categoryGroups = (t) => [
  { key: 'kind', label: t('kind2') },
  { key: 'is_active', label: t('common:labels.status') },
];

const typeGroups = (t) => [
  { key: 'is_active', label: t('common:labels.status') },
  { key: 'online_booking_enabled', label: t('onlineBooking2') },
];

const addonGroups = (t) => [{ key: 'is_active', label: t('common:labels.status') }];

const ruleGroups = (t) => [
  { key: 'rule_type', label: t('ruleType3') },
  { key: 'is_active', label: t('common:labels.status') },
];

export default function FacilitiesPage() {
  const { t } = useTranslation('facilities');
  const [tab, setTab] = useTabParam('categories');

  return (
    <ListPage
      title={t('facilitiesCatalogue')}
      subtitle={t('facilityCategoriesBookableFacilityTypes')}
      tabs={(
        <PageTabs tabs={tabs(t)} active={tab} onChange={setTab}
          label={t('facilitiesCatalogue')} />
      )}
    >
      {tab === 'categories' && <FacilityCategoriesTab />}
      {tab === 'types'      && <FacilityTypesTab />}
      {tab === 'addons'   && <AddOnsTab />}
      {tab === 'pricing'  && <PricingRulesTab />}
    </ListPage>
  );
}

/* ----- Facility categories tab -------------------------------------------- */
function FacilityCategoriesTab() {
  const { t } = useTranslation('facilities');
  const { hasPerm } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const fetcher = useCallback((q) => facilityCategoriesApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  function openNew() { setEditItem(null); setModalOpen(true); }
  function openEdit(row) { setEditItem(row); setModalOpen(true); }

  const columns = useMemo(() => [
    {
      key: 'name', header: t('categories.columns.category'), sortKey: 'name', minWidth: 220,
      alwaysVisible: true,
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {r.icon && <img src={r.icon} alt="" style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'cover' }} />}
          <div>
            <div style={{ fontWeight: 600 }}>
              {r.name}
              {r.badge_status === 'show' && r.badge_label && (
                <StatusBadge tone="warning" label={r.badge_label} />
              )}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{r.slug}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'kind', header: t('categories.columns.kind'), sortKey: 'kind', minWidth: 130,
      render: (r) => <StatusBadge tone="info" label={(r.kind || '').replace('_', ' ')} />,
    },
    {
      key: 'price', header: t('categories.columns.basePrice'), sortKey: 'base_price', align: 'right',
      minWidth: 110, nowrap: true,
      render: (r) => <Money amount={r.base_price} />,
    },
    { key: 'featured', header: t('categories.columns.featured'), minWidth: 90, priority: 'low', render: (r) => (r.is_featured ? '★' : '-') },
    { key: 'order', header: t('categories.columns.order'), sortKey: 'display_order', align: 'right',
      minWidth: 80, priority: 'low', render: (r) => r.display_order },
    {
      key: 'status', header: t('categories.columns.status'), sortKey: 'is_active', minWidth: 110,
      render: (r) => (
        <StatusBadge
          tone={r.is_active ? 'success' : 'muted'}
          label={r.is_active ? t('common:state.active') : t('common:state.inactive')}
        />
      ),
    },
  ], [t]);

  const filters = useMemo(() => [
    { key: 'kind', label: t('categories.filters.kind'), type: 'select', options: facilityKinds(t) },
    { key: 'is_active', label: t('categories.filters.status'), type: 'boolean',
      trueLabel: t('common.active'), falseLabel: t('common.inactive') },
  ], [t]);

  return (
    <>
      <ListView
        tableKey="facility-categories"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="display_order"
        searchPlaceholder={t('categories.searchPlaceholder')}
        emptyTitle={t('categories.emptyTitle')}
        emptyHint={t('categories.emptyHint')}
        onRowClick={openEdit}
        columns={columns}
        filters={filters}
        groupOptions={categoryGroups(t)}
        toolbarRight={hasPerm('facilities.add') && (
          <button className="btn btn-primary" onClick={openNew}>
            <Plus size={15} /> {t('categories.add')}
          </button>
        )}
      />

      <FacilityCategoryFormModal
        open={modalOpen}
        category={editItem}
        onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); toast.success(t('categories.saved')); reload(); }}
        onDeleted={() => { setModalOpen(false); toast.success(t('categories.deleted')); reload(); }}
      />
    </>
  );
}

function SectionTitle({ children }) {
  return <div className="modal-section">{children}</div>;
}

const toSlug = (s) =>
  (s || '')
    .toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')   // drop punctuation
    .replace(/\s+/g, '-')        // spaces -> hyphens
    .replace(/-+/g, '-');        // collapse repeats

function FacilityCategoryFormModal({ open, category, onClose, onSaved, onDeleted }) {
  const { t } = useTranslation('facilities');
  const isEdit = Boolean(category);
  const { register, handleSubmit, reset, setValue, watch, control, formState: { errors, isSubmitting } } = useForm();

  // Slug auto-follows the name until the user edits the slug manually.
  const slugTouched = useRef(false);
  const nameField = register('name', {
    required: 'Name is required',
    validate: (v) => (v || '').trim().length >= 2 || 'Enter at least 2 characters',
    maxLength: { value: 120, message: 'Keep the name under 120 characters' },
  });
  const slugField = register('slug', {
    required: 'Slug is required',
    maxLength: { value: 140, message: 'Slug is too long' },
    pattern: { value: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: 'Use lowercase letters, numbers and single hyphens' },
  });

  const badgeShow = watch('badge_show');

  const [clubs, setSites] = useState([]);
  const [siteIds, setSiteIds] = useState(new Set());
  const [facilityTypeList, setFacilityTypeList] = useState([]);
  const [facilityTypeIds, setFacilityTypeIds] = useState([]);
  const [bannerFile, setBannerFile] = useState(null);
  const [iconFile, setIconFile] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      await facilityCategoriesApi.remove(category.id);
      setConfirmDelete(false);
      onDeleted?.();
    } catch (e) {
      setConfirmDelete(false);
      toast.error(
        apiErrorMessage(
          e,
          e.response?.status === 409
            ? t('categoryUseCannotDeleted')
            : t('unableDeleteCategoryPleaseTry'),
        ),
      );
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    clubsApi.list({ page_size: 100 }).then((d) => setSites(d.results || d)).catch(() => {});
    facilityTypesApi.list({ page_size: 200 }).then((d) => setFacilityTypeList(d.results || d)).catch(() => {});
    reset({
      name: category?.name || '',
      slug: category?.slug || '',
      description: category?.description || '',
      kind: category?.kind || 'outdoor_court',
      base_price: trimZeros(category?.base_price ?? 0),
      base_duration_minutes: category?.base_duration_minutes ?? 60,
      badge_label: category?.badge_label || '',
      badge_show: (category?.badge_status ?? 'hide') === 'show',
      display_order: category?.display_order ?? 0,
      is_active: category?.is_active ?? true,
      is_featured: category?.is_featured ?? false,
      meta_title: category?.meta_title || '',
      meta_description: category?.meta_description || '',
    });
    setSiteIds(new Set(category?.available_clubs || []));
    setFacilityTypeIds(category?.facility_types || []);
    setBannerFile(null);
    setIconFile(null);
    // Existing record with a slug -> treat as manual; new record -> auto-follow name.
    slugTouched.current = Boolean(category?.slug);
  }, [open, category, reset]);

  async function onSubmit(v) {
    const fd = new FormData();
    const slug = toSlug(v.slug || v.name);
    fd.append('name', v.name);
    fd.append('slug', slug);
    fd.append('description', v.description || '');
    fd.append('kind', v.kind);
    fd.append('base_price', String(Number(v.base_price) || 0));
    fd.append('base_duration_minutes', String(Number(v.base_duration_minutes) || 60));
    fd.append('badge_label', v.badge_label || '');
    fd.append('badge_status', v.badge_show ? 'show' : 'hide');
    fd.append('display_order', String(Number(v.display_order) || 0));
    fd.append('is_active', v.is_active ? 'true' : 'false');
    fd.append('is_featured', v.is_featured ? 'true' : 'false');
    fd.append('meta_title', v.meta_title || '');
    fd.append('meta_description', v.meta_description || '');
    siteIds.forEach((id) => fd.append('available_clubs', id));
    facilityTypeIds.forEach((id) => fd.append('facility_types', id));
    if (bannerFile) fd.append('banner_image', bannerFile);
    if (iconFile) fd.append('icon', iconFile);

    try {
      if (isEdit) await facilityCategoriesApi.update(category.id, fd);
      else await facilityCategoriesApi.create(fd);
      onSaved?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data, 'Unable to save the category. Please try again.'));
    }
  }

  return (
    <>
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${category.name}` : 'New facility category'} size="lg"
      footer={
        <>
          {isEdit && (
            <button className="btn btn-danger" type="button" onClick={() => setConfirmDelete(true)}
                    style={{ marginRight: 'auto' }}>
              <Trash2 size={15} /> {t('common:actions.delete')}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose} type="button">{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
            {isSubmitting ? t('common:state.saving') : t('saveCategory')}
          </button>
        </>
      }
    >
      <SectionTitle>{t('basicInfo')}</SectionTitle>
      <div className="row">
        <div className="col">
          <FormField label={t('name')} hint={t('eGRacketSportsAquatics')} error={errors.name?.message}>
            <input
              className="form-input"
              {...nameField}
              onChange={(e) => {
                nameField.onChange(e);
                if (!slugTouched.current) {
                  setValue('slug', toSlug(e.target.value), { shouldValidate: true });
                }
              }}
            />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('slug')} error={errors.slug?.message}>
            <input
              className="form-input"
              {...slugField}
              onChange={(e) => {
                slugTouched.current = true;
                slugField.onChange(e);
              }}
            />
          </FormField>
        </div>
      </div>
      <FormField label={t('description')} hint={t('richTextUseBoldLists')}
                 error={errors.description?.message}>
        <Controller name="description" control={control}
          render={({ field }) => (
            <RichTextEditor value={field.value || ''} onChange={field.onChange}
              placeholder={t('describeCategory')} />
          )} />
      </FormField>
      <div className="row">
        <div className="col">
          <FormField label={t('kind')} error={errors.kind?.message}>
            <Controller name="kind" control={control} rules={{ required: 'Select a kind' }}
              render={({ field }) => (
                <Select2 options={facilityKinds(t)} value={field.value} onChange={field.onChange}
                         placeholder={t('selectKind')} error={errors.kind?.message} />
              )} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('basePrice')} hint={t('usedWhenBookingMadeAgainst')}>
            <input className="form-input" type="number" min="0" step="0.01"
                   {...register('base_price', { min: { value: 0, message: '0 or more' } })} />
          </FormField>
        </div>
      </div>

      <SectionTitle>{t('media')}</SectionTitle>
      <ImageUploader
        label={t('displayBannerImage')}
        hint={t('wideBannerShownCategoryPage')}
        aspect={3}
        output={{ width: 1200, height: 400, type: 'image/jpeg', quality: 0.9 }}
        currentUrl={category?.banner_image}
        file={bannerFile}
        onChange={setBannerFile}
      />
      <ImageUploader
        label={t('mediaIcon')}
        hint={t('portrait45ImageUsed')}
        aspect={4 / 5}
        output={{ width: 800, height: 1000, type: 'image/jpeg', quality: 0.9 }}
        currentUrl={category?.icon}
        file={iconFile}
        onChange={setIconFile}
      />

      <SectionTitle>{t('badgeDisplay')}</SectionTitle>
      <div className="row">
        <div className="col">
          <FormField label={`Badge Label${badgeShow ? ' *' : ''}`} hint={t('eGNewPopularPremium')}
                     error={errors.badge_label?.message}>
            <input className="form-input"
              {...register('badge_label', {
                maxLength: { value: 30, message: 'Max 30 characters' },
                validate: (v) => (!badgeShow || (v || '').trim().length > 0)
                  || 'Badge label is required when the badge is shown',
              })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('displayOrder')} hint="e.g. 1, 2, 3" error={errors.display_order?.message}>
            <input className="form-input" type="number" min="0"
              {...register('display_order', {
                min: { value: 0, message: 'Must be 0 or greater' },
                validate: (v) => v === '' || v === null || Number.isInteger(Number(v)) || 'Whole numbers only',
              })} />
          </FormField>
        </div>
      </div>
      <div className="toggle-grid">
        <Toggle label={t('showBadge')} description={t('displayBadgeCategory')}
                {...register('badge_show')} />
        <Toggle label={t('common:state.active')} description={t('visibleAvailableBook')}
                {...register('is_active')} />
        <Toggle label={t('featured')} description={t('highlightAsFeaturedCategory')}
                {...register('is_featured')} />
      </div>

      <SectionTitle>{t('facilityTypes')}</SectionTitle>
      <FormField label={t('facilityTypesCategory')}
                 hint={t('pickFacilityTypesPlaceUnder')}>
        {facilityTypeList.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>{t('noFacilityTypesCreatedYet')}</p>
        ) : (
          <Select2
            multiple
            placeholder={t('selectFacilityTypes')}
            options={facilityTypeList.map((s) => ({
              value: s.id,
              label: s.name,
            }))}
            value={facilityTypeIds}
            onChange={setFacilityTypeIds}
          />
        )}
      </FormField>

      <SectionTitle>{t('availability')}</SectionTitle>
      <FormField label={t('clubsOptional')}>
        {clubs.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>{t('noClubsConfiguredYet')}</p>
        ) : (
          <Select2
            multiple
            placeholder={t('selectClubs')}
            options={clubs.map((s) => ({ value: s.id, label: s.name }))}
            value={[...siteIds]}
            onChange={(vals) => setSiteIds(new Set(vals))}
          />
        )}
      </FormField>

      <SectionTitle>{t('seoOptional')}</SectionTitle>
      <FormField label={t('metaTitle')} error={errors.meta_title?.message}>
        <input className="form-input"
          {...register('meta_title', { maxLength: { value: 160, message: 'Keep under 160 characters' } })} />
      </FormField>
      <FormField label={t('metaDescription')} error={errors.meta_description?.message}>
        <textarea className="form-textarea" rows={2}
          {...register('meta_description', { maxLength: { value: 300, message: 'Keep under 300 characters' } })} />
      </FormField>
    </Modal>

    <ConfirmDialog
      open={confirmDelete}
      tone="danger"
      title={t('deleteCategory')}
      message={
        <>
          <strong>{category?.name}</strong> will be permanently removed. This is only possible
          if no bookings reference it - otherwise the delete will be blocked.
        </>
      }
      confirmLabel={t('common:actions.delete')}
      busy={deleting}
      onConfirm={handleDelete}
      onClose={() => setConfirmDelete(false)}
    />
    </>
  );
}

/* ----- Facility types tab (the bookable, priced offerings) ------------------ */

function FacilityTypesTab() {
  const { t } = useTranslation('facilities');
  const { hasPerm } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [categories, setCategories] = useState([]);
  const fetcher = useCallback((q) => facilityTypesApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    facilityCategoriesApi.list({ page_size: 100 }).then((d) => setCategories(d.results || d)).catch(() => {});
  }, []);

  function openNew() { setEditItem(null); setModalOpen(true); }
  function openEdit(row) { setEditItem(row); setModalOpen(true); }

  const columns = useMemo(() => [
    {
      key: 'name', header: t('types.columns.facilityType'), sortKey: 'name', minWidth: 260,
      alwaysVisible: true,
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {r.image ? (
            <img src={r.image} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
          ) : (
            <div style={{
              width: 36, height: 36, borderRadius: 8, flexShrink: 0,
              background: 'var(--color-border-soft)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)',
            }}>
              {r.video ? <Video size={16} /> : <ImageIcon size={16} />}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>
              {r.name}
              {r.tagline && <span className="muted" style={{ fontWeight: 500 }}> - {r.tagline}</span>}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <span className="muted">{(r.category_names || []).join(', ')}</span>
              {r.badge && <StatusBadge tone="warning" label={badgeLabel(t, r.badge)} />}
            </div>
          </div>
        </div>
      ),
    },
    { key: 'price', header: t('types.columns.slotPrice'), sortKey: 'price', align: 'right',
      minWidth: 110, nowrap: true,
      render: (r) => <Money amount={r.price} /> },
    { key: 'duration', header: t('types.columns.duration'), sortKey: 'duration_minutes',
      align: 'right', minWidth: 100, nowrap: true,
      render: (r) => t('types.minutes', { count: r.duration_minutes }) },
    { key: 'tax', header: t('types.columns.tax'), align: 'right', minWidth: 80, priority: 'low',
      render: (r) => `${Number(r.tax_percent).toFixed(0)}%` },
    { key: 'disc', header: t('types.columns.discount'), align: 'right', minWidth: 100, priority: 'low',
      render: (r) => `${Number(r.discount_percent).toFixed(0)}%` },
    { key: 'online', header: t('types.columns.online'), minWidth: 110, priority: 'medium',
      render: (r) => (
        <StatusBadge tone={r.online_booking_enabled ? 'info' : 'muted'}
                     label={r.online_booking_enabled ? t('types.bookable') : t('types.off')} />
      ) },
    {
      key: 'status', header: t('categories.columns.status'), sortKey: 'is_active', minWidth: 110,
      render: (r) => (
        <StatusBadge tone={r.is_active ? 'success' : 'muted'}
                     label={r.is_active ? t('common.active') : t('common.inactive')} />
      ),
    },
  ], [t]);

  const filters = useMemo(() => [
    { key: 'categories', label: t('types.filters.category'), type: 'select',
      options: categories.map((c) => ({ value: c.id, label: c.name })) },
    { key: 'is_active', label: t('categories.filters.status'), type: 'boolean',
      trueLabel: t('common.active'), falseLabel: t('common.inactive') },
    { key: 'online_booking_enabled', label: t('types.filters.onlineBooking'), type: 'boolean',
      trueLabel: t('types.bookable'), falseLabel: t('types.off') },
  ], [categories, t]);

  return (
    <>
      <ListView
        tableKey="facility-types"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="name"
        searchPlaceholder={t('types.searchPlaceholder')}
        emptyTitle={t('types.emptyTitle')}
        emptyHint={t('types.emptyHint')}
        onRowClick={openEdit}
        columns={columns}
        filters={filters}
        groupOptions={typeGroups(t)}
        toolbarRight={hasPerm('facilities.add') && (
          <button className="btn btn-primary" onClick={openNew}>
            <Plus size={15} /> {t('types.add')}
          </button>
        )}
      />

      <FacilityTypeFormModal
        open={modalOpen}
        item={editItem}
        categories={categories}
        onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); toast.success(t('types.saved')); reload(); }}
        onDeleted={() => { setModalOpen(false); toast.success(t('types.deleted')); reload(); }}
      />
    </>
  );
}

const badgeLabel = (t, v) => facilityBadges(t).find((b) => b.value === v)?.label || v;

function FacilityTypeFormModal({ open, item, categories, onClose, onSaved, onDeleted }) {
  const { t } = useTranslation('facilities');
  const isEdit = Boolean(item);
  const defaultTaxPct = useDefaultTaxPercent();
  const { register, handleSubmit, reset, watch, control, formState: { errors, isSubmitting } } = useForm();

  const [addons, setAddons] = useState([]);
  const [addonIds, setAddonIds] = useState([]);
  const [categoryIds, setCategoryIds] = useState([]);
  const [catError, setCatError] = useState('');
  const [clubs, setSites] = useState([]);
  const [siteIds, setSiteIds] = useState([]);
  const [imageFile, setImageFile] = useState(null);
  const [videoFile, setVideoFile] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const allSites = watch('available_all_clubs');

  useEffect(() => {
    if (!open) return;
    addonsApi.list({ page_size: 100 }).then((d) => setAddons(d.results || d)).catch(() => {});
    clubsApi.list({ page_size: 100 }).then((d) => setSites(d.results || d)).catch(() => {});
    reset({
      name: item?.name || '',
      tagline: item?.tagline || '',
      badge: item?.badge || '',
      description: item?.description || '',
      whats_included: item?.whats_included || '',
      whats_not_included: item?.whats_not_included || '',
      price: trimZeros(item?.price ?? 0),
      duration_minutes: item?.duration_minutes ?? 60,
      tax_percent: item?.tax_percent ?? defaultTaxPct,
      tax_inclusive: item?.tax_inclusive ?? false,
      discount_percent: item?.discount_percent ?? 0,
      available_all_clubs: item?.available_all_clubs ?? true,
      staff_required: item?.staff_required ?? false,
      facility_required: item?.facility_required ?? true,
      online_booking_enabled: item?.online_booking_enabled ?? true,
      is_active: item?.is_active ?? true,
    });
    setAddonIds(item?.add_ons || []);
    setCategoryIds(item?.categories || []);
    setCatError('');
    setSiteIds(item?.available_clubs || []);
    setImageFile(null);
    setVideoFile(null);
  }, [open, item, reset, defaultTaxPct]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await facilityTypesApi.remove(item.id);
      setConfirmDelete(false);
      onDeleted?.();
    } catch (e) {
      setConfirmDelete(false);
      toast.error(apiErrorMessage(e, t('unableDeleteFacilityTypePlease')));
    } finally { setDeleting(false); }
  }

  async function onSubmit(v) {
    if (!categoryIds.length) {
      setCatError('Select at least one category');
      toast.error(t('selectLeastOneCategoryFacility'));
      return;
    }
    if (!v.available_all_clubs && siteIds.length === 0) {
      toast.error(t('selectClubOrAllClubs'));
      return;
    }

    const payload = {
      name: v.name,
      tagline: v.tagline || '',
      badge: v.badge || '',
      categories: categoryIds,
      description: v.description || '',
      whats_included: v.whats_included || '',
      whats_not_included: v.whats_not_included || '',
      price: Number(v.price) || 0,
      duration_minutes: Number(v.duration_minutes) || 0,
      tax_percent: Number(v.tax_percent) || 0,
      tax_inclusive: !!v.tax_inclusive,
      discount_percent: Number(v.discount_percent) || 0,
      available_all_clubs: !!v.available_all_clubs,
      available_clubs: v.available_all_clubs ? [] : siteIds,
      staff_required: !!v.staff_required,
      facility_required: !!v.facility_required,
      online_booking_enabled: !!v.online_booking_enabled,
      is_active: !!v.is_active,
      add_ons: addonIds,
    };

    try {
      const saved = isEdit
        ? await facilityTypesApi.update(item.id, payload)
        : await facilityTypesApi.create(payload);
      // Upload media as a second multipart step (only when a new file was chosen).
      if (imageFile || videoFile) {
        const fd = new FormData();
        if (imageFile) fd.append('image', imageFile);
        if (videoFile) fd.append('video', videoFile);
        await facilityTypesApi.uploadMedia(saved.id, fd);
      }
      onSaved?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data, 'Unable to save the facility type. Please try again.'));
    }
  }

  return (
    <>
    <Modal open={open} onClose={onClose} size="lg"
      title={isEdit ? `Edit ${item.name}` : 'New facility type'}
      footer={
        <>
          {isEdit && (
            <button className="btn btn-danger" type="button" onClick={() => setConfirmDelete(true)}
                    style={{ marginRight: 'auto' }}>
              <Trash2 size={15} /> {t('common:actions.delete')}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose} type="button">{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
            {isSubmitting ? t('common:state.saving') : t('saveFacilityType')}
          </button>
        </>
      }
    >
      <SectionTitle>{t('basicInfo')}</SectionTitle>
      <div className="row">
        <div className="col">
          <FormField label={t('facilityTypeName')} error={errors.name?.message}>
            <input className="form-input" {...register('name', { required: 'Name is required' })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('categoriesField')} hint={t('selectOneMoreCategories')} error={catError}>
            <Select2
              multiple
              options={categories.map((c) => ({ value: c.id, label: c.name }))}
              value={categoryIds}
              onChange={(vals) => { setCategoryIds(vals); if (vals.length) setCatError(''); }}
              placeholder={t('selectCategories')}
              error={catError}
            />
          </FormField>
        </div>
      </div>
      <div className="row">
        <div className="col">
          <FormField label={t('tagline')} hint={t('taglineHint')}>
            <input className="form-input" {...register('tagline')} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('badge')}>
            <Controller name="badge" control={control} render={({ field }) => (
              <Select2 options={facilityBadges(t)} value={field.value} onChange={field.onChange}
                       placeholder={t('common:state.none')} clearable />
            )} />
          </FormField>
        </div>
      </div>
      <FormField label={t('description')}>
        <textarea className="form-textarea" rows={2} {...register('description')} />
      </FormField>
      <FormField label={t('whatsIncluded')}>
        <Controller name="whats_included" control={control}
          render={({ field }) => (
            <RichTextEditor value={field.value || ''} onChange={field.onChange}
              placeholder={t('eGFloodlightsIncludedAfter')} />
          )} />
      </FormField>
      <FormField label={t('whatsNotIncluded')}>
        <textarea className="form-textarea" rows={3} {...register('whats_not_included')}
          placeholder={'e.g. Equipment hire\nCoaching\nChanging-room lockers'} />
      </FormField>
      <SectionTitle>{t('priceDurationCharges')}</SectionTitle>
      <div className="form-grid form-grid--4">
        <FormField label={t('slotPrice')} error={errors.price?.message}>
          <div style={{ position: 'relative' }}>
            <span style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--color-text-muted)', fontSize: 13,
            }}><CurrencySymbol /></span>
            <input className="form-input" type="number" min="0" step="0.01" style={{ paddingLeft: 30 }}
                   {...register('price', { min: { value: 0, message: '0 or more' } })} />
          </div>
        </FormField>
        <FormField label={t('durationMinutes')} error={errors.duration_minutes?.message}>
          <input className="form-input" type="number" min="1"
            {...register('duration_minutes', {
              required: 'Required',
              min: { value: 1, message: 'Must be at least 1 minute' },
            })} />
        </FormField>
        <FormField label={t('taxVat')} error={errors.tax_percent?.message}>
          <input className="form-input" type="number" min="0" max="100" step="0.01"
            {...register('tax_percent', { min: { value: 0, message: '0 or more' } })} />
        </FormField>
        <FormField label={t('discount')} error={errors.discount_percent?.message}>
          <input className="form-input" type="number" min="0" max="100" step="0.01"
            {...register('discount_percent', { min: { value: 0, message: '0 or more' } })} />
        </FormField>
      </div>
      <Toggle label={t('taxInclusive')}
              description={t('priceAlreadyIncludesTaxOff')}
              {...register('tax_inclusive')} />

      <SectionTitle>{t('media')}</SectionTitle>
      <ImageUploader
        label={t('facilityImage')}
        hint={t('shownFacilityCardDragZoom')}
        aspect={1}
        output={{ width: 600, height: 600, type: 'image/jpeg', quality: 0.9 }}
        currentUrl={item?.image}
        file={imageFile}
        onChange={setImageFile}
      />
      <FormField label={t('facilityVideo')} hint={t('optionalShortClipMp4Webm')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <Upload size={15} /> {videoFile || item?.video ? t('changeVideo') : t('uploadVideo')}
            <input type="file" accept="video/*" hidden
                   onChange={(e) => setVideoFile(e.target.files?.[0] || null)} />
          </label>
          {videoFile ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--color-text)' }}>
              <Video size={14} /> {videoFile.name}
              <button type="button" className="icon-btn" title={t('removeVideo')} onClick={() => setVideoFile(null)}><X size={14} /></button>
            </span>
          ) : item?.video ? (
            <a href={item.video} target="_blank" rel="noreferrer" className="muted"
               style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Video size={14} /> {t('currentVideo')}
            </a>
          ) : (
            <span className="muted" style={{ fontSize: 12.5 }}>{t('noVideoSelected')}</span>
          )}
        </div>
      </FormField>

      <SectionTitle>{t('addOns')}</SectionTitle>
      <FormField label={t('availableAddOns')} hint={t('optionalExtrasCustomersCanAttach')}>
        {addons.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>{t('noAddOnsConfiguredYet')}</p>
        ) : (
          <Select2
            multiple
            placeholder={t('selectAddOns')}
            options={addons.map((a) => ({ value: a.id, label: a.name }))}
            value={addonIds}
            onChange={setAddonIds}
          />
        )}
      </FormField>

      <SectionTitle>{t('availability')}</SectionTitle>
      <Toggle label={t('availableAllClubs')}
              description={t('turnOffChooseSpecificClubs')}
              {...register('available_all_clubs')} />
      {!allSites && (
        <FormField label={t('clubs')}>
          {clubs.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>{t('noClubsConfiguredYet')}</p>
          ) : (
            <Select2
              multiple
              placeholder={t('selectClubs')}
              options={clubs.map((s) => ({ value: s.id, label: s.name }))}
              value={siteIds}
              onChange={setSiteIds}
            />
          )}
        </FormField>
      )}

      <SectionTitle>{t('options')}</SectionTitle>
      <div className="toggle-grid">
        <Toggle label={t('staffRequired')} description={t('needsAssignedStaffMember')} {...register('staff_required')} />
        <Toggle label={t('facilityRequired')} description={t('occupiesPhysicalCourtLaneRoom')} {...register('facility_required')} />
        <Toggle label={t('onlineBooking')} description={t('bookableWebsite')} {...register('online_booking_enabled')} />
      </div>
      <div className="toggle-grid toggle-grid--1">
        <Toggle label={t('common:state.active')} description={t('visibleAvailableBook')} {...register('is_active')} />
      </div>
    </Modal>

    <ConfirmDialog
      open={confirmDelete}
      tone="danger"
      title={t('deleteFacilityType')}
      message={<><strong>{item?.name}</strong> will be permanently removed.</>}
      confirmLabel={t('common:actions.delete')}
      busy={deleting}
      onConfirm={handleDelete}
      onClose={() => setConfirmDelete(false)}
    />
    </>
  );
}

/* ----- Add-ons tab --------------------------------------------------------- */
function AddOnsTab() {
  const { t } = useTranslation('facilities');
  const { hasPerm } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [categories, setCategories] = useState([]);
  const fetcher = useCallback((q) => addonsApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    facilityCategoriesApi.list({ page_size: 100 }).then((d) => setCategories(d.results || d)).catch(() => {});
  }, []);

  function openNew() { setEditItem(null); setModalOpen(true); }
  function openEdit(row) { setEditItem(row); setModalOpen(true); }

  const columns = useMemo(() => [
    {
      key: 'name', header: t('addons.columns.addon'), sortKey: 'name', minWidth: 240,
      alwaysVisible: true,
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {r.image ? (
            <img src={r.image} alt="" style={{ width: 34, height: 34, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
          ) : (
            <div style={{
              width: 34, height: 34, borderRadius: 8, flexShrink: 0,
              background: 'var(--color-border-soft)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)',
            }}><ImageIcon size={15} /></div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>
              {r.name}
              {r.is_featured && <StatusBadge tone="warning" label={t('featured')} />}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {r.code ? `${r.code} · ` : ''}{(r.category_names || []).join(', ') || 'No category'}
            </div>
          </div>
        </div>
      ),
    },
    { key: 'price', header: t('price2'), align: 'right', render: (r) => <Money amount={r.price} /> },
    { key: 'tax', header: t('tax'), align: 'right', render: (r) => `${Number(r.tax_percent).toFixed(0)}%` },
    { key: 'dur', header: t('duration'), align: 'right', render: (r) => `${r.duration_minutes} min` },
    { key: 'order', header: t('order'), align: 'right', render: (r) => r.display_order },
    { key: 'status', header: t('categories.columns.status'), sortKey: 'is_active', minWidth: 110,
      render: (r) => <StatusBadge tone={r.is_active ? 'success' : 'muted'}
                                  label={r.is_active ? t('common.active') : t('common.inactive')} /> },
  ], [t]);

  const filters = useMemo(() => [
    { key: 'categories', label: t('category'), type: 'select',
      options: categories.map((c) => ({ value: c.id, label: c.name })) },
    { key: 'is_active', label: t('categories.filters.status'), type: 'boolean',
      trueLabel: t('common.active'), falseLabel: t('common.inactive') },
  ], [categories, t]);

  return (
    <>
      <ListView
        tableKey="facility-addons"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="name"
        searchPlaceholder={t('addons.searchPlaceholder')}
        emptyTitle={t('addons.emptyTitle')}
        emptyHint={t('addons.emptyHint')}
        onRowClick={openEdit}
        columns={columns}
        filters={filters}
        groupOptions={addonGroups(t)}
        toolbarRight={hasPerm('facilities.add') && (
          <button className="btn btn-primary" onClick={openNew}>
            <Plus size={15} /> {t('addons.add')}
          </button>
        )}
      />

      <AddOnFormModal
        open={modalOpen}
        addon={editItem}
        categories={categories}
        onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); toast.success(t('addSaved')); reload(); }}
        onDeleted={() => { setModalOpen(false); toast.success(t('addDeleted')); reload(); }}
      />
    </>
  );
}

function AddOnFormModal({ open, addon, categories, onClose, onSaved, onDeleted }) {
  const { t } = useTranslation('facilities');
  const isEdit = Boolean(addon);
  const defaultTaxPct = useDefaultTaxPercent();
  const { register, handleSubmit, reset, watch, formState: { errors, isSubmitting } } = useForm();

  const [clubs, setSites] = useState([]);
  const [siteIds, setSiteIds] = useState([]);
  const [categoryIds, setCategoryIds] = useState([]);
  const [facilityTypeOptions, setFacilityTypeOptions] = useState([]);
  const [facilityTypeSel, setFacilityTypeSel] = useState([]);
  const [imageFile, setImageFile] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const allSites = watch('available_all_clubs');

  useEffect(() => {
    if (!open) return;
    clubsApi.list({ page_size: 100 }).then((d) => setSites(d.results || d)).catch(() => {});
    facilityTypesApi.list({ page_size: 200 }).then((d) => setFacilityTypeOptions(d.results || d)).catch(() => {});
    reset({
      name: addon?.name || '',
      code: addon?.code || '',
      description: addon?.description || '',
      price: trimZeros(addon?.price ?? 0),
      tax_percent: addon?.tax_percent ?? defaultTaxPct,
      tax_inclusive: addon?.tax_inclusive ?? false,
      duration_minutes: addon?.duration_minutes ?? 10,
      display_order: addon?.display_order ?? 0,
      available_all_clubs: addon?.available_all_clubs ?? true,
      is_featured: addon?.is_featured ?? false,
      is_active: addon?.is_active ?? true,
    });
    setCategoryIds(addon?.categories || []);
    setFacilityTypeSel(addon?.facility_types || []);
    setSiteIds(addon?.available_clubs || []);
    setImageFile(null);
  }, [open, addon, reset, defaultTaxPct]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await addonsApi.remove(addon.id);
      setConfirmDelete(false);
      onDeleted?.();
    } catch (e) {
      setConfirmDelete(false);
      toast.error(apiErrorMessage(e, t('unableDeleteAddPleaseTry')));
    } finally { setDeleting(false); }
  }

  async function onSubmit(v) {
    if (!v.available_all_clubs && siteIds.length === 0) {
      toast.error(t('selectClubOrAllClubs'));
      return;
    }
    const fd = new FormData();
    fd.append('name', v.name);
    fd.append('code', v.code || '');
    fd.append('description', v.description || '');
    categoryIds.forEach((id) => fd.append('categories', id));
    facilityTypeSel.forEach((id) => fd.append('facility_types', id));
    fd.append('price', String(Number(v.price) || 0));
    fd.append('tax_percent', String(Number(v.tax_percent) || 0));
    fd.append('tax_inclusive', v.tax_inclusive ? 'true' : 'false');
    fd.append('duration_minutes', String(Number(v.duration_minutes) || 0));
    fd.append('display_order', String(Number(v.display_order) || 0));
    fd.append('available_all_clubs', v.available_all_clubs ? 'true' : 'false');
    fd.append('is_featured', v.is_featured ? 'true' : 'false');
    fd.append('is_active', v.is_active ? 'true' : 'false');
    if (!v.available_all_clubs) siteIds.forEach((id) => fd.append('available_clubs', id));
    if (imageFile) fd.append('image', imageFile);

    try {
      if (isEdit) await addonsApi.update(addon.id, fd);
      else await addonsApi.create(fd);
      onSaved?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data, 'Unable to save the add-on. Please try again.'));
    }
  }

  return (
    <>
    <Modal open={open} onClose={onClose} size="lg"
      title={isEdit ? `Edit ${addon.name}` : 'New add-on'}
      footer={
        <>
          {isEdit && (
            <button className="btn btn-danger" type="button" onClick={() => setConfirmDelete(true)}
                    style={{ marginRight: 'auto' }}>
              <Trash2 size={15} /> {t('common:actions.delete')}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose} type="button">{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
            {isSubmitting ? t('common:state.saving') : t('saveAdd')}
          </button>
        </>
      }
    >
      <SectionTitle>{t('basicInfo')}</SectionTitle>
      <div className="row">
        <div className="col">
          <FormField label={t('addName')} error={errors.name?.message}>
            <input className="form-input" {...register('name', { required: 'Name is required' })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('addCode')} hint={t('optionalUniqueCodeSku')} error={errors.code?.message}>
            <input className="form-input" {...register('code')} />
          </FormField>
        </div>
      </div>
      <FormField label={t('description')}>
        <textarea className="form-textarea" rows={2} {...register('description')} />
      </FormField>
      <div className="row">
        <div className="col">
          <FormField label={t('categories2')} hint={t('selectOneMoreOptional')}>
            <Select2
              multiple
              options={categories.map((c) => ({ value: c.id, label: c.name }))}
              value={categoryIds}
              onChange={setCategoryIds}
              placeholder={t('selectCategories')}
            />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('displayOrder')} error={errors.display_order?.message}>
            <input className="form-input" type="number" min="0"
              {...register('display_order', { min: { value: 0, message: '0 or more' } })} />
          </FormField>
        </div>
      </div>
      <FormField label={t('facilityTypes')}
                 hint={t('optionallyOfferAddSpecificFacility')}>
        {facilityTypeOptions.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>{t('noFacilityTypesCreatedYet2')}</p>
        ) : (
          <Select2
            multiple
            placeholder={t('selectFacilityTypes')}
            options={facilityTypeOptions.map((s) => ({ value: s.id, label: s.name }))}
            value={facilityTypeSel}
            onChange={setFacilityTypeSel}
          />
        )}
      </FormField>

      <SectionTitle>{t('pricingSection')}</SectionTitle>
      <div className="form-grid form-grid--3">
        <FormField label={t('price')} error={errors.price?.message}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)', fontSize: 13 }}><CurrencySymbol /></span>
            <input className="form-input" type="number" min="0" step="0.01" style={{ paddingLeft: 30 }}
              {...register('price', { required: 'Required', min: { value: 0, message: '0 or more' } })} />
          </div>
        </FormField>
        <FormField label={t('taxVat')} error={errors.tax_percent?.message}>
          <input className="form-input" type="number" min="0" max="100" step="0.01"
            {...register('tax_percent', { min: { value: 0, message: '0 or more' } })} />
        </FormField>
        <FormField label={t('durationMinutes2')} error={errors.duration_minutes?.message}>
          <input className="form-input" type="number" min="0"
            {...register('duration_minutes', { min: { value: 0, message: '0 or more' } })} />
        </FormField>
      </div>
      <Toggle label={t('taxInclusive')}
              description={t('priceAlreadyIncludesTaxOff')}
              {...register('tax_inclusive')} />

      <SectionTitle>{t('media')}</SectionTitle>
      <ImageUploader
        label={t('imageIcon')}
        hint={t('optionalSquareIconShownAdd')}
        aspect={1}
        output={{ width: 256, height: 256, type: 'image/png' }}
        currentUrl={addon?.image}
        file={imageFile}
        onChange={setImageFile}
      />

      <SectionTitle>{t('availability')}</SectionTitle>
      <Toggle label={t('availableAllClubs')}
              description={t('turnOffChooseSpecificClubs')}
              {...register('available_all_clubs')} />
      {!allSites && (
        <FormField label={t('clubs')}>
          {clubs.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>{t('noClubsConfiguredYet')}</p>
          ) : (
            <Select2
              multiple
              placeholder={t('selectClubs')}
              options={clubs.map((s) => ({ value: s.id, label: s.name }))}
              value={siteIds}
              onChange={setSiteIds}
            />
          )}
        </FormField>
      )}

      <SectionTitle>{t('options')}</SectionTitle>
      <div className="toggle-grid toggle-grid--2">
        <Toggle label={t('featuredAdd')} description={t('highlightAdd')} {...register('is_featured')} />
        <Toggle label={t('common:state.active')} description={t('availableAttachFacilityTypes')} {...register('is_active')} />
      </div>
    </Modal>

    <ConfirmDialog
      open={confirmDelete}
      tone="danger"
      title={t('deleteAdd')}
      message={<><strong>{addon?.name}</strong> will be permanently removed.</>}
      confirmLabel={t('common:actions.delete')}
      busy={deleting}
      onConfirm={handleDelete}
      onClose={() => setConfirmDelete(false)}
    />
    </>
  );
}

/* ----- Pricing Rules tab --------------------------------------------------- */
function PricingRulesTab() {
  const { t } = useTranslation('facilities');
  const { hasPerm } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const fetcher = useCallback((q) => pricingRulesApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  function openNew() { setEditItem(null); setModalOpen(true); }
  function openEdit(row) { setEditItem(row); setModalOpen(true); }

  const columns = useMemo(() => [
    {
      key: 'name', header: t('pricing.columns.rule'), sortKey: 'name', minWidth: 240,
      alwaysVisible: true,
      render: (r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>{r.code}</div>
        </div>
      ),
    },
    { key: 'applies', header: t('applies'), truncate: true, width: 150,
      render: (r) => <span>{r.applies_to_summary}</span> },
    { key: 'type', header: t('ruleType2'),
      render: (r) => <StatusBadge tone="info" label={r.rule_type_display} /> },
    { key: 'cond', header: t('condition'), truncate: true, width: 200,
      render: (r) => <span className="muted">{r.condition_summary}</span> },
    { key: 'adj', header: t('adjustment'), align: 'right',
      render: (r) => <strong>{r.adjustment_display}</strong> },
    { key: 'priority', header: t('priority2'), align: 'right', render: (r) => r.priority },
    { key: 'validity', header: t('validity'), render: (r) => <span className="muted">{r.validity_summary}</span> },
    { key: 'status', header: t('categories.columns.status'), sortKey: 'is_active', minWidth: 110,
      render: (r) => <StatusBadge tone={r.is_active ? 'success' : 'muted'}
                                  label={r.is_active ? t('common.active') : t('common.inactive')} /> },
    { key: 'actions', header: '', align: 'right',
      render: (r) => (
        <div className="table-actions">
          <button className="icon-btn" title={t('editRule')}
                  onClick={(e) => { e.stopPropagation(); openEdit(r); }}>
            <Pencil size={15} />
          </button>
        </div>
      ) },
  ], [t]);

  const filters = useMemo(() => [
    { key: 'rule_type', label: t('pricing.filters.ruleType'), type: 'select', options: ruleTypes(t) },
    { key: 'is_active', label: t('categories.filters.status'), type: 'boolean',
      trueLabel: t('common.active'), falseLabel: t('common.inactive') },
  ], [t]);

  return (
    <>
      <ListView
        tableKey="pricing-rules"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="priority"
        searchPlaceholder={t('pricing.searchPlaceholder')}
        emptyTitle={t('pricing.emptyTitle')}
        emptyHint={t('pricing.emptyHint')}
        onRowClick={openEdit}
        columns={columns}
        filters={filters}
        groupOptions={ruleGroups(t)}
        toolbarRight={hasPerm('facilities.add') && (
          <button className="btn btn-primary" onClick={openNew}>
            <Plus size={15} /> {t('pricing.add')}
          </button>
        )}
      />

      <PricingRuleFormModal
        open={modalOpen}
        rule={editItem}
        onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); toast.success(t('pricingRuleSaved')); reload(); }}
        onDeleted={() => { setModalOpen(false); toast.success(t('pricingRuleDeleted')); reload(); }}
      />
    </>
  );
}

// Which condition blocks show for each rule type (custom shows all).
const RULE_SHOW = {
  club:       ['club', 'custom'],
  membership: ['membership', 'custom'],
  days:       ['weekend', 'peak_hour', 'custom'],
  time:       ['peak_hour', 'custom'],
  dates:      ['promo', 'date_range', 'custom'],
};
const showFor = (group, type) => RULE_SHOW[group].includes(type);

// Suggest a rule code from the rule name (operator can still edit it).
const genRuleCode = (name) => (name || '').trim().toUpperCase()
  .replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);

function PricingRuleFormModal({ open, rule, onClose, onSaved, onDeleted }) {
  const { t } = useTranslation('facilities');
  const isEdit = Boolean(rule);
  const { register, handleSubmit, reset, watch, control, setValue,
          formState: { errors, isSubmitting } } = useForm();
  // Once the operator edits the code, stop auto-deriving it from the name.
  const [codeEdited, setCodeEdited] = useState(false);

  const [cats, setCats] = useState([]);
  const [pkgs, setPkgs] = useState([]);
  const [adds, setAdds] = useState([]);
  const [clubs, setClubs] = useState([]);
  const [plans, setPlans] = useState([]);

  const [catIds, setCatIds] = useState([]);
  const [pkgIds, setPkgIds] = useState([]);
  const [addIds, setAddIds] = useState([]);
  const [clubIds, setClubIds] = useState([]);
  const [planIds, setPlanIds] = useState([]);
  const [cTypes, setCTypes] = useState([]);
  const [days, setDays] = useState([]);

  const [preview, setPreview] = useState(null);
  const [previewBase, setPreviewBase] = useState('100');
  const [previewing, setPreviewing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const ruleType = watch('rule_type');
  const isPercent = String(watch('adjustment_type') || '').startsWith('percent');

  useEffect(() => {
    if (!open) return;
    // Existing rules keep their saved code; new rules auto-derive until edited.
    setCodeEdited(Boolean(rule?.code));
    facilityCategoriesApi.list({ page_size: 200 }).then((d) => setCats(d.results || d)).catch(() => {});
    facilityTypesApi.list({ page_size: 200 }).then((d) => setPkgs(d.results || d)).catch(() => {});
    addonsApi.list({ page_size: 200 }).then((d) => setAdds(d.results || d)).catch(() => {});
    clubsApi.list({ page_size: 200 }).then((d) => setClubs(d.results || d)).catch(() => {});
    membershipPlansApi.list({ page_size: 200 }).then((d) => setPlans(d.results || d)).catch(() => {});
    reset({
      name: rule?.name || '',
      code: rule?.code || '',
      description: rule?.description || '',
      is_active: rule?.is_active ?? true,
      priority: rule?.priority ?? 100,
      display_order: rule?.display_order ?? 0,
      rule_type: rule?.rule_type || 'custom',
      adjustment_type: rule?.adjustment_type || 'fixed_increase',
      adjustment_value: rule?.adjustment_value ?? 0,
      currency: rule?.currency || '',
      tax_applicable: rule?.tax_applicable ?? false,
      allow_stacking: rule?.allow_stacking ?? true,
      valid_from: rule?.valid_from || '',
      valid_to: rule?.valid_to || '',
      start_time: rule?.start_time ? String(rule.start_time).slice(0, 5) : '',
      end_time: rule?.end_time ? String(rule.end_time).slice(0, 5) : '',
      min_amount: rule?.min_amount ?? '',
      min_quantity: rule?.min_quantity ?? '',
    });
    setCatIds(rule?.categories || []);
    setPkgIds(rule?.facility_types || []);
    setAddIds(rule?.addons || []);
    setClubIds(rule?.clubs || []);
    setPlanIds(rule?.membership_plans || []);
    setCTypes(rule?.customer_types || []);
    setDays(rule?.days_of_week || []);
    setPreview(null);
  }, [open, rule, reset]);

  async function runPreview() {
    setPreviewing(true);
    try {
      const d = await pricingRulesApi.preview({
        base_price: Number(previewBase) || 0,
        adjustment_type: watch('adjustment_type'),
        adjustment_value: Number(watch('adjustment_value')) || 0,
      });
      setPreview(d);
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableGeneratePreviewPleaseTry')));
    } finally { setPreviewing(false); }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await pricingRulesApi.remove(rule.id);
      setConfirmDelete(false);
      onDeleted?.();
    } catch (e) {
      setConfirmDelete(false);
      toast.error(apiErrorMessage(e, t('unableDeletePricingRulePlease')));
    } finally { setDeleting(false); }
  }

  async function onSubmit(v) {
    const payload = {
      name: v.name,
      code: v.code,
      description: v.description || '',
      is_active: !!v.is_active,
      priority: Number(v.priority) || 0,
      display_order: Number(v.display_order) || 0,
      rule_type: v.rule_type,
      adjustment_type: v.adjustment_type,
      adjustment_value: Number(v.adjustment_value) || 0,
      currency: v.currency || '',
      tax_applicable: !!v.tax_applicable,
      allow_stacking: !!v.allow_stacking,
      categories: catIds,
      facility_types: pkgIds,
      addons: addIds,
      clubs: clubIds,
      membership_plans: planIds,
      customer_types: cTypes,
      days_of_week: days,
      valid_from: v.valid_from || null,
      valid_to: v.valid_to || null,
      start_time: v.start_time || null,
      end_time: v.end_time || null,
      min_amount: v.min_amount === '' ? null : Number(v.min_amount),
      min_quantity: v.min_quantity === '' ? null : Number(v.min_quantity),
    };
    try {
      if (isEdit) await pricingRulesApi.update(rule.id, payload);
      else await pricingRulesApi.create(payload);
      onSaved?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data, 'Unable to save the pricing rule. Please try again.'));
    }
  }

  return (
    <>
    <Modal open={open} onClose={onClose} size="lg"
      title={isEdit ? `Edit ${rule.name}` : 'New pricing rule'}
      footer={
        <>
          {isEdit && (
            <button className="btn btn-danger" type="button" onClick={() => setConfirmDelete(true)}
                    style={{ marginRight: 'auto' }}>
              <Trash2 size={15} /> {t('common:actions.delete')}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose} type="button">{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
            {isSubmitting ? t('common:state.saving') : t('saveRule')}
          </button>
        </>
      }
    >
      <SectionTitle>{t('basicInformation')}</SectionTitle>
      <div className="row">
        <div className="col">
          <FormField label={t('ruleName')} error={errors.name?.message}>
            <input className="form-input" {...(() => {
              const f = register('name', { required: 'Name is required' });
              return {
                ...f,
                onChange: (e) => {
                  f.onChange(e);
                  // Auto-suggest the code from the name until the operator edits it.
                  if (!codeEdited) setValue('code', genRuleCode(e.target.value));
                },
              };
            })()} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('ruleCode')} hint={t('autoFilledNameEditIf')} error={errors.code?.message}>
            <input className="form-input" {...(() => {
              const f = register('code', { required: 'Code is required' });
              return {
                ...f,
                onChange: (e) => { f.onChange(e); setCodeEdited(true); },
              };
            })()} />
          </FormField>
        </div>
      </div>
      <FormField label={t('description')}>
        <textarea className="form-textarea" rows={2} {...register('description')} />
      </FormField>
      <div className="row">
        <div className="col">
          <FormField label={t('priority')} hint={t('lowerNumberHigherPriority')} error={errors.priority?.message}>
            <input className="form-input" type="number" min="0"
                   {...register('priority', { required: 'Required', min: { value: 0, message: '0 or more' } })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('displayOrder')}>
            <input className="form-input" type="number" min="0" {...register('display_order')} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('ruleType')} error={errors.rule_type?.message}>
            <Controller name="rule_type" control={control} rules={{ required: 'Select a rule type' }}
              render={({ field }) => (
                <Select2 options={ruleTypes(t)} value={field.value} onChange={field.onChange}
                         placeholder={t('selectRuleType')} error={errors.rule_type?.message} />
              )} />
          </FormField>
        </div>
      </div>

      <SectionTitle>{t('applyRule')}</SectionTitle>
      <div className="row">
        <div className="col">
          <FormField label={t('facilityCategories')}>
            <Select2 multiple placeholder={t('allCategories')}
              options={cats.map((c) => ({ value: c.id, label: c.name }))}
              value={catIds} onChange={setCatIds} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('specificFacilityTypes')}>
            <Select2 multiple placeholder={t('allFacilityTypes')}
              options={pkgs.map((p) => ({ value: p.id, label: p.name }))}
              value={pkgIds} onChange={setPkgIds} />
          </FormField>
        </div>
      </div>
      <FormField label={t('addOns')}>
        <Select2 multiple placeholder={t('noAddOns')}
          options={adds.map((a) => ({ value: a.id, label: a.name }))}
          value={addIds} onChange={setAddIds} />
      </FormField>

      <SectionTitle>{t('conditions')}</SectionTitle>
      {showFor('club', ruleType) && (
        <FormField label={t('clubs2')}>
          <Select2 multiple placeholder={t('anyClub')}
            options={clubs.map((b) => ({ value: b.id, label: b.name }))}
            value={clubIds} onChange={setClubIds} />
        </FormField>
      )}
      {showFor('membership', ruleType) && (
        <div className="row">
          <div className="col">
            <FormField label={t('customerTypes')}>
              <Select2 multiple placeholder={t('anyCustomerType')}
                options={customerTypes(t)} value={cTypes} onChange={setCTypes} />
            </FormField>
          </div>
          <div className="col">
            <FormField label={t('membershipPlans')}>
              <Select2 multiple placeholder={t('anyPlan')}
                options={plans.map((p) => ({ value: p.id, label: p.name }))}
                value={planIds} onChange={setPlanIds} />
            </FormField>
          </div>
        </div>
      )}
      <div className="row">
        <div className="col">
          <FormField label={t('minimumAmount')}>
            <input className="form-input" type="number" min="0" step="0.01" {...register('min_amount')} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('minimumQuantity')}>
            <input className="form-input" type="number" min="0" {...register('min_quantity')} />
          </FormField>
        </div>
      </div>

      <SectionTitle>{t('adjustment')}</SectionTitle>
      <div className="row">
        <div className="col">
          <FormField label={t('adjustmentType')} error={errors.adjustment_type?.message}>
            <Controller name="adjustment_type" control={control} rules={{ required: 'Required' }}
              render={({ field }) => (
                <Select2 options={adjustmentTypes(t)} value={field.value} onChange={field.onChange}
                         placeholder={t('select')} error={errors.adjustment_type?.message} />
              )} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={isPercent ? t('adjustmentValue') : t('adjustmentValue2')} error={errors.adjustment_value?.message}>
            <input className="form-input" type="number" min="0" max={isPercent ? 100 : undefined} step="0.01"
                   {...register('adjustment_value', {
                     required: 'Required',
                     validate: (v) => {
                       const n = Number(v);
                       if (!(n > 0)) return 'Enter a value greater than 0';
                       if (isPercent && n > 100) return 'Percentage cannot exceed 100%';
                       return true;
                     },
                   })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('common:labels.currency')}>
            <Controller name="currency" control={control} render={({ field }) => (
              <Select2 options={CURRENCY_OPTIONS} value={field.value} onChange={field.onChange}
                       placeholder={t('systemDefault')} clearable />
            )} />
          </FormField>
        </div>
      </div>
      <div className="toggle-grid">
        <Toggle label={t('taxVatApplicable')} description={t('applyTaxAdjustedPrice')} {...register('tax_applicable')} />
        <Toggle label={t('allowStacking')} description={t('letOtherRulesAlsoApply')} {...register('allow_stacking')} />
        <Toggle label={t('common:state.active')} description={t('ruleEffect')} {...register('is_active')} />
      </div>

      <SectionTitle>{t('validity')}</SectionTitle>
      <div className="row">
        <div className="col">
          <FormField label={t('valid')} error={errors.valid_from?.message}>
            <input className="form-input" type="date"
                   {...register('valid_from', { required: 'Valid From is required' })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('valid2')} error={errors.valid_to?.message}>
            <input className="form-input" type="date"
                   {...register('valid_to', { required: 'Valid To is required' })} />
          </FormField>
        </div>
      </div>
      {showFor('days', ruleType) && (
        <FormField label={t('activeDays')}>
          <Select2 multiple placeholder={t('anyDay')}
            options={daysOfWeek(t)} value={days} onChange={setDays} />
        </FormField>
      )}
      {showFor('time', ruleType) && (
        <div className="row">
          <div className="col">
            <FormField label={t('startTime')} error={errors.start_time?.message}>
              <Controller name="start_time" control={control}
                render={({ field }) => <TimeInput value={field.value || ''} onChange={field.onChange} />} />
            </FormField>
          </div>
          <div className="col">
            <FormField label={t('endTime')} error={errors.end_time?.message}>
              <Controller name="end_time" control={control}
                render={({ field }) => <TimeInput value={field.value || ''} onChange={field.onChange} />} />
            </FormField>
          </div>
        </div>
      )}
      {!showFor('days', ruleType) && !showFor('time', ruleType) && (
        <p className="muted" style={{ fontSize: 13 }}>{t('ruleTypeHasNoDay')}</p>
      )}

      <SectionTitle>{t('calculationPreview')}</SectionTitle>
      <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: 14, background: '#fafbfd' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ width: 160 }}>
            <FormField label={t('basePrice')}>
              <input className="form-input" type="number" min="0" step="0.01"
                     value={previewBase} onChange={(e) => setPreviewBase(e.target.value)} />
            </FormField>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={runPreview} disabled={previewing}
                  style={{ marginBottom: 11 }}>
            {previewing ? t('calculating') : t('preview')}
          </button>
        </div>
        {preview && (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13.5 }}>
            <span className="muted">{t('base')} <strong style={{ color: 'var(--color-text)' }}><Money amount={preview.base_price} code={preview.currency} /></strong></span>
            <span className="muted">{t('adjustment2')} <strong style={{ color: 'var(--color-text)' }}>{preview.adjustment_label}</strong></span>
            <span className="muted">{t('final')} <strong style={{ color: 'var(--color-primary-600)' }}><Money amount={preview.final_price} code={preview.currency} /></strong></span>
          </div>
        )}
      </div>
    </Modal>

    <ConfirmDialog
      open={confirmDelete}
      tone="danger"
      title={t('deletePricingRule')}
      message={<><strong>{rule?.name}</strong> will be permanently removed.</>}
      confirmLabel={t('common:actions.delete')}
      busy={deleting}
      onConfirm={handleDelete}
      onClose={() => setConfirmDelete(false)}
    />
    </>
  );
}
