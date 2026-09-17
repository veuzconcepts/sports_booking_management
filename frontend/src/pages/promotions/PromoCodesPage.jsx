import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2, Layers } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toolbar } from '../../components/Toolbar.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { RowMenu } from '../../components/RowMenu.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { CURRENCY_OPTIONS, CurrencySymbol, Money } from '../../services/currency.jsx';
import { promoCodesApi, DISCOUNT_TYPES, PROMO_STATUS_TONE } from '../../services/promotionsService.js';
import { facilityCategoriesApi, facilityTypesApi, addonsApi } from '../../services/facilitiesService.js';

const SCOPE_OPTIONS = [
  { value: 'all', label: 'All services & add-ons' },
  { value: 'category', label: 'Specific Categories' },
  { value: 'package', label: 'Specific Services' },
  { value: 'addon', label: 'Specific Add-ons' },
];

const STATUS_OPTIONS = [
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
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
  const { rows, loading, count, query, setQuery, reload } = useApiList(fetcher);

  const [search, setSearch] = useState(query.search || '');
  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => ({ ...q, search: search || undefined, page: 1 })), 350);
    return () => clearTimeout(t);
  }, [search, setQuery]);

  async function runDelete() {
    setDelBusy(true); setDelErr('');
    try {
      await promoCodesApi.remove(toDelete.id);
      setToDelete(null); toast.success('Promo code deleted'); reload();
    } catch (e) { setDelErr(apiErr(e, 'Unable to delete the promo code. Please try again.')); }
    finally { setDelBusy(false); }
  }

  return (
    <>
      <PageHeader
        title="Promo Codes"
        subtitle="Create single or bulk discount codes with limits and validity."
        actions={hasPerm('promotions.add') ? (<>
          <button className="btn btn-secondary" onClick={() => setBulkOpen(true)}><Layers size={15} /> Bulk generate</button>
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus size={15} /> New promo code</button>
        </>) : null}
      />

      <Toolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Code, description, batch…"
        filters={[
          { value: query.is_active, options: STATUS_OPTIONS, placeholder: 'All statuses',
            onChange: (v) => setQuery({ ...query, is_active: v, page: 1 }) },
          { value: query.discount_type, options: DISCOUNT_TYPES, placeholder: 'All types',
            onChange: (v) => setQuery({ ...query, discount_type: v, page: 1 }) },
        ]}
      />

      <DataTable
        loading={loading}
        rows={rows}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        onRowClick={(p) => navigate(`/promo-codes/${p.id}`)}
        emptyTitle="No promo codes"
        emptyHint="Create a code or generate a batch to get started."
        columns={[
          { key: 'code', header: 'Code', render: (p) => (
            <div>
              <button className="link-btn" style={{ fontWeight: 700, letterSpacing: '.02em', fontFamily: 'var(--font-mono, monospace)' }}
                onClick={(e) => { e.stopPropagation(); navigate(`/promo-codes/${p.id}`); }}>{p.code}</button>
              {p.batch && <div className="muted" style={{ fontSize: 11 }}>batch {p.batch}</div>}
            </div>
          ) },
          { key: 'discount', header: 'Discount', render: discountLabel },
          { key: 'min', header: 'Min order', render: (p) => (Number(p.min_order_amount) > 0 ? <Money amount={p.min_order_amount} code={p.currency || undefined} /> : '-') },
          { key: 'validity', header: 'Validity', nowrap: true, render: (p) => (
            p.valid_from || p.valid_to ? `${p.valid_from || '…'} → ${p.valid_to || '…'}` : <span className="muted">Always</span>
          ) },
          { key: 'usage', header: 'Usage', render: (p) => (
            p.usage_limit == null
              ? <span>{p.used_count} <span className="muted">/ ∞</span></span>
              : <span>{p.used_count} / {p.usage_limit} <span className="muted">({p.remaining ?? Math.max(0, p.usage_limit - p.used_count)} left)</span></span>
          ) },
          { key: 'status', header: 'Status', render: (p) => <StatusBadge tone={PROMO_STATUS_TONE[p.status] || 'muted'} label={p.status} /> },
          { key: 'actions', header: '', align: 'right', sticky: 'right', render: (p) => (
            <div style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn" title="Edit" onClick={() => setEditPromo(p)}><Pencil size={15} /></button>
              <RowMenu items={[{ key: 'del', label: 'Delete', icon: <Trash2 size={15} />, danger: true,
                onClick: () => { setDelErr(''); setToDelete(p); } }]} />
            </div>
          ) },
        ]}
      />

      <PromoFormModal open={createOpen} onClose={() => setCreateOpen(false)}
        onSaved={() => { setCreateOpen(false); toast.success('Promo code created'); reload(); }} />
      <PromoFormModal open={Boolean(editPromo)} promo={editPromo} onClose={() => setEditPromo(null)}
        onSaved={() => { setEditPromo(null); toast.success('Promo code updated'); reload(); }} />
      <BulkPromoModal open={bulkOpen} onClose={() => setBulkOpen(false)}
        onSaved={(n) => { setBulkOpen(false); toast.success(`${n} promo codes generated`); reload(); }} />

      <ConfirmDialog
        open={Boolean(toDelete)} busy={delBusy} tone="danger" title="Delete promo code?" confirmLabel="Delete"
        message={toDelete ? (<>Delete <strong>{toDelete.code}</strong>? Used codes can’t be deleted - deactivate them instead.
          {delErr && <div style={{ marginTop: 10, color: '#dc2626', fontSize: 13 }}>{delErr}</div>}</>) : null}
        onConfirm={runDelete}
        onClose={() => { if (!delBusy) { setToDelete(null); setDelErr(''); } }}
      />
    </>
  );
}

