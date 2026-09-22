import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2, Layers, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { RowMenu } from '../../components/RowMenu.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { CURRENCY_OPTIONS, CurrencySymbol, Money } from '../../services/currency.jsx';
import { promoCodesApi, discountTypes, PROMO_STATUS_TONE } from '../../services/promotionsService.js';
import { facilityCategoriesApi, facilityTypesApi, addonsApi } from '../../services/facilitiesService.js';

const scopeOptions = (t) => [
  { value: 'all', label: t('allServicesAddOns') },
  { value: 'category', label: t('specificCategories') },
  { value: 'package', label: t('specificServices') },
  { value: 'addon', label: t('specificAddOns') },
];

const statusOptions = (t) => [
  { value: 'true', label: t('common:state.active') },
  { value: 'false', label: t('common:state.inactive') },
];

const EMPTY = {
  code: '', description: '',
  discount_type: 'percent', discount_value: '', max_discount_amount: '', min_order_amount: '',
  currency: '', valid_from: '', valid_to: '',
  usage_limit: '', usage_limit_per_customer: '',
  first_order_only: false, is_active: true,
  applies_to: 'all', categories: [], services: [], addons: [],
};

const num = (v) => (v === '' || v == null ? null : Number(v));

const SCOPE_KEY = { category: 'categories', package: 'services', addon: 'addons' };
const SCOPE_NOUN = { category: 'category', package: 'service', addon: 'add-on' };

// Returns an error string if the chosen scope has no selection, else null.
function scopeError(f) {
  if (f.applies_to === 'all') return null;
  const list = f[SCOPE_KEY[f.applies_to]] || [];
  return list.length ? null : `Select at least one ${SCOPE_NOUN[f.applies_to]} for the chosen scope.`;
}

function buildPayload(f) {
  return {
    description: f.description || '',
    discount_type: f.discount_type,
    discount_value: Number(f.discount_value) || 0,
    max_discount_amount: f.discount_type === 'percent' ? num(f.max_discount_amount) : null,
    min_order_amount: Number(f.min_order_amount) || 0,
    currency: f.discount_type === 'fixed' ? (f.currency || '') : '',
    valid_from: f.valid_from || null,
    valid_to: f.valid_to || null,
    usage_limit: num(f.usage_limit),
    usage_limit_per_customer: num(f.usage_limit_per_customer),
    first_order_only: !!f.first_order_only,
    is_active: !!f.is_active,
    applies_to: f.applies_to || 'all',
    categories: f.applies_to === 'category' ? (f.categories || []) : [],
    services: f.applies_to === 'package' ? (f.services || []) : [],
    addons: f.applies_to === 'addon' ? (f.addons || []) : [],
  };
}

