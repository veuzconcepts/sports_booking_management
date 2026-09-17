import { useCallback, useEffect, useState } from 'react';
import { CalendarPlus, Pencil, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';

import { ConfirmDialog } from './ConfirmDialog.jsx';
import { FormField } from './FormField.jsx';
import { Modal } from './Modal.jsx';
import { Select2 } from './Select2.jsx';
import { TimePicker } from './TimePicker.jsx';
import { scheduleExceptionsApi } from '../services/scheduleService.js';
import { clubsApi } from '../services/clubsService.js';
import { formatDate } from '../services/timeformat.jsx';
import { displayTime } from '../utils/schedule.js';
import { useTimeFormat } from '../services/timeformat.jsx';
import { apiErrorMessage } from '../utils/apiError';
import './schedule.css';

const BLANK = {
  name: '', club: '', start_date: '', end_date: '',
  closed: true, shifts: [{ open: '16:00', close: '23:00' }], notes: '',
};

/**
 * Special dates that replace the weekly pattern: public holidays, Ramadan
 * hours, tournaments, temporary closures.
 *
 * A date exception always beats the weekday schedule, at whichever scope it is
 * set. Scope is implied by the club field: leaving it empty applies the date to
 * the whole organization.
 */
export function SpecialDates({ canManage, club = null }) {
  const { format24 } = useTimeFormat();
  const [rows, setRows] = useState([]);
  const [clubs, setClubs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);      // row or BLANK
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    scheduleExceptionsApi.list({ page_size: 100, ...(club ? { club } : {}) })
      .then((d) => setRows(d.results || d))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [club]);

  useEffect(() => {
    load();
    if (club) return;
    clubsApi.list({ page_size: 100, is_active: 'true' })
      .then((d) => setClubs(d.results || d))
      .catch(() => setClubs([]));
  }, [load, club]);

  async function save() {
    const body = {
      name: editing.name.trim(),
      club: editing.club || null,
      start_date: editing.start_date,
      end_date: editing.end_date || null,
      closed: editing.closed,
      shifts: editing.closed ? [] : editing.shifts,
      notes: editing.notes,
    };
    if (!body.name || !body.start_date) {
      toast.error('A name and a start date are required.');
      return;
    }
    setBusy(true);
    try {
      if (editing.id) await scheduleExceptionsApi.update(editing.id, body);
      else await scheduleExceptionsApi.create(body);
      toast.success(editing.id ? 'Special date updated' : 'Special date added');
      setEditing(null);
      load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to save the special date.'));
    } finally { setBusy(false); }
  }

  async function remove(row) {
    try {
      await scheduleExceptionsApi.remove(row.id);
      setConfirmDelete(null);
      toast.success('Special date removed');
      load();
    } catch (e) {
      setConfirmDelete(null);
      toast.error(apiErrorMessage(e, 'Unable to remove the special date.'));
    }
  }

  function rangeLabel(row) {
    if (!row.end_date || row.end_date === row.start_date) return formatDate(row.start_date);
    return `${formatDate(row.start_date)} - ${formatDate(row.end_date)}`;
  }

  return (
    <>
      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <CalendarPlus size={18} />
          <h3 style={{ margin: 0, fontSize: 16 }}>Special Dates</h3>
          <div style={{ marginLeft: 'auto' }}>
            {canManage && (
              <button className="btn btn-primary"
                onClick={() => setEditing({ ...BLANK, club: club || '' })}>
                Add special date
              </button>
            )}
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 12px' }}>
          Dates that replace the weekly hours: holidays, Ramadan timings,
          tournaments, temporary closures. A special date always wins over the
          normal schedule for the days it covers.
        </p>

        {loading ? <p className="muted">Loading…</p> : rows.length === 0 ? (
          <div className="sch-eff" style={{ padding: 20, textAlign: 'center' }}>
            <span className="muted" style={{ fontSize: 13 }}>
              No special dates yet.
            </span>
          </div>
        ) : (
          <div className="sch-eff">
            {rows.map((row) => (
              <div className="sch-eff__row" key={row.id}>
                <span style={{ fontWeight: 600 }}>{rangeLabel(row)}</span>
                <span>
                  {row.name}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    {row.scope_label}
                  </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {row.closed ? (
                    <span className="sch-badge sch-badge--closed">Closed</span>
                  ) : (
                    <span className="sch-badge sch-badge--custom">
                      {(row.shifts || []).map((s) => (
                        `${displayTime(s.open, format24)} - ${displayTime(s.close, format24)}`
                      )).join(', ')}
                    </span>
                  )}
                  {!row.is_active && <span className="sch-badge sch-badge--inherited">Off</span>}
                  {canManage && (
                    <>
                      <button className="icon-btn" title="Edit"
                        onClick={() => setEditing({
                          ...row, club: row.club || '', end_date: row.end_date || '',
                          shifts: row.shifts?.length ? row.shifts : BLANK.shifts,
                        })}><Pencil size={14} /></button>
                      <button className="icon-btn" title="Remove"
                        style={{ color: 'var(--color-danger-600)' }}
                        onClick={() => setConfirmDelete(row)}><Trash2 size={14} /></button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={Boolean(editing)}
        onClose={busy ? () => {} : () => setEditing(null)}
        title={editing?.id ? 'Edit special date' : 'Add special date'}
        size="md"
        footer={
          <>
            <button className="btn btn-secondary" disabled={busy}
              onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          </>
        }
      >
        {editing && (
          <div style={{ display: 'grid', gap: 12 }}>
            <FormField label="Name *" hint="Shown to staff, e.g. National Day.">
              <input className="form-input" value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </FormField>

            {!club && (
              <FormField label="Applies to"
                hint="Leave empty to apply to the whole organization.">
                <Select2
                  options={clubs.map((c) => ({ value: c.id, label: c.name }))}
                  value={editing.club} onChange={(v) => setEditing({ ...editing, club: v })}
                  placeholder="Whole organization" clearable />
              </FormField>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <FormField label="From *">
                <input className="form-input" type="date" value={editing.start_date}
                  onChange={(e) => setEditing({ ...editing, start_date: e.target.value })} />
              </FormField>
              <FormField label="To" hint="Leave empty for a single day.">
                <input className="form-input" type="date" value={editing.end_date}
                  min={editing.start_date || undefined}
                  onChange={(e) => setEditing({ ...editing, end_date: e.target.value })} />
              </FormField>
            </div>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
              cursor: 'pointer', fontSize: 13.5 }}>
              <input type="checkbox" checked={editing.closed}
                onChange={(e) => setEditing({ ...editing, closed: e.target.checked })} />
              Closed all day
            </label>

            {!editing.closed && (
              <FormField label="Operating hours"
                hint="Used instead of the normal hours on these dates.">
                <div style={{ display: 'grid', gap: 6 }}>
                  {editing.shifts.map((s, i) => (
                    <div className="sch-line" key={i}>
                      <TimePicker value={s.open} ariaLabel="Opens"
                        onChange={(v) => setEditing({
                          ...editing,
                          shifts: editing.shifts.map((x, j) => (j === i ? { ...x, open: v } : x)),
                        })} />
                      <span className="sch-row__sep">to</span>
                      <TimePicker value={s.close} ariaLabel="Closes"
                        onChange={(v) => setEditing({
                          ...editing,
                          shifts: editing.shifts.map((x, j) => (j === i ? { ...x, close: v } : x)),
                        })} />
                      {editing.shifts.length > 1 && (
                        <button className="icon-btn" title="Remove shift"
                          onClick={() => setEditing({
                            ...editing,
                            shifts: editing.shifts.filter((_, j) => j !== i),
                          })}>x</button>
                      )}
                    </div>
                  ))}
                  <button type="button" className="sch-add" style={{ justifySelf: 'start' }}
                    onClick={() => setEditing({
                      ...editing,
                      shifts: [...editing.shifts, { open: '16:00', close: '23:00' }],
                    })}>Add shift</button>
                </div>
              </FormField>
            )}

            <FormField label="Note (optional)">
              <textarea className="form-textarea" rows={2} value={editing.notes || ''}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </FormField>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        tone="danger"
        title="Remove this special date?"
        confirmLabel="Remove"
        message={confirmDelete ? (
          <>The normal weekly hours will apply again on <strong>{rangeLabel(confirmDelete)}</strong>.</>
        ) : null}
        onConfirm={() => remove(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </>
  );
}
