import { useEffect, useState } from 'react';
import { Save, Zap, Gift, Hourglass, Plus, Trash2, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { loyaltyApi } from '../../services/loyaltyService.js';
import { apiErrorMessage } from '../../utils/apiError.js';

const card = { border: '1px solid var(--color-border)', borderRadius: 12, padding: 18,
  background: 'var(--color-surface, #fff)' };
const grid = { display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' };

export default function LoyaltyConfiguration() {
  const { hasPerm } = useAuth();
  const canManage = hasPerm('loyalty.manage_rules');
  const canTiers = hasPerm('loyalty.manage_tiers');
  const [form, setForm] = useState(null);
  const [tiers, setTiers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [tierModal, setTierModal] = useState(null);   // tier being edited/created
  const [tierDelete, setTierDelete] = useState(null);

  useEffect(() => {
    loyaltyApi.getConfig().then(setForm)
      .catch((e) => toast.error(apiErrorMessage(e, 'Could not load the loyalty configuration')));
    loadTiers();
  }, []);

  function loadTiers() {
    loyaltyApi.listTiers().then((d) => setTiers(d.results || d)).catch(() => {});
  }

  const num = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const bool = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.checked }));

  async function save() {
    setBusy(true);
    try {
      setForm(await loyaltyApi.updateConfig(form));
      toast.success('Loyalty configuration saved');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the loyalty configuration'));
    } finally { setBusy(false); }
  }

  async function deleteTier() {
    try {
      await loyaltyApi.deleteTier(tierDelete.id);
      setTierDelete(null); loadTiers();
      toast.success('Tier deleted');
    } catch (e) { toast.error(apiErrorMessage(e, 'Could not delete the tier')); }
  }

  return (
    <>
      <PageHeader
        title="Loyalty"
        subtitle="Configure how points are earned and redeemed, and manage customer tiers."
      />

      {!form ? <p className="muted">Loading…</p> : (
        <>
          {/* Earning */}
          <section style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Zap size={18} /><h3 style={{ margin: 0, fontSize: 16 }}>Earning</h3>
            </div>
            <Toggle label="Customers earn points" checked={!!form.earning_enabled}
              disabled={!canManage} onChange={bool('earning_enabled')} />
            <div style={{ ...grid, marginTop: 12 }}>
              <FormField label="Points per 1.0 paid" hint="e.g. 1 = 1 point per AED of net paid.">
                <input className="form-input" type="number" step="0.001" value={form.points_per_currency}
                  onChange={num('points_per_currency')} disabled={!canManage} />
              </FormField>
              <FormField label="Fixed points per booking">
                <input className="form-input" type="number" value={form.fixed_points_per_booking}
                  onChange={num('fixed_points_per_booking')} disabled={!canManage} />
              </FormField>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Points are awarded when a booking is completed and paid, on the net amount actually paid
              (after discounts, promos and membership coverage; refunds are reversed automatically).
            </p>
          </section>

          <div style={{ height: 16 }} />

          {/* Redemption */}
          <section style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Gift size={18} /><h3 style={{ margin: 0, fontSize: 16 }}>Redemption</h3>
            </div>
            <Toggle label="Customers can redeem points" checked={!!form.redemption_enabled}
              disabled={!canManage} onChange={bool('redemption_enabled')} />
            <div style={{ ...grid, marginTop: 12 }}>
              <FormField label="Value per point" hint="Money off per point, e.g. 0.05.">
                <input className="form-input" type="number" step="0.001" value={form.currency_per_point}
                  onChange={num('currency_per_point')} disabled={!canManage} />
              </FormField>
              <FormField label="Minimum points to redeem">
                <input className="form-input" type="number" value={form.min_redeem_points}
                  onChange={num('min_redeem_points')} disabled={!canManage} />
              </FormField>
              <FormField label="Max points per booking" hint="0 = no cap.">
                <input className="form-input" type="number" value={form.max_redeem_points_per_booking}
                  onChange={num('max_redeem_points_per_booking')} disabled={!canManage} />
              </FormField>
              <FormField label="Max % of payable" hint="0 = no cap.">
                <input className="form-input" type="number" value={form.max_redeem_percent}
                  onChange={num('max_redeem_percent')} disabled={!canManage} />
              </FormField>
            </div>
            <div style={{ marginTop: 8 }}>
              <Toggle label="Allow with a promo code" checked={!!form.stack_with_promo}
                disabled={!canManage} onChange={bool('stack_with_promo')} />
              <Toggle label="Allow with membership coverage" checked={!!form.stack_with_membership}
                disabled={!canManage} onChange={bool('stack_with_membership')} />
            </div>
          </section>

          <div style={{ height: 16 }} />

          {/* Expiry */}
          <section style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Hourglass size={18} /><h3 style={{ margin: 0, fontSize: 16 }}>Expiry</h3>
            </div>
            <FormField label="Expire points after (months)" hint="0 = points never expire.">
              <input className="form-input" type="number" value={form.expiry_months}
                onChange={num('expiry_months')} disabled={!canManage} style={{ maxWidth: 200 }} />
            </FormField>
          </section>

          {canManage && (
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={save} disabled={busy}>
                <Save size={15} /> {busy ? 'Saving…' : 'Save configuration'}
              </button>
            </div>
          )}

          <div style={{ height: 24 }} />

          {/* Tiers */}
          <section style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Tiers</h3>
              {canTiers && (
                <button className="btn btn-secondary btn-sm"
                  onClick={() => setTierModal({ name: '', slug: '', rank: tiers.length,
                    min_points: '', min_spend: '', discount_percent: '0', priority_booking: false,
                    benefits: '', is_active: true })}>
                  <Plus size={14} /> Add tier
                </button>
              )}
            </div>
            <div className="table-wrapper">
              <table className="table">
                <thead><tr>
                  <th>Rank</th><th>Tier</th><th>Min points</th><th>Min spend</th>
                  <th>Discount %</th><th>Priority</th><th>Active</th>{canTiers && <th></th>}
                </tr></thead>
                <tbody>
                  {tiers.map((t) => (
                    <tr key={t.id}>
                      <td>{t.rank}</td>
                      <td style={{ fontWeight: 600 }}>{t.name} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{t.slug}</span></td>
                      <td>{t.min_points ?? '-'}</td>
                      <td>{t.min_spend ?? '-'}</td>
                      <td>{t.discount_percent}</td>
                      <td>{t.priority_booking ? 'Yes' : '-'}</td>
                      <td>{t.is_active ? 'Yes' : 'No'}</td>
                      {canTiers && (
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="icon-btn" title="Edit" onClick={() => setTierModal({ ...t })}><Pencil size={15} /></button>
                          <button className="icon-btn" title="Delete" style={{ color: 'var(--color-danger,#dc2626)' }}
                            onClick={() => setTierDelete(t)}><Trash2 size={15} /></button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {tierModal && (
        <TierModal tier={tierModal} onClose={() => setTierModal(null)}
          onSaved={() => { setTierModal(null); loadTiers(); }} />
      )}
      <ConfirmDialog
        open={Boolean(tierDelete)} tone="danger" title="Delete tier"
        message={tierDelete ? `Delete the “${tierDelete.name}” tier?` : ''}
        confirmLabel="Delete" onConfirm={deleteTier}
        onClose={() => setTierDelete(null)}
      />
    </>
  );
}

function TierModal({ tier, onClose, onSaved }) {
  const [t, setT] = useState(tier);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setT((x) => ({ ...x, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));

  async function save() {
    if (!t.name || !t.slug) { toast.error('Name and slug are required.'); return; }
    setBusy(true);
    try {
      const payload = {
        name: t.name, slug: t.slug, rank: Number(t.rank) || 0,
        min_points: t.min_points === '' || t.min_points == null ? null : Number(t.min_points),
        min_spend: t.min_spend === '' || t.min_spend == null ? null : t.min_spend,
        discount_percent: t.discount_percent || '0',
        priority_booking: !!t.priority_booking, benefits: t.benefits || '',
        color: t.color || '', is_active: t.is_active !== false,
      };
      if (t.id) await loyaltyApi.updateTier(t.id, payload);
      else await loyaltyApi.createTier(payload);
      toast.success('Tier saved');
      onSaved();
    } catch (e) { toast.error(apiErrorMessage(e, 'Could not save the tier')); }
    finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={t.id ? 'Edit tier' : 'Add tier'} size="sm"
      footer={<>
        <button className="btn btn-secondary" onClick={onClose} type="button">Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy} type="button">{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
        <FormField label="Name"><input className="form-input" value={t.name} onChange={set('name')} /></FormField>
        <FormField label="Slug" hint="Stable key (e.g. silver)."><input className="form-input" value={t.slug} onChange={set('slug')} disabled={!!t.id} /></FormField>
        <FormField label="Rank" hint="Low = entry tier."><input className="form-input" type="number" value={t.rank} onChange={set('rank')} /></FormField>
        <FormField label="Discount %"><input className="form-input" type="number" step="0.01" value={t.discount_percent} onChange={set('discount_percent')} /></FormField>
        <FormField label="Min points" hint="Blank = not required."><input className="form-input" type="number" value={t.min_points ?? ''} onChange={set('min_points')} /></FormField>
        <FormField label="Min spend" hint="Blank = not required."><input className="form-input" type="number" step="0.001" value={t.min_spend ?? ''} onChange={set('min_spend')} /></FormField>
      </div>
      <FormField label="Benefits"><textarea className="form-textarea" rows={2} value={t.benefits || ''} onChange={set('benefits')} /></FormField>
      <div style={{ display: 'flex', gap: 18, marginTop: 4 }}>
        <Toggle label="Priority booking" checked={!!t.priority_booking} onChange={set('priority_booking')} />
        <Toggle label="Active" checked={t.is_active !== false} onChange={set('is_active')} />
      </div>
    </Modal>
  );
}