/* Shared discount / validity / usage / flags - used by single + bulk modals. */
function PromoSettings({ form, set }) {
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
    category: { opts: categoryOpts, key: 'categories', label: 'Categories' },
    package: { opts: serviceOpts, key: 'services', label: 'Services' },
    addon: { opts: addonOpts, key: 'addons', label: 'Add-ons' },
  }[form.applies_to];

  return (
    <>
      <div className="modal-section">Discount</div>
      <div className="row">
        <div className="col"><FormField label="Discount Type">
          <Select2 options={DISCOUNT_TYPES} value={form.discount_type} onChange={(v) => set('discount_type', v)} />
        </FormField></div>
        <div className="col"><FormField label={isPercent ? 'Discount Value (%)' : 'Discount Value'}>
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
          <div className="col"><FormField label="Max Discount (Cap)" hint="Optional - caps a % discount.">
            <input className="form-input" type="number" min="0" step="0.01"
              value={form.max_discount_amount} onChange={(e) => set('max_discount_amount', e.target.value)} />
          </FormField></div>
        )}
        <div className="col"><FormField label="Minimum Order Amount">
          <input className="form-input" type="number" min="0" step="0.01"
            value={form.min_order_amount} onChange={(e) => set('min_order_amount', e.target.value)} />
        </FormField></div>
        {!isPercent && (
          <div className="col"><FormField label="Currency" hint="Blank = system default.">
            <Select2 options={CURRENCY_OPTIONS} value={form.currency} onChange={(v) => set('currency', v)} placeholder="System default" clearable />
          </FormField></div>
        )}
      </div>

      <div className="modal-section">Validity</div>
      <div className="row">
        <div className="col"><FormField label="Valid From">
          <input className="form-input" type="date" min={today} value={form.valid_from}
            onChange={(e) => {
              const v = e.target.value;
              set('valid_from', v);
              if (form.valid_to && form.valid_to < v) set('valid_to', v);   // keep To on/after From
            }} />
        </FormField></div>
        <div className="col"><FormField label="Valid To">
          <input className="form-input" type="date" min={form.valid_from || today} value={form.valid_to}
            onChange={(e) => set('valid_to', e.target.value)} />
        </FormField></div>
      </div>

      <div className="modal-section">Usage Limits</div>
      <div className="row">
        <div className="col"><FormField label="Total Usage Limit" hint="Blank = unlimited.">
          <input className="form-input" type="number" min="1" value={form.usage_limit} onChange={(e) => set('usage_limit', e.target.value)} />
        </FormField></div>
        <div className="col"><FormField label="Per-Customer Limit" hint="Blank = unlimited.">
          <input className="form-input" type="number" min="1" value={form.usage_limit_per_customer} onChange={(e) => set('usage_limit_per_customer', e.target.value)} />
        </FormField></div>
      </div>

      <div className="modal-section">Discount Code Applies To</div>
      <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden' }}>
        {SCOPE_OPTIONS.map((o, i) => {
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
              placeholder="Choose one or more…" emptyText={`No ${scope.label.toLowerCase()} found.`} />
          </FormField>
        </div>
      )}

      <div className="modal-section">Options</div>
      <div className="toggle-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <Toggle label="First Order Only" description="New customers only"
          checked={!!form.first_order_only} onChange={(e) => set('first_order_only', e.target.checked)} />
        <Toggle label="Active" description="Code can be redeemed"
          checked={!!form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
      </div>
    </>
  );
}

