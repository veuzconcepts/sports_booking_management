import { useCallback, useState } from 'react';
import { Plus } from 'lucide-react';
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
  return (
    <>
      <PageHeader title="System Settings" subtitle="Tax rates. Clubs & facilities now live under Organization Info." />
      <TaxTab />
    </>
  );
}

function TaxTab() {
  const { hasPerm } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const fetcher = useCallback((q) => taxRatesApi.list(q), []);
  const { rows, loading, reload } = useApiList(fetcher);

  return (
    <>
      {hasPerm('settings.manage') && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}><Plus size={15} /> New tax rate</button>
        </div>
      )}
      <DataTable
        loading={loading}
        rows={rows}
        emptyTitle="No tax rates yet"
        emptyHint="Add a VAT rate; mark one as default."
        columns={[
          { key: 'name', header: 'Name', render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
          { key: 'rate', header: 'Rate', render: (r) => `${(Number(r.rate) * 100).toFixed(2)}%` },
          { key: 'country', header: 'Country', render: (r) => r.country },
          { key: 'default', header: 'Default', render: (r) => r.is_default
            ? <StatusBadge tone="success" label="Default" /> : <span className="muted">-</span> },
        ]}
      />
      <TaxModal open={modalOpen} onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); toast.success('Tax rate saved'); reload(); }} />
    </>
  );
}

function TaxModal({ open, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', rate: '', country: 'UAE', is_default: false });
  const [busy, setBusy] = useState(false);
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit() {
    if (!form.name || form.rate === '') { toast.error('Name and rate are required.'); return; }
    setBusy(true);
    try {
      // Accept either a percentage (5) or a fraction (0.05).
      const raw = Number(form.rate);
      const rate = raw > 1 ? raw / 100 : raw;
      await taxRatesApi.create({ ...form, rate });
      setForm({ name: '', rate: '', country: 'UAE', is_default: false });
      onSaved?.();
    } catch (e) { toast.error(apiErrorMessage(e, 'Unable to save your changes. Please try again.')); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="New tax rate" size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>Save</button>
      </>}>
      <FormField label="Name"><input className="form-input" value={form.name} onChange={(e) => set('name', e.target.value)} /></FormField>
      <FormField label="Rate" hint="Percentage (5) or fraction (0.05).">
        <input className="form-input" type="number" step="0.01" value={form.rate} onChange={(e) => set('rate', e.target.value)} />
      </FormField>
      <FormField label="Country"><input className="form-input" value={form.country} onChange={(e) => set('country', e.target.value)} /></FormField>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={form.is_default} onChange={(e) => set('is_default', e.target.checked)} />
        <span className="muted" style={{ fontSize: 13 }}>Set as default VAT rate</span>
      </label>
    </Modal>
  );
}
