import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarPlus, Coffee, Pencil, Plus, Power, Search, Trash2, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { ConfirmDialog } from './ConfirmDialog.jsx';
import { FormField } from './FormField.jsx';
import { Modal } from './Modal.jsx';
import { ScheduleImpactNotice } from './ScheduleImpactNotice.jsx';
import { Select2 } from './Select2.jsx';
import { TimePicker } from './TimePicker.jsx';
import { scheduleExceptionsApi } from '../services/scheduleService.js';
import { clubsApi } from '../services/clubsService.js';
import { facilitiesApi } from '../services/facilitiesService.js';
import { formatDate } from '../services/timeformat.jsx';
import { displayTime } from '../utils/schedule.js';
import { useTimeFormat } from '../services/timeformat.jsx';
import { apiErrorMessage } from '../utils/apiError';
import './schedule.css';

const BLANK = {
  name: '', club: '', facility: '', start_date: '', end_date: '',
  closed: true, shifts: [{ open: '16:00', close: '23:00' }], breaks: [],
  slot_minutes: '', is_active: true, notes: '',
};

const PAGE_SIZE = 200;

/** `is_active` is a real state, not a filter: an off row keeps its history. */
const WHEN = ['upcoming', 'past', 'all'];

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Special dates that replace the weekly pattern: public holidays, Ramadan
 * hours, tournaments, temporary closures.
 *
 * A date exception always beats the weekday schedule, at whichever scope it is
 * set. Scope is implied by the club/facility fields: leaving both empty applies
 * the date to the whole organization.
 *
 * Because a special date changes what is bookable, every save and every removal
 * is measured against the bookings customers are already holding first. The
 * backend answers that question (it owns the schedule engine); this screen only
 * refuses to proceed silently.
 */