function PromoFormModal({ open, promo, onClose, onSaved }) {
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
    if (!form.code.trim()) { toast.error('Code is required.'); return; }
    if (!(Number(form.discount_value) > 0)) { toast.error('Discount value must be greater than 0.'); return; }
    if (form.valid_from && form.valid_to && form.valid_to < form.valid_from) {
      toast.error('Valid To must be on or after Valid From.'); return;
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
    <Modal open={open} onClose={onClose} title={editing ? 'Edit promo code' : 'New promo code'} size="lg"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : (editing ? 'Update' : 'Create')}</button>
      </>}>
      <div className="row">
        <div className="col"><FormField label="Code *" hint="Stored in uppercase, e.g. WELCOME10.">
          <input className="form-input" value={form.code} onChange={(e) => set('code', e.target.value)} />
        </FormField></div>
        <div className="col"><FormField label="Description">
          <input className="form-input" value={form.description} onChange={(e) => set('description', e.target.value)} />
        </FormField></div>
      </div>
      <PromoSettings form={form} set={set} />
    </Modal>
  );
}

function BulkPromoModal({ open, onClose, onSaved }) {
  const [form, setForm] = useState({ ...EMPTY, quantity: 10, prefix: '', code_length: 6 });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => { if (open) setForm({ ...EMPTY, quantity: 10, prefix: '', code_length: 6 }); }, [open]);

  async function submit() {
    if (!(Number(form.quantity) > 0)) { toast.error('Quantity must be at least 1.'); return; }
    if (!(Number(form.discount_value) > 0)) { toast.error('Discount value must be greater than 0.'); return; }
    if (form.valid_from && form.valid_to && form.valid_to < form.valid_from) {
      toast.error('Valid To must be on or after Valid From.'); return;
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
    <Modal open={open} onClose={onClose} title="Bulk generate promo codes" size="lg"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Generating…' : 'Generate'}</button>
      </>}>
      <div className="row">
        <div className="col"><FormField label="Quantity *" hint="Up to 1000.">
          <input className="form-input" type="number" min="1" max="1000" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} />
        </FormField></div>
        <div className="col"><FormField label="Prefix" hint="Optional, e.g. SUMMER → SUMMER-AB12CD.">
          <input className="form-input" value={form.prefix} onChange={(e) => set('prefix', e.target.value)} />
        </FormField></div>
        <div className="col"><FormField label="Random Length" hint="4-16 characters.">
          <input className="form-input" type="number" min="4" max="16" value={form.code_length} onChange={(e) => set('code_length', e.target.value)} />
        </FormField></div>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: '2px 0 4px' }}>All generated codes share the settings below.</p>
      <PromoSettings form={form} set={set} />
    </Modal>
  );
}
