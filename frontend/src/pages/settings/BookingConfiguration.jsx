import { useCallback, useEffect, useState } from 'react';
import { Save, Globe, ShieldCheck, Store, Plus, Trash2, Timer } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { bookingConfigApi } from '../../services/settingsService.js';
import { bookingPoliciesApi } from '../../services/bookingsService.js';
import { SpecialDates } from '../../components/SpecialDates.jsx';
import { clubsApi } from '../../services/clubsService.js';
import { apiErrorMessage } from '../../utils/apiError.js';

const CHANNELS = [
  { key: 'website', label: 'Website Booking', icon: Globe,
    desc: 'Public, self-service bookings placed on your website.' },
  { key: 'admin', label: 'Admin Booking', icon: ShieldCheck,
    desc: 'Customers and bookings created by staff in the admin panel.' },
  { key: 'walkin', label: 'Walk-in Booking', icon: Store,
    desc: 'Walk-in customers captured at the club (no account).' },
];

const FIELDS = [
  { key: 'email_required', label: 'Email required' },
  { key: 'phone_required', label: 'Mobile number required' },
  { key: 'email_unique', label: 'Email must be unique' },
  { key: 'phone_unique', label: 'Mobile number must be unique' },
];

export default function BookingConfiguration() {
  const { hasPerm } = useAuth();
  const canManage = hasPerm('settings.manage');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    bookingConfigApi.get()
      .then(setForm)
      .catch((e) => toast.error(apiErrorMessage(e, 'Could not load the booking configuration')));
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.checked }));

  async function save() {
    setBusy(true);
    try {
      const saved = await bookingConfigApi.update(form);
      setForm(saved);
      toast.success('Booking configuration saved');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the booking configuration'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Booking Configuration"
        subtitle="Contact requirements per booking channel, and the rules that govern when a booking can be made or cancelled."
      />

      {!form ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
            {CHANNELS.map((ch) => {
              const Icon = ch.icon;
              return (
                <section key={ch.key} style={{
                  border: '1px solid var(--color-border)', borderRadius: 12, padding: 18,
                  background: 'var(--color-surface, #fff)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <Icon size={18} />
                    <h3 style={{ margin: 0, fontSize: 16 }}>{ch.label}</h3>
                  </div>
                  <p className="muted" style={{ fontSize: 12.5, margin: '0 0 14px' }}>{ch.desc}</p>
                  <div style={{ display: 'grid', gap: 4 }}>
                    {FIELDS.map((fld) => {
                      const key = `${ch.key}_${fld.key}`;
                      return (
                        <Toggle
                          key={key}
                          label={fld.label}
                          checked={!!form[key]}
                          disabled={!canManage}
                          onChange={set(key)}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          <div style={{
            marginTop: 16, padding: '12px 14px', borderRadius: 10, fontSize: 12.5,
            background: 'var(--color-surface-2, #f7f8fa)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)',
          }}>
            <strong>Unique</strong> means a contact can't be reused for a new record. On a duplicate, the
            booker is asked to verify and continue with the existing customer - on the website this is
            confirmed with a one-time code (OTP) and their details are prefilled.
          </div>

          {canManage && (
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={save} disabled={busy}>
                <Save size={15} /> {busy ? 'Saving…' : 'Save configuration'}
              </button>
            </div>
          )}

          <BookingRulesSection canManage={canManage} />

          <SpecialDates canManage={canManage} />
        </>
      )}
    </>
  );
}

const RULE_FIELDS = [
  { key: 'min_lead_minutes', label: 'Minimum notice (minutes)',
    hint: 'How soon before a slot starts a booking may still be made. 0 = up to the start.' },
  { key: 'max_advance_days', label: 'Booking horizon (days)',
    hint: 'How far ahead a slot may be booked. 0 = no limit.' },
  { key: 'max_active_bookings_per_customer', label: 'Max upcoming per customer',
    hint: 'Upcoming bookings one customer may hold at once. 0 = no limit.' },
  { key: 'max_bookings_per_customer_per_day', label: 'Max per customer per day',
    hint: 'Bookings one customer may hold on a single day. 0 = no limit.' },
  { key: 'cancellation_cutoff_hours', label: 'Cancellation cutoff (hours)',
    hint: 'A customer may cancel until this long before the slot. Staff are never blocked.' },
];

/** Booking rules: the organization default plus any per-club override. */
function BookingRulesSection({ canManage }) {
  const [rows, setRows] = useState([]);
  const [clubs, setClubs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [newClub, setNewClub] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    bookingPoliciesApi.list({ page_size: 100 })
      .then((d) => setRows(d.results || d))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    clubsApi.list({ page_size: 100, is_active: 'true' })
      .then((d) => setClubs(d.results || d))
      .catch(() => setClubs([]));
  }, [load]);

  const usedClubIds = new Set(rows.map((r) => r.club).filter(Boolean));
  const clubOptions = clubs
    .filter((c) => !usedClubIds.has(c.id))
    .map((c) => ({ value: c.id, label: c.name }));

  function setField(id, key, value) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: value } : r)));
  }

  async function saveRow(row) {
    setSavingId(row.id);
    try {
      const payload = Object.fromEntries(
        RULE_FIELDS.map((f) => [f.key, Number(row[f.key]) || 0]));
      payload.enforce_for_staff = !!row.enforce_for_staff;
      const saved = await bookingPoliciesApi.update(row.id, payload);
      setRows((prev) => prev.map((r) => (r.id === row.id ? saved : r)));
      toast.success('Booking rules saved');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the booking rules'));
    } finally { setSavingId(null); }
  }

  async function addOverride() {
    if (!newClub) return;
    try {
      await bookingPoliciesApi.create({ club: Number(newClub) });
      setNewClub('');
      toast.success('Club rules added');
      load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not add the club rules'));
    }
  }

  async function removeOverride(row) {
    try {
      await bookingPoliciesApi.remove(row.id);
      setConfirmDelete(null);
      toast.success('Club rules removed - it now follows the organization default');
      load();
    } catch (e) {
      setConfirmDelete(null);
      toast.error(apiErrorMessage(e, 'Could not remove the club rules'));
    }
  }

  return (
    <>
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Timer size={18} />
        <h3 style={{ margin: 0, fontSize: 16 }}>Booking Rules</h3>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: '0 0 14px' }}>
        These bind self-service bookings from your website. Staff bookings are
        exempt unless you turn on <strong>Apply to staff bookings</strong> - so
        reception can always take a walk-in for the next ten minutes. A club with
        its own rules ignores the organization default entirely.
      </p>

      {loading ? <p className="muted">Loading…</p> : (
        <div style={{ display: 'grid', gap: 14 }}>
          {rows.map((row) => (
            <section key={row.id} style={{
              border: '1px solid var(--color-border)', borderRadius: 12, padding: 18,
              background: 'var(--color-surface, #fff)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <h4 style={{ margin: 0, fontSize: 14.5 }}>{row.scope}</h4>
                {!row.is_default && canManage && (
                  <button className="icon-btn" title="Remove these club rules"
                    onClick={() => setConfirmDelete(row)}><Trash2 size={15} /></button>
                )}
              </div>
              <div style={{ display: 'grid', gap: 12,
                            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
                {RULE_FIELDS.map((f) => (
                  <FormField key={f.key} label={f.label} hint={f.hint}>
                    <input className="form-input" type="number" min="0"
                      value={row[f.key] ?? 0} disabled={!canManage}
                      onChange={(e) => setField(row.id, f.key, e.target.value)} />
                  </FormField>
                ))}
              </div>
              <div style={{ marginTop: 10 }}>
                <Toggle
                  label="Apply to staff bookings"
                  description="Off = only website/customer bookings are limited."
                  checked={!!row.enforce_for_staff}
                  disabled={!canManage}
                  onChange={(e) => setField(row.id, 'enforce_for_staff', e.target.checked)}
                />
              </div>
              {canManage && (
                <div style={{ marginTop: 12 }}>
                  <button className="btn btn-primary" onClick={() => saveRow(row)}
                    disabled={savingId === row.id}>
                    <Save size={15} /> {savingId === row.id ? 'Saving…' : 'Save rules'}
                  </button>
                </div>
              )}
            </section>
          ))}

          {canManage && clubOptions.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end',
                          border: '1px dashed var(--color-border)', borderRadius: 12, padding: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <FormField label="Give a club its own rules"
                  hint="It then ignores the organization default entirely.">
                  <Select2 options={clubOptions} value={newClub} onChange={setNewClub}
                    placeholder="Choose a club…" />
                </FormField>
              </div>
              <button className="btn btn-secondary" onClick={addOverride} disabled={!newClub}>
                <Plus size={15} /> Add
              </button>
            </div>
          )}
        </div>
      )}
    </div>

    <ConfirmDialog
      open={Boolean(confirmDelete)}
      tone="danger"
      title="Remove these club rules?"
      confirmLabel="Remove"
      message={confirmDelete ? (
        <><strong>{confirmDelete.scope}</strong> will fall back to the organization default rules.</>
      ) : null}
      onConfirm={() => removeOverride(confirmDelete)}
      onClose={() => setConfirmDelete(null)}
    />
    </>
  );
}