export function SpecialDates({ canManage, club = null }) {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation('common');
  const { format24 } = useTimeFormat();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [clubs, setClubs] = useState([]);
  const [facilities, setFacilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [when, setWhen] = useState('upcoming');
  const [editing, setEditing] = useState(null);      // row or BLANK
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [removalImpact, setRemovalImpact] = useState(null);
  const [saveImpact, setSaveImpact] = useState(null);  // { impact, body }
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    scheduleExceptionsApi.list({ page_size: PAGE_SIZE, ...(club ? { club } : {}) })
      .then((d) => {
        const list = d.results || d;
        setRows(list);
        setTotal(typeof d.count === 'number' ? d.count : list.length);
      })
      .catch(() => { setRows([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [club]);

  useEffect(() => {
    load();
    if (club) return;
    clubsApi.list({ page_size: 100, is_active: 'true' })
      .then((d) => setClubs(d.results || d))
      .catch(() => setClubs([]));
  }, [load, club]);

  // Facilities are only offered once a club is chosen: a facility already
  // belongs to one club, and the backend rejects both being set at once.
  const scopeClub = editing?.club || club || '';
  useEffect(() => {
    if (!scopeClub) { setFacilities([]); return; }
    facilitiesApi.list({ page_size: 200, club: scopeClub })
      .then((d) => setFacilities(d.results || d))
      .catch(() => setFacilities([]));
  }, [scopeClub]);

  const visible = useMemo(() => {
    const now = today();
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      const last = row.end_date || row.start_date;
      if (when === 'upcoming' && last < now) return false;
      if (when === 'past' && last >= now) return false;
      if (!term) return true;
      return [row.name, row.notes, row.scope_label]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(term));
    });
  }, [rows, search, when]);

  /** The payload a save would send, also used verbatim for the impact check. */
  function payloadOf(draft) {
    return {
      name: draft.name.trim(),
      // A facility already implies its club, and the backend refuses both.
      // The club select stays populated in the form purely to narrow the
      // facility list.
      club: draft.facility ? null : (draft.club || null),
      facility: draft.facility || null,
      start_date: draft.start_date,
      end_date: draft.end_date || null,
      closed: draft.closed,
      shifts: draft.closed ? [] : draft.shifts,
      breaks: draft.closed ? [] : (draft.breaks || []),
      slot_minutes: draft.closed || !draft.slot_minutes
        ? null : Number(draft.slot_minutes),
      is_active: draft.is_active !== false,
      notes: draft.notes || '',
    };
  }

  async function commit(body) {
    setBusy(true);
    try {
      if (editing.id) await scheduleExceptionsApi.update(editing.id, body);
      else await scheduleExceptionsApi.create(body);
      toast.success(editing.id ? t('specialDates.updated') : t('specialDates.added'));
      setSaveImpact(null);
      setEditing(null);
      load();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('specialDates.saveFailed')));
    } finally { setBusy(false); }
  }

  /**
   * Ask what the change would cost before making it. A failed check does not
   * block the save: the server validates and reports again on the write itself,
   * so a temporary outage of the preview cannot lock an administrator out of
   * their own schedule.
   */
  async function save() {
    const body = payloadOf(editing);
    if (!body.name || !body.start_date) {
      toast.error(t('specialDates.nameAndDateRequired'));
      return;
    }
    setBusy(true);
    try {
      const impact = await scheduleExceptionsApi.impact(
        editing.id ? { ...body, id: editing.id } : body);
      if (impact.count > 0) {
        setSaveImpact({ impact, body });
        return;
      }
    } catch (e) {
      // A rejected proposal is reported now; anything else (an outage, a
      // timeout) falls through, because the save itself revalidates server-side
      // and a broken preview must not lock an administrator out.
      if (e?.response?.status === 400) {
        toast.error(apiErrorMessage(e, t('specialDates.saveFailed')));
        return;
      }
    } finally { setBusy(false); }
    await commit(body);
  }

  function askDelete(row) {
    setConfirmDelete(row);
    setRemovalImpact(null);
    scheduleExceptionsApi.removalImpact(row.id)
      .then(setRemovalImpact)
      .catch(() => setRemovalImpact(null));
  }

  async function remove(row) {
    setBusy(true);
    try {
      await scheduleExceptionsApi.remove(row.id);
      setConfirmDelete(null);
      toast.success(t('specialDates.removed'));
      load();
    } catch (e) {
      setConfirmDelete(null);
      toast.error(apiErrorMessage(e, t('specialDates.removeFailed')));
    } finally { setBusy(false); }
  }

  /** Turning a date off leaves the record and its history in place. */
  async function toggleActive(row) {
    try {
      await scheduleExceptionsApi.update(row.id, { is_active: !row.is_active });
      load();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('specialDates.saveFailed')));
    }
  }

  function rangeLabel(row) {
    if (!row.end_date || row.end_date === row.start_date) return formatDate(row.start_date);
    return `${formatDate(row.start_date)} - ${formatDate(row.end_date)}`;
  }

  const draft = editing;
  const setDraft = (patch) => setEditing((current) => ({ ...current, ...patch }));

  return (
    <>
      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <CalendarPlus size={18} />
          <h3 style={{ margin: 0, fontSize: 16 }}>{t('specialDates.title')}</h3>
          <div style={{ marginInlineStart: 'auto' }}>
            {canManage && (
              <button className="btn btn-primary"
                onClick={() => setEditing({
                  ...BLANK, club: club || '', start_date: today(),
                })}>
                <Plus size={15} /> {t('specialDates.add')}
              </button>
            )}
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 12px' }}>
          {t('specialDates.subtitle')}
        </p>

        {rows.length > 0 && (
          <div className="sch-filters">
            <label className="sch-filters__search">
              <Search size={14} />
              <input
                className="sch-filters__input"
                value={search}
                placeholder={t('specialDates.searchPlaceholder')}
                aria-label={t('specialDates.searchPlaceholder')}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="sch-filters__tabs" role="group"
              aria-label={t('specialDates.whenLabel')}>
              {WHEN.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`sch-filters__tab${when === key ? ' is-active' : ''}`}
                  aria-pressed={when === key}
                  onClick={() => setWhen(key)}
                >
                  {t(`specialDates.when.${key}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {loading ? <p className="muted">{tc('state.loading')}</p> : visible.length === 0 ? (
          <div className="sch-eff" style={{ padding: 20, textAlign: 'center' }}>
            <span className="muted" style={{ fontSize: 13 }}>
              {rows.length === 0
                ? t('specialDates.emptyTitle')
                : t('specialDates.noMatches')}
            </span>
          </div>
        ) : (
          <div className="sch-eff">
            {visible.map((row) => (
              <div className={`sch-eff__row${row.is_active ? '' : ' is-off'}`} key={row.id}>
                <span style={{ fontWeight: 600 }}>{rangeLabel(row)}</span>
                <span>
                  {row.name}
                  <span className="muted" style={{ marginInlineStart: 8, fontSize: 12 }}>
                    {row.scope_label}
                  </span>
                  {row.notes && (
                    <span className="sch-eff__note">{row.notes}</span>
                  )}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {row.closed ? (
                    <span className="sch-badge sch-badge--closed">{t('closed')}</span>
                  ) : (
                    <span className="sch-badge sch-badge--custom">
                      {(row.shifts || []).map((s) => (
                        `${displayTime(s.open, format24)} - ${displayTime(s.close, format24)}`
                      )).join(', ')}
                    </span>
                  )}
                  {!row.closed && (row.breaks || []).length > 0 && (
                    <span className="sch-badge sch-badge--break">
                      {t('breaks', { count: row.breaks.length })}
                    </span>
                  )}
                  {!row.is_active && (
                    <span className="sch-badge sch-badge--inherited">{t('specialDates.off')}</span>
                  )}
                  {canManage && (
                    <>
                      <button className="icon-btn"
                        title={row.is_active
                          ? t('specialDates.turnOff') : t('specialDates.turnOn')}
                        onClick={() => toggleActive(row)}><Power size={14} /></button>
                      <button className="icon-btn" title={tc('actions.edit')}
                        onClick={() => setEditing({
                          ...row,
                          // A facility-scoped row stores no club, but the
                          // form needs one to list that club's facilities.
                          club: row.club || row.facility_club || '',
                          facility: row.facility || '',
                          end_date: row.end_date || '',
                          slot_minutes: row.slot_minutes || '',
                          breaks: row.breaks || [],
                          shifts: row.shifts?.length ? row.shifts : BLANK.shifts,
                        })}><Pencil size={14} /></button>
                      <button className="icon-btn" title={tc('actions.remove')}
                        style={{ color: 'var(--color-danger-600)' }}
                        onClick={() => askDelete(row)}><Trash2 size={14} /></button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {total > rows.length && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {t('specialDates.showingSome', { shown: rows.length, total })}
          </p>
        )}
      </div>

      <Modal
        open={Boolean(draft)}
        onClose={busy ? () => {} : () => setEditing(null)}
        title={draft?.id ? t('specialDates.edit') : t('specialDates.add')}
        size="md"
        footer={
          <>
            <button className="btn btn-secondary" disabled={busy}
              onClick={() => setEditing(null)}>{tc('actions.cancel')}</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={save}>{busy ? tc('state.saving') : tc('actions.save')}</button>
          </>
        }
      >
        {draft && (
          <div style={{ display: 'grid', gap: 12 }}>
            <FormField label={`${t('specialDates.name')} *`} hint={t('specialDates.nameHint')}>
              <input className="form-input" value={draft.name}
                onChange={(e) => setDraft({ name: e.target.value })} />
            </FormField>

            {!club && (
              <div className="form-grid form-grid--2">
                <FormField label={t('specialDates.appliesTo')}
                  hint={t('specialDates.appliesToHint')}>
                  <Select2
                    options={clubs.map((c) => ({ value: c.id, label: c.name }))}
                    value={draft.club}
                    onChange={(v) => setDraft({ club: v, facility: '' })}
                    placeholder={t('specialDates.wholeOrganization')} clearable />
                </FormField>
                <FormField label={t('specialDates.facility')}
                  hint={draft.club
                    ? t('specialDates.facilityHint')
                    : t('specialDates.facilityNeedsClub')}>
                  <Select2
                    options={facilities.map((f) => ({ value: f.id, label: f.name }))}
                    value={draft.facility}
                    disabled={!draft.club}
                    onChange={(v) => setDraft({ facility: v })}
                    placeholder={t('specialDates.wholeClub')} clearable />
                </FormField>
              </div>
            )}

            {club && (
              <FormField label={t('specialDates.facility')}
                hint={t('specialDates.facilityHint')}>
                <Select2
                  options={facilities.map((f) => ({ value: f.id, label: f.name }))}
                  value={draft.facility}
                  onChange={(v) => setDraft({ facility: v })}
                  placeholder={t('specialDates.wholeClub')} clearable />
              </FormField>
            )}

            <div className="form-grid form-grid--2">
              <FormField label={`${t('specialDates.from')} *`}>
                <input className="form-input" type="date" value={draft.start_date}
                  onChange={(e) => setDraft({ start_date: e.target.value })} />
              </FormField>
              <FormField label={t('specialDates.to')} hint={t('specialDates.toHint')}>
                <input className="form-input" type="date" value={draft.end_date}
                  min={draft.start_date || undefined}
                  onChange={(e) => setDraft({ end_date: e.target.value })} />
              </FormField>
            </div>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
              cursor: 'pointer', fontSize: 13.5 }}>
              <input type="checkbox" checked={draft.closed}
                onChange={(e) => setDraft({ closed: e.target.checked })} />
              {t('specialDates.closedAllDay')}
            </label>

            {!draft.closed && (
              <>
                <FormField label={t('specialDates.hours')}
                  hint={t('specialDates.hoursHint')}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {draft.shifts.map((s, i) => (
                      // Shifts are positional; the list is edited in place.
                      // eslint-disable-next-line react/no-array-index-key
                      <div className="sch-line" key={i}>
                        <TimePicker value={s.open} ariaLabel={t('opens')}
                          onChange={(v) => setDraft({
                            shifts: draft.shifts.map(
                              (x, j) => (j === i ? { ...x, open: v } : x)),
                          })} />
                        <span className="sch-row__sep">{t('to')}</span>
                        <TimePicker value={s.close} ariaLabel={t('closes')}
                          onChange={(v) => setDraft({
                            shifts: draft.shifts.map(
                              (x, j) => (j === i ? { ...x, close: v } : x)),
                          })} />
                        {draft.shifts.length > 1 && (
                          <button type="button" className="icon-btn" title={t('removeShift')}
                            onClick={() => setDraft({
                              shifts: draft.shifts.filter((_, j) => j !== i),
                            })}><X size={14} /></button>
                        )}
                      </div>
                    ))}
                    <button type="button" className="sch-add" style={{ justifySelf: 'start' }}
                      onClick={() => setDraft({
                        shifts: [...draft.shifts, { open: '16:00', close: '23:00' }],
                      })}><Plus size={13} /> {t('addShift')}</button>
                  </div>
                </FormField>

                <FormField label={t('breaksTitle')} hint={t('specialDates.breaksHint')}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {(draft.breaks || []).map((b, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <div className="sch-line" key={i}>
                        <input className="sch-line__name" value={b.name || ''}
                          placeholder={t('breakNamePlaceholder')} aria-label={t('breakName')}
                          onChange={(e) => setDraft({
                            breaks: draft.breaks.map(
                              (x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                          })} />
                        <TimePicker value={b.open} ariaLabel={t('breakStarts')}
                          onChange={(v) => setDraft({
                            breaks: draft.breaks.map(
                              (x, j) => (j === i ? { ...x, open: v } : x)),
                          })} />
                        <span className="sch-row__sep">{t('to')}</span>
                        <TimePicker value={b.close} ariaLabel={t('breakEnds')}
                          onChange={(v) => setDraft({
                            breaks: draft.breaks.map(
                              (x, j) => (j === i ? { ...x, close: v } : x)),
                          })} />
                        <button type="button" className="icon-btn" title={t('removeBreak')}
                          onClick={() => setDraft({
                            breaks: draft.breaks.filter((_, j) => j !== i),
                          })}><X size={14} /></button>
                      </div>
                    ))}
                    <button type="button" className="sch-add" style={{ justifySelf: 'start' }}
                      onClick={() => setDraft({
                        breaks: [...(draft.breaks || []),
                          { name: '', open: '13:00', close: '14:00' }],
                      })}><Coffee size={13} /> {t('addBreak')}</button>
                  </div>
                </FormField>

                <FormField label={t('specialDates.slotMinutes')}
                  hint={t('specialDates.slotMinutesHint')}>
                  <input className="form-input" type="number" min="5" max="480" step="5"
                    value={draft.slot_minutes}
                    placeholder={t('slotDurationInherit')}
                    onChange={(e) => setDraft({ slot_minutes: e.target.value })} />
                </FormField>
              </>
            )}

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
              cursor: 'pointer', fontSize: 13.5 }}>
              <input type="checkbox" checked={draft.is_active !== false}
                onChange={(e) => setDraft({ is_active: e.target.checked })} />
              {t('specialDates.active')}
            </label>

            <FormField label={t('specialDates.note')}>
              <textarea className="form-textarea" rows={2} value={draft.notes || ''}
                onChange={(e) => setDraft({ notes: e.target.value })} />
            </FormField>
          </div>
        )}
      </Modal>

      {/* A closure that would strand live bookings is never saved on the first
          click: the affected bookings are named, and saving is a second,
          deliberate choice. Nothing is cancelled either way. */}
      <ConfirmDialog
        open={Boolean(saveImpact)}
        tone="danger"
        busy={busy}
        title={t('specialDates.impactTitle')}
        confirmLabel={t('specialDates.saveAnyway')}
        cancelLabel={tc('actions.cancel')}
        message={saveImpact ? (
          <>
            <ScheduleImpactNotice impact={saveImpact.impact} />
            <p style={{ margin: '10px 0 0' }}>{t('specialDates.impactBody')}</p>
          </>
        ) : null}
        onConfirm={() => commit(saveImpact.body)}
        onClose={() => setSaveImpact(null)}
      />

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        tone="danger"
        busy={busy}
        title={t('specialDates.removeTitle')}
        confirmLabel={tc('actions.remove')}
        cancelLabel={tc('actions.cancel')}
        message={confirmDelete ? (
          <>
            <p style={{ margin: 0 }}>
              {t('specialDates.removeBody', { range: rangeLabel(confirmDelete) })}
            </p>
            {removalImpact?.count > 0 && (
              <div style={{ marginTop: 10 }}>
                <ScheduleImpactNotice impact={removalImpact} />
              </div>
            )}
          </>
        ) : null}
        onConfirm={() => remove(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </>
  );
}