const apiErr = (e, fb) =>
  (e.response?.data && typeof e.response.data === 'object'
    ? Object.entries(e.response.data).map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`).join(' · ')
    : null) || e.response?.data?.detail || fb;

const discountLabel = (p) => (p.discount_type === 'percent'
  ? `${Number(p.discount_value)}%`
  : <Money amount={p.discount_value} code={p.currency || undefined} />);

const GROUP_KEYS = [
  ['discount_type', 'groups.discountType'],
  ['is_active', 'groups.status'],
];

export default function PromoCodesPage() {
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editPromo, setEditPromo] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState('');

  const fetcher = useCallback((q) => promoCodesApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const { t } = useTranslation('promotions');
  const { t: tc } = useTranslation('common');
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  async function runDelete() {
    setDelBusy(true); setDelErr('');
    try {
      await promoCodesApi.remove(toDelete.id);
      setToDelete(null); toast.success(t('actions.deleted')); reload();
    } catch (e) { setDelErr(apiErr(e, t('delete.failed'))); }
    finally { setDelBusy(false); }
  }

  const columns = useMemo(() => [
    { key: 'code', header: t('columns.code'), sortKey: 'code', minWidth: 150,
      alwaysVisible: true,
      render: (p) => (
        <div>
          <span className="link-btn" style={{ fontWeight: 700, letterSpacing: '.02em', fontFamily: 'var(--font-mono, monospace)' }}>
            {p.code}
          </span>
          {p.batch && <div className="muted" style={{ fontSize: 11 }}>{t('batch', { name: p.batch })}</div>}
        </div>
      ) },
    { key: 'discount', header: t('columns.discount'), minWidth: 120, render: discountLabel },
    { key: 'min', header: t('columns.minOrder'), align: 'right', minWidth: 110,
      priority: 'low',
      render: (p) => (Number(p.min_order_amount) > 0
        ? <Money amount={p.min_order_amount} code={p.currency || undefined} /> : '-') },
    { key: 'validity', header: t('columns.validity'), nowrap: true, minWidth: 180,
      priority: 'medium',
      render: (p) => (p.valid_from || p.valid_to
        ? t('validityRange', { from: p.valid_from || '...', to: p.valid_to || '...' })
        : <span className="muted">{t('always')}</span>) },
    { key: 'usage', header: t('columns.usage'), minWidth: 130, nowrap: true,
      render: (p) => (p.usage_limit == null
        ? <span>{p.used_count} <span className="muted">/ {t('unlimited')}</span></span>
        : (
          <span>
            {p.used_count} / {p.usage_limit}{' '}
            <span className="muted">
              {t('remaining', { count: p.remaining ?? Math.max(0, p.usage_limit - p.used_count) })}
            </span>
          </span>
        )) },
    { key: 'status', header: t('columns.status'), minWidth: 110,
      render: (p) => <StatusBadge tone={PROMO_STATUS_TONE[p.status] || 'muted'} label={p.status} /> },
  ], [t]);

  const groupOptions = useMemo(
    () => GROUP_KEYS.map(([key, k]) => ({ key, label: t(k) })), [t]);

  const filters = useMemo(() => [
    { key: 'is_active', label: t('filters.status'), type: 'select', options: statusOptions(t) },
    { key: 'discount_type', label: t('filters.discountType'), type: 'select', options: discountTypes(t) },
  ], [t]);

  const rowActions = useCallback((row) => [
    { key: 'view', label: tc('actions.view'), icon: <Eye size={14} />,
      onClick: () => navigate(`/promo-codes/${row.id}`) },
    { key: 'edit', label: tc('actions.edit'), icon: <Pencil size={14} />,
      onClick: () => setEditPromo(row) },
    { key: 'delete', label: tc('actions.delete'), icon: <Trash2 size={14} />, danger: true,
      onClick: () => { setDelErr(''); setToDelete(row); } },
  ], [navigate]);

  return (
    <ListPage
      title={t('title')}
      subtitle={t('createSingleBulkDiscountCodes')}
      actions={hasPerm('promotions.add') ? (<>
        <button className="btn btn-secondary" onClick={() => setBulkOpen(true)}><Layers size={15} /> {t('bulkGenerate')}</button>
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus size={15} /> {t('newPromoCode')}</button>
      </>) : null}
    >
      <ListView
        tableKey="promo-codes"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="-created_at"
        searchPlaceholder={t('searchPlaceholder')}
        emptyTitle={t('emptyTitle')}
        emptyHint={t('emptyHint')}
        onRowClick={(p) => navigate(`/promo-codes/${p.id}`)}
        columns={columns}
        filters={filters}
        groupOptions={groupOptions}
        rowActions={rowActions}
      />

      <PromoFormModal open={createOpen} onClose={() => setCreateOpen(false)}
        onSaved={() => { setCreateOpen(false); toast.success(t('actions.created')); reload(); }} />
      <PromoFormModal open={Boolean(editPromo)} promo={editPromo} onClose={() => setEditPromo(null)}
        onSaved={() => { setEditPromo(null); toast.success(t('actions.updated')); reload(); }} />
      <BulkPromoModal open={bulkOpen} onClose={() => setBulkOpen(false)}
        onSaved={(n) => { setBulkOpen(false); toast.success(t('actions.generated', { count: n })); reload(); }} />

      <ConfirmDialog
        open={Boolean(toDelete)} busy={delBusy} tone="danger" title={t('deletePromoCode')} confirmLabel={t('common:actions.delete')}
        message={toDelete ? (<>{t('common:actions.delete')} <strong>{toDelete.code}</strong>? Used codes can’t be deleted - deactivate them instead.
          {delErr && <div style={{ marginTop: 10, color: '#dc2626', fontSize: 13 }}>{delErr}</div>}</>) : null}
        onConfirm={runDelete}
        onClose={() => { if (!delBusy) { setToDelete(null); setDelErr(''); } }}
      />
    </ListPage>
  );
}

/* Shared discount / validity / usage / flags - used by single + bulk modals. */
function PromoSettings({ form, set }) {
  const { t } = useTranslation('promotions');
  const isPercent = form.discount_type === 'percent';
  const today = new Date().toISOString().slice(0, 10);
  const [categoryOpts, setCategoryOpts] = useState([]);
  const [serviceOpts, setServiceOpts] = useState([]);
  const [addonOpts, setAddonOpts] = useState([]);
  useEffect(() => {
    const toOpts = (d) => (d.results || d).map((x) => ({ value: x.id, label: x.name }));
    facilityCategoriesApi.list({ page_size: 200 }).then((d) => setCategoryOpts(toOpts(d))).catch(() => {});
    facilityTypesApi.list({ page_size: 200 }).then((d) => setServiceOpts(toOpts(d))).catch(() => {});
    addonsApi.list({ page_size: 200 }).then((d) => setAddonOpts(toOpts(d))).catch(() => {});
  }, []);

  const scope = {
    category: { opts: categoryOpts, key: 'categories', label: t('categories') },
    package: { opts: serviceOpts, key: 'services', label: t('services') },
    addon: { opts: addonOpts, key: 'addons', label: t('addOns') },
  }[form.applies_to];

  return (
    <>
      <div className="modal-section">{t('discount')}</div>
      <div className="row">
        <div className="col"><FormField label={t('discountType')}>
          <Select2 options={discountTypes(t)} value={form.discount_type} onChange={(v) => set('discount_type', v)} />
        </FormField></div>
        <div className="col"><FormField label={isPercent ? t('discountValue') : t('discountValue2')}>
          <div style={{ position: 'relative' }}>
            {!isPercent && <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)', fontSize: 13 }}><CurrencySymbol code={form.currency || undefined} /></span>}
            <input className="form-input" type="number" min="0" max={isPercent ? 100 : undefined} step="0.01"
              style={!isPercent ? { paddingLeft: 30 } : undefined}
              value={form.discount_value} onChange={(e) => set('discount_value', e.target.value)} />
          </div>
        </FormField></div>
      </div>
      <div className="row">
        {isPercent && (
          <div className="col"><FormField label={t('maxDiscountCap')} hint={t('optionalCapsDiscount')}>
            <input className="form-input" type="number" min="0" step="0.01"
              value={form.max_discount_amount} onChange={(e) => set('max_discount_amount', e.target.value)} />
          </FormField></div>
        )}
        <div className="col"><FormField label={t('minimumOrderAmount')}>
          <input className="form-input" type="number" min="0" step="0.01"
            value={form.min_order_amount} onChange={(e) => set('min_order_amount', e.target.value)} />
        </FormField></div>
        {!isPercent && (
          <div className="col"><FormField label={t('common:labels.currency')} hint={t('blankSystemDefault')}>
            <Select2 options={CURRENCY_OPTIONS} value={form.currency} onChange={(v) => set('currency', v)} placeholder={t('systemDefault')} clearable />
          </FormField></div>
        )}
      </div>

      <div className="modal-section">{t('validity')}</div>
      <div className="row">
        <div className="col"><FormField label={t('valid')}>
          <input className="form-input" type="date" min={today} value={form.valid_from}
            onChange={(e) => {
              const v = e.target.value;
              set('valid_from', v);
              if (form.valid_to && form.valid_to < v) set('valid_to', v);   // keep To on/after From
            }} />
        </FormField></div>
        <div className="col"><FormField label={t('valid2')}>
          <input className="form-input" type="date" min={form.valid_from || today} value={form.valid_to}
            onChange={(e) => set('valid_to', e.target.value)} />
        </FormField></div>
      </div>

      <div className="modal-section">{t('usageLimits')}</div>
      <div className="row">
        <div className="col"><FormField label={t('totalUsageLimit')} hint={t('blankUnlimited')}>
          <input className="form-input" type="number" min="1" value={form.usage_limit} onChange={(e) => set('usage_limit', e.target.value)} />
        </FormField></div>
        <div className="col"><FormField label={t('perCustomerLimit')} hint={t('blankUnlimited')}>
          <input className="form-input" type="number" min="1" value={form.usage_limit_per_customer} onChange={(e) => set('usage_limit_per_customer', e.target.value)} />
        </FormField></div>
      </div>

      <div className="modal-section">{t('discountCodeApplies')}</div>
      <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden' }}>
        {scopeOptions(t).map((o, i) => {
          const active = form.applies_to === o.value;
          return (
            <label key={o.value} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer',
              borderTop: i ? '1px solid var(--color-border-soft, #eef0f4)' : 'none',
              background: active ? 'rgba(99,102,241,0.07)' : '#fff',
              fontWeight: 600, fontSize: 13.5,
              color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
            }}>
              <input type="radio" name="applies_to" checked={active} onChange={() => set('applies_to', o.value)} />
              {o.label}
            </label>
          );
        })}
      </div>
      {scope && (
        <div style={{ marginTop: 12 }}>
          <FormField
            label={`Select ${scope.label} *`}
            error={(form[scope.key] || []).length === 0 ? `Select at least one ${scope.label.toLowerCase()}.` : undefined}
          >
            <Select2 multiple options={scope.opts} value={form[scope.key]} onChange={(v) => set(scope.key, v)}
              placeholder={t('chooseOneMore')} emptyText={`No ${scope.label.toLowerCase()} found.`} />
          </FormField>
        </div>
      )}

      <div className="modal-section">{t('options')}</div>
      <div className="toggle-grid toggle-grid--2">
        <Toggle label={t('firstOrderOnly')} description={t('newCustomersOnly')}
          checked={!!form.first_order_only} onChange={(e) => set('first_order_only', e.target.checked)} />
        <Toggle label={t('common:state.active')} description={t('codeCanRedeemed')}
          checked={!!form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
      </div>
    </>
  );
}

function PromoFormModal({ open, promo, onClose, onSaved }) {
  const { t } = useTranslation('promotions');
  const editing = Boolean(promo);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!open) return;
    setForm(promo ? {
      ...EMPTY, ...promo,
      discount_value: promo.discount_value ?? '',
      max_discount_amount: promo.max_discount_amount ?? '',
      min_order_amount: promo.min_order_amount ?? '',
      usage_limit: promo.usage_limit ?? '',
      usage_limit_per_customer: promo.usage_limit_per_customer ?? '',
      valid_from: promo.valid_from || '', valid_to: promo.valid_to || '',
      currency: promo.currency || '',
    } : EMPTY);
  }, [open, promo]);

  async function submit() {
    if (!form.code.trim()) { toast.error(t('codeRequired')); return; }
    if (!(Number(form.discount_value) > 0)) { toast.error(t('discountValueMustGreaterThan')); return; }
    if (form.valid_from && form.valid_to && form.valid_to < form.valid_from) {
      toast.error(t('validMustAfterValid')); return;
    }
    const se = scopeError(form);
    if (se) { toast.error(se); return; }
    setBusy(true);
    try {
      const payload = { code: form.code.trim(), ...buildPayload(form) };
      if (editing) await promoCodesApi.update(promo.id, payload);
      else await promoCodesApi.create(payload);
      onSaved?.();
    } catch (e) { toast.error(apiErr(e, 'Unable to save the promo code. Please try again.')); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? t('editPromoCode') : t('newPromoCode')} side size="lg"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : (editing ? t('update') : t('common:actions.create'))}</button>
      </>}>
      <div className="row">
        <div className="col"><FormField label={t('code')} hint={t('storedUppercaseEGWelcome10')}>
          <input className="form-input" value={form.code} onChange={(e) => set('code', e.target.value)} />
        </FormField></div>
        <div className="col"><FormField label={t('description')}>
          <input className="form-input" value={form.description} onChange={(e) => set('description', e.target.value)} />
        </FormField></div>
      </div>
      <PromoSettings form={form} set={set} />
    </Modal>
  );
}

function BulkPromoModal({ open, onClose, onSaved }) {
  const { t } = useTranslation('promotions');
  const [form, setForm] = useState({ ...EMPTY, quantity: 10, prefix: '', code_length: 6 });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => { if (open) setForm({ ...EMPTY, quantity: 10, prefix: '', code_length: 6 }); }, [open]);

  async function submit() {
    if (!(Number(form.quantity) > 0)) { toast.error(t('quantityMustLeast1')); return; }
    if (!(Number(form.discount_value) > 0)) { toast.error(t('discountValueMustGreaterThan')); return; }
    if (form.valid_from && form.valid_to && form.valid_to < form.valid_from) {
      toast.error(t('validMustAfterValid')); return;
    }
    const se = scopeError(form);
    if (se) { toast.error(se); return; }
    setBusy(true);
    try {
      const rows = await promoCodesApi.bulkGenerate({
        quantity: Number(form.quantity), prefix: form.prefix || '', code_length: Number(form.code_length) || 6,
        ...buildPayload(form),
      });
      onSaved?.(rows.length);
    } catch (e) { toast.error(apiErr(e, 'Unable to generate the codes. Please try again.')); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('bulkGeneratePromoCodes')} side size="lg"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? t('generating') : t('generate')}</button>
      </>}>
      <div className="row">
        <div className="col"><FormField label={t('quantity')} hint="Up to 1000.">
          <input className="form-input" type="number" min="1" max="1000" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} />
        </FormField></div>
        <div className="col"><FormField label={t('prefix')} hint={t('optionalEGSummerSummer')}>
          <input className="form-input" value={form.prefix} onChange={(e) => set('prefix', e.target.value)} />
        </FormField></div>
        <div className="col"><FormField label={t('randomLength')} hint="4-16 characters.">
          <input className="form-input" type="number" min="4" max="16" value={form.code_length} onChange={(e) => set('code_length', e.target.value)} />
        </FormField></div>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: '2px 0 4px' }}>{t('allGeneratedCodesShareSettings')}</p>
      <PromoSettings form={form} set={set} />
    </Modal>
  );
}
