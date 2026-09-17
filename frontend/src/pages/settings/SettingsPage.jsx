import { useCallback, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';

import { taxRatesApi } from '../../services/settingsService.js';
import { apiErrorMessage } from '../../utils/apiError.js';

export default function SettingsPage() {
  const { t } = useTranslation('settings');
  return (
    <>
      <PageHeader title={t('systemSettings')} subtitle={t('taxRatesClubsFacilitiesNow')} />
      <TaxTab />
    </>
  );
}

function TaxTab() {
  const { t } = useTranslation('settings');
  const { hasPerm } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const fetcher = useCallback((q) => taxRatesApi.list(q), []);
  const { rows, loading, reload } = useApiList(fetcher);

  return (
    <>
      {hasPerm('settings.manage') && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}><Plus size={15} /> {t('newTaxRate')}</button>
        </div>
      )}
      <DataTable
        loading={loading}
        rows={rows}
        emptyTitle={t('noTaxRatesYet')}
        emptyHint={t('addVatRateMarkOne')}
        columns={[
          { key: 'name', header: t('common:labels.name'), render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
          { key: 'rate', header: t('rate'), render: (r) => `${(Number(r.rate) * 100).toFixed(2)}%` },
          { key: 'country', header: t('country'), render: (r) => r.country },
          { key: 'default', header: t('default'), render: (r) => r.is_default
            ? <StatusBadge tone="success" label={t('default')} /> : <span className="muted">-</span> },
        ]}
      />
      <TaxModal open={modalOpen} onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); toast.success(t('taxRateSaved')); reload(); }} />
    </>
  );
}

function TaxModal({ open, onClose, onSaved }) {
  const { t } = useTranslation('settings');
  const [form, setForm] = useState({ name: '', rate: '', country: 'UAE', is_default: false });
  const [busy, setBusy] = useState(false);
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit() {
    if (!form.name || form.rate === '') { toast.error(t('nameRateRequired')); return; }
    setBusy(true);
    try {
      // Accept either a percentage (5) or a fraction (0.05).
      const raw = Number(form.rate);
      const rate = raw > 1 ? raw / 100 : raw;
      await taxRatesApi.create({ ...form, rate });
      setForm({ name: '', rate: '', country: 'UAE', is_default: false });
      onSaved?.();
    } catch (e) { toast.error(apiErrorMessage(e, t('unableSaveYourChangesPlease'))); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('newTaxRate')} size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{t('common:actions.save')}</button>
      </>}>
      <FormField label={t('common:labels.name')}><input className="form-input" value={form.name} onChange={(e) => set('name', e.target.value)} /></FormField>
      <FormField label={t('rate')} hint={t('percentage5Fraction005')}>
        <input className="form-input" type="number" step="0.01" value={form.rate} onChange={(e) => set('rate', e.target.value)} />
      </FormField>
      <FormField label={t('country')}><input className="form-input" value={form.country} onChange={(e) => set('country', e.target.value)} /></FormField>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={form.is_default} onChange={(e) => set('is_default', e.target.checked)} />
        <span className="muted" style={{ fontSize: 13 }}>{t('setAsDefaultVatRate')}</span>
      </label>
    </Modal>
  );
}
