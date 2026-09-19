import { useCallback, useEffect, useState } from 'react';
import { Hourglass, Save, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { FormField } from '../../components/FormField.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { organizationApi } from '../../services/settingsService.js';
import { clubsApi } from '../../services/clubsService.js';
import { apiErrorMessage } from '../../utils/apiError.js';

/**
 * How long a court is held while somebody pays, and which ways they may pay.
 *
 * Two scopes, the same seven settings. The organization answer is the default
 * and a club may override any of them one at a time, so a club that only wants
 * a shorter hold does not have to restate everything else. A blank club field
 * means "inherit", and the inherited value is shown as the placeholder so the
 * meaning of blank is visible without opening another screen.
 *
 * Nothing here is enforcement. The backend resolves the same chain in
 * `settings_app.schedule.resolve_booking_policy` and every hold, checkout and
 * split link reads it from there.
 */

const MINUTE_FIELDS = [
  { key: 'hold_unpaid_minutes', label: 'Unpaid hold (minutes)',
    hint: 'How long an unpaid reservation keeps its court while the customer pays.' },
  { key: 'hold_partly_paid_minutes', label: 'Part-paid hold (minutes)',
    hint: 'The longer window once somebody has actually paid something. Granted once.' },
  { key: 'hold_max_minutes', label: 'Maximum hold (minutes)',
    hint: 'The ceiling. No reservation may keep a court longer than this, whatever else is set.' },
];

const SPLIT_FIELDS = [
  { key: 'split_hold_minutes', label: 'Split payment window (minutes)',
    hint: 'How long the payment links stay open. Never longer than the maximum hold.' },
  { key: 'split_max_shares', label: 'Maximum people per split',
    hint: 'How many friends one bill may be divided between.' },
];

// The switches, in the order they appear. `cash_enabled` changes what the
// checkout will accept; `show_hold_countdown` only changes what it shows.
const TOGGLES = [
  { key: 'cash_enabled', label: 'Accept payment at the venue' },
  { key: 'split_enabled', label: 'Allow a booking to be split between several people' },
  { key: 'show_hold_countdown',
    label: 'Show customers the reservation countdown',
    description: 'The court is held either way. Switch this off to hide the timer '
      + 'from the checkout. A customer whose reservation runs out is still told.' },
];

const ALL_KEYS = [
  ...MINUTE_FIELDS.map((f) => f.key),
  ...SPLIT_FIELDS.map((f) => f.key),
  ...TOGGLES.map((toggle) => toggle.key),
];

/** A number field the user may clear. '' is a real answer at club scope. */
function NumberInput({ value, placeholder, disabled, onChange }) {
  return (
    <input
      type="number"
      min="1"
      className="form-input"
      value={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ReservationSettings({ canManage }) {
  const { t } = useTranslation('settings');
  const [org, setOrg] = useState(null);
  const [clubs, setClubs] = useState([]);
  const [rows, setRows] = useState([]);          // clubs with an override open
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);        // 'org' or a club id
  const [newClub, setNewClub] = useState('');
  const [confirmClear, setConfirmClear] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      organizationApi.get(),
      clubsApi.list({ page_size: 100, is_active: 'true' }),
    ])
      .then(([o, c]) => {
        const list = c.results || c;
        setOrg(o);
        setClubs(list);
        // A club is "overriding" when it states at least one of the settings.
        setRows(list.filter((club) => ALL_KEYS.some((k) => club[k] !== null
          && club[k] !== undefined)));
      })
      .catch((e) => toast.error(apiErrorMessage(e, 'Could not load reservation settings.')))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  function setOrgField(key, value) {
    setOrg((o) => ({ ...o, [key]: value }));
  }

  function setRowField(id, key, value) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: value } : r)));
  }

  async function saveOrg() {
    setBusy('org');
    try {
      const payload = Object.fromEntries(
        [...MINUTE_FIELDS, ...SPLIT_FIELDS].map((f) => [f.key, Number(org[f.key]) || 1]));
      TOGGLES.forEach((toggle) => { payload[toggle.key] = !!org[toggle.key]; });
      // Only these fields. The endpoint is partial, and sending the whole
      // profile back would post the branding image URLs as if they were new
      // uploads.
      const saved = await organizationApi.update(payload);
      setOrg((o) => ({ ...o, ...saved }));
      toast.success('Reservation settings saved.');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save reservation settings.'));
    } finally { setBusy(null); }
  }

  async function saveRow(row) {
    setBusy(row.id);
    try {
      // An empty box is null, not zero: null means inherit, and zero would mean
      // a court is released the instant it is held.
      const payload = Object.fromEntries(
        [...MINUTE_FIELDS, ...SPLIT_FIELDS].map((f) => [
          f.key, row[f.key] === '' || row[f.key] === null || row[f.key] === undefined
            ? null : Number(row[f.key])]));
      TOGGLES.forEach((toggle) => { payload[toggle.key] = row[toggle.key] ?? null; });
      const saved = await clubsApi.update(row.id, payload);
      setRows((prev) => prev.map((r) => (r.id === row.id ? saved : r)));
      toast.success(`${row.name} saved.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the club override.'));
    } finally { setBusy(null); }
  }

  async function clearRow(row) {
    try {
      await clubsApi.update(row.id,
        Object.fromEntries(ALL_KEYS.map((k) => [k, null])));
      setConfirmClear(null);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      toast.success(`${row.name} now follows the organization.`);
    } catch (e) {
      setConfirmClear(null);
      toast.error(apiErrorMessage(e, 'Could not clear the club override.'));
    }
  }

  function addOverride() {
    const club = clubs.find((c) => c.id === Number(newClub));
    if (!club) return;
    setRows((prev) => [...prev, club]);
    setNewClub('');
  }

  const openIds = new Set(rows.map((r) => r.id));
  const clubOptions = clubs.filter((c) => !openIds.has(c.id))
    .map((c) => ({ value: c.id, label: c.name }));

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Hourglass size={18} />
        <h3 style={{ margin: 0, fontSize: 16 }}>Reservations and payment methods</h3>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: '0 0 14px' }}>
        A court is held while the customer pays and released when the time runs
        out, so nobody loses an evening slot to an abandoned checkout. Paying at
        the venue and splitting a bill are switched on per club: a club that
        takes no cash never offers it, on the website or through the API. A club
        field left blank follows the organization.
      </p>

      {loading || !org ? <p className="muted">{t('common:state.loading', 'Loading…')}</p> : (
        <>
          {/* Organization default */}
          <section style={{
            border: '1px solid var(--color-border)', borderRadius: 12, padding: 18,
            background: 'var(--color-surface, #fff)',
          }}>
            <h4 style={{ margin: '0 0 12px', fontSize: 14 }}>All clubs (default)</h4>
            <div className="form-grid form-grid--3">
              {MINUTE_FIELDS.map((f) => (
                <FormField key={f.key} label={f.label} hint={f.hint}>
                  <NumberInput
                    value={org[f.key]}
                    disabled={!canManage}
                    onChange={(v) => setOrgField(f.key, v)}
                  />
                </FormField>
              ))}
            </div>
            <div style={{ display: 'grid', gap: 4, margin: '10px 0 14px' }}>
              {TOGGLES.map((toggle) => (
                <Toggle
                  key={toggle.key}
                  label={toggle.label}
                  description={toggle.description}
                  checked={!!org[toggle.key]}
                  disabled={!canManage}
                  onChange={(e) => setOrgField(toggle.key, e.target.checked)}
                />
              ))}
            </div>
            {org.split_enabled && (
              <div className="form-grid form-grid--2">
                {SPLIT_FIELDS.map((f) => (
                  <FormField key={f.key} label={f.label} hint={f.hint}>
                    <NumberInput
                      value={org[f.key]}
                      disabled={!canManage}
                      onChange={(v) => setOrgField(f.key, v)}
                    />
                  </FormField>
                ))}
              </div>
            )}
            {canManage && (
              <button className="btn btn-primary" style={{ marginTop: 14 }}
                onClick={saveOrg} disabled={busy === 'org'}>
                <Save size={15} /> {busy === 'org' ? t('common:state.saving') : 'Save'}
              </button>
            )}
          </section>

          {/* Per-club overrides */}
          {rows.map((row) => {
            const inherited = row.effective_booking_policy || {};
            return (
              <section key={row.id} style={{
                border: '1px solid var(--color-border)', borderRadius: 12, padding: 18,
                background: 'var(--color-surface, #fff)', marginTop: 14,
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 10, flexWrap: 'wrap', marginBottom: 12,
                }}>
                  <h4 style={{ margin: 0, fontSize: 14 }}>{row.name}</h4>
                  {canManage && (
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => setConfirmClear(row)}>
                      <Trash2 size={14} /> Follow the organization
                    </button>
                  )}
                </div>
                <div className="form-grid form-grid--3">
                  {[...MINUTE_FIELDS, ...SPLIT_FIELDS].map((f) => (
                    <FormField key={f.key} label={f.label}>
                      <NumberInput
                        value={row[f.key]}
                        placeholder={`Inherits ${inherited[f.key] ?? ''}`}
                        disabled={!canManage}
                        onChange={(v) => setRowField(row.id, f.key, v)}
                      />
                    </FormField>
                  ))}
                </div>
                <div style={{ display: 'grid', gap: 4, margin: '10px 0 0' }}>
                  {TOGGLES.map((toggle) => (
                    <Toggle
                      key={toggle.key}
                      label={toggle.label}
                      description={toggle.description}
                      checked={row[toggle.key] ?? !!inherited[toggle.key]}
                      disabled={!canManage}
                      onChange={(e) => setRowField(row.id, toggle.key, e.target.checked)}
                    />
                  ))}
                </div>
                {canManage && (
                  <button className="btn btn-secondary" style={{ marginTop: 14 }}
                    onClick={() => saveRow(row)} disabled={busy === row.id}>
                    <Save size={15} /> {busy === row.id ? t('common:state.saving') : 'Save'}
                  </button>
                )}
              </section>
            );
          })}

          {canManage && clubOptions.length > 0 && (
            <div style={{
              display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap',
              marginTop: 14,
            }}>
              <div style={{ minWidth: 220, flex: '1 1 220px' }}>
                <FormField label="Give a club its own settings">
                  <Select2
                    value={newClub}
                    options={clubOptions}
                    placeholder="Choose a club"
                    onChange={setNewClub}
                  />
                </FormField>
              </div>
              <button type="button" className="btn btn-secondary"
                onClick={addOverride} disabled={!newClub}>
                <Plus size={15} /> Add
              </button>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!confirmClear}
        title="Follow the organization?"
        message={confirmClear
          ? `${confirmClear.name} will use the organization's reservation and payment settings. Existing bookings are not changed.`
          : ''}
        confirmLabel="Clear the override"
        onConfirm={() => clearRow(confirmClear)}
        onClose={() => setConfirmClear(null)}
      />
    </div>
  );
}

export default ReservationSettings;
