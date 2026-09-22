import { useEffect, useState } from 'react';
import { Save, Zap, Gift, Hourglass, Plus, Trash2, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('loyalty');
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
      .catch((e) => toast.error(apiErrorMessage(e, t('couldNotLoadLoyaltyConfiguration'))));
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
      toast.success(t('loyaltyConfigurationSaved'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('couldNotSaveLoyaltyConfiguration')));
    } finally { setBusy(false); }
  }

  async function deleteTier() {
    try {
      await loyaltyApi.deleteTier(tierDelete.id);
      setTierDelete(null); loadTiers();
      toast.success(t('tierDeleted'));
    } catch (e) { toast.error(apiErrorMessage(e, t('couldNotDeleteTier'))); }
  }

  return (
    <>
      <PageHeader
        title={t('loyalty')}
        subtitle={t('configureHowPointsEarnedRedeemed')}
      />

      {!form ? <p className="muted">Loading…</p> : (
        <>
          {/* Earning */}
          <section style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Zap size={18} /><h3 style={{ margin: 0, fontSize: 16 }}>{t('earning')}</h3>
            </div>
            <Toggle label={t('customersEarnPoints')} checked={!!form.earning_enabled}
              disabled={!canManage} onChange={bool('earning_enabled')} />
            <div style={{ ...grid, marginTop: 12 }}>
              <FormField label={t('pointsPer10Paid')} hint={t('eG11Point')}>
                <input className="form-input" type="number" step="0.001" value={form.points_per_currency}
                  onChange={num('points_per_currency')} disabled={!canManage} />
              </FormField>
              <FormField label={t('fixedPointsPerBooking')}>
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
              <Gift size={18} /><h3 style={{ margin: 0, fontSize: 16 }}>{t('redemption')}</h3>
            </div>
            <Toggle label={t('customersCanRedeemPoints')} checked={!!form.redemption_enabled}
              disabled={!canManage} onChange={bool('redemption_enabled')} />
            <div style={{ ...grid, marginTop: 12 }}>
              <FormField label={t('valuePerPoint')} hint={t('moneyOffPerPointE')}>
                <input className="form-input" type="number" step="0.001" value={form.currency_per_point}
                  onChange={num('currency_per_point')} disabled={!canManage} />
              </FormField>
              <FormField label={t('minimumPointsRedeem')}>
                <input className="form-input" type="number" value={form.min_redeem_points}
                  onChange={num('min_redeem_points')} disabled={!canManage} />
              </FormField>
              <FormField label={t('maxPointsPerBooking')} hint="0 = no cap.">
                <input className="form-input" type="number" value={form.max_redeem_points_per_booking}
                  onChange={num('max_redeem_points_per_booking')} disabled={!canManage} />
              </FormField>
              <FormField label={t('maxPayable')} hint="0 = no cap.">
                <input className="form-input" type="number" value={form.max_redeem_percent}
                  onChange={num('max_redeem_percent')} disabled={!canManage} />
              </FormField>
            </div>
            <div style={{ marginTop: 8 }}>
              <Toggle label={t('allowPromoCode')} checked={!!form.stack_with_promo}
                disabled={!canManage} onChange={bool('stack_with_promo')} />
              <Toggle label={t('allowMembershipCoverage')} checked={!!form.stack_with_membership}
                disabled={!canManage} onChange={bool('stack_with_membership')} />
            </div>
          </section>

          <div style={{ height: 16 }} />

          {/* Expiry */}
          <section style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Hourglass size={18} /><h3 style={{ margin: 0, fontSize: 16 }}>{t('expiry')}</h3>
            </div>
            <FormField label={t('expirePointsAfterMonths')} hint="0 = points never expire.">
              <input className="form-input" type="number" value={form.expiry_months}
                onChange={num('expiry_months')} disabled={!canManage} style={{ maxWidth: 200 }} />
            </FormField>
          </section>

          {canManage && (
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={save} disabled={busy}>
                <Save size={15} /> {busy ? t('common:state.saving') : t('saveConfiguration')}
              </button>
            </div>
          )}

          <div style={{ height: 24 }} />

          {/* Tiers */}
          <section style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{t('tiers')}</h3>
              {canTiers && (
                <button className="btn btn-secondary btn-sm"
                  onClick={() => setTierModal({ name: '', slug: '', rank: tiers.length,
                    min_points: '', min_spend: '', discount_percent: '0', priority_booking: false,
                    benefits: '', is_active: true })}>
                  <Plus size={14} /> {t('addTier')}
                </button>
              )}
            </div>
            <div className="table-wrapper">
              <table className="table">
                <thead><tr>
                  <th>{t('rank')}</th><th>{t('tier')}</th><th>{t('minPoints')}</th><th>{t('minSpend')}</th>
                  <th>{t('discount')}</th><th>{t('priority')}</th><th>{t('common:state.active')}</th>{canTiers && <th></th>}
                </tr></thead>
                <tbody>
                  {/* Named `tier`, not `t`: a row variable called `t` shadows the
                      translation function, and the row actions below then call a
                      plain object, which throws and blanks the whole page. */}
                  {tiers.map((tier) => (
                    <tr key={tier.id}>
                      <td>{tier.rank}</td>
                      <td style={{ fontWeight: 600 }}>{tier.name} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{tier.slug}</span></td>
                      <td>{tier.min_points ?? '-'}</td>
                      <td>{tier.min_spend ?? '-'}</td>
                      <td>{tier.discount_percent}</td>
                      <td>{tier.priority_booking ? t('common:state.yes') : '-'}</td>
                      <td>{tier.is_active ? t('common:state.yes') : t('common:state.no')}</td>
                      {canTiers && (
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="icon-btn" title={t('common:actions.edit')} onClick={() => setTierModal({ ...tier })}><Pencil size={15} /></button>
                          <button className="icon-btn" title={t('common:actions.delete')} style={{ color: 'var(--color-danger,#dc2626)' }}
                            onClick={() => setTierDelete(tier)}><Trash2 size={15} /></button>
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
        open={Boolean(tierDelete)} tone="danger" title={t('deleteTier')}
        message={tierDelete ? `Delete the “${tierDelete.name}” tier?` : ''}
        confirmLabel={t('common:actions.delete')} onConfirm={deleteTier}
        onClose={() => setTierDelete(null)}
      />
    </>
  );
}

function TierModal({ tier, onClose, onSaved }) {
  const { t } = useTranslation('loyalty');
  const [draft, setDraft] = useState(tier);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setDraft((x) => ({ ...x, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));

  async function save() {
    if (!draft.name || !draft.slug) { toast.error(t('nameSlugRequired')); return; }
    setBusy(true);
    try {
      const payload = {
        name: draft.name, slug: draft.slug, rank: Number(draft.rank) || 0,
        min_points: draft.min_points === '' || draft.min_points == null ? null : Number(draft.min_points),
        min_spend: draft.min_spend === '' || draft.min_spend == null ? null : draft.min_spend,
        discount_percent: draft.discount_percent || '0',
        priority_booking: !!draft.priority_booking, benefits: draft.benefits || '',
        color: draft.color || '', is_active: draft.is_active !== false,
      };
      if (draft.id) await loyaltyApi.updateTier(draft.id, payload);
      else await loyaltyApi.createTier(payload);
      toast.success(t('tierSaved'));
      onSaved();
    } catch (e) { toast.error(apiErrorMessage(e, t('couldNotSaveTier'))); }
    finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={draft.id ? t('editTier') : t('addTier')} size="sm"
      footer={<>
        <button className="btn btn-secondary" onClick={onClose} type="button">{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={save} disabled={busy} type="button">{busy ? t('common:state.saving') : t('common:actions.save')}</button>
      </>}>
      <div className="form-grid form-grid--2">
        <FormField label={t('common:labels.name')}><input className="form-input" value={draft.name} onChange={set('name')} /></FormField>
        <FormField label={t('slug')} hint={t('stableKeyEGSilver')}><input className="form-input" value={draft.slug} onChange={set('slug')} disabled={!!draft.id} /></FormField>
        <FormField label={t('rank')} hint={t('lowEntryTier')}><input className="form-input" type="number" value={draft.rank} onChange={set('rank')} /></FormField>
        <FormField label={t('discount')}><input className="form-input" type="number" step="0.01" value={draft.discount_percent} onChange={set('discount_percent')} /></FormField>
        <FormField label={t('minPoints')} hint={t('blankNotRequired')}><input className="form-input" type="number" value={draft.min_points ?? ''} onChange={set('min_points')} /></FormField>
        <FormField label={t('minSpend')} hint={t('blankNotRequired')}><input className="form-input" type="number" step="0.001" value={draft.min_spend ?? ''} onChange={set('min_spend')} /></FormField>
      </div>
      <FormField label={t('benefits')}><textarea className="form-textarea" rows={2} value={draft.benefits || ''} onChange={set('benefits')} /></FormField>
      <div style={{ display: 'flex', gap: 18, marginTop: 4 }}>
        <Toggle label={t('priorityBooking')} checked={!!draft.priority_booking} onChange={set('priority_booking')} />
        <Toggle label={t('common:state.active')} checked={draft.is_active !== false} onChange={set('is_active')} />
      </div>
    </Modal>
  );
}
