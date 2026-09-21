import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Pencil, Wrench, Clock, X, SlidersHorizontal, MapPin, Building2 }
  from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { FormField } from '../../components/FormField.jsx';
import { ClubLocationPicker } from '../../components/ClubLocationPicker.jsx';
import { ScheduleScopePanel } from '../../components/ScheduleScopePanel.jsx';
import { BookingRulesModal } from './BookingRulesModal.jsx';
import { PhoneField, isPhoneValid } from '../../components/PhoneField.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { clubsApi } from '../../services/clubsService.js';
import { Select2 } from '../../components/Select2.jsx';
import { facilitiesApi, facilityTypesApi, maintenanceBlocksApi }
  from '../../services/facilitiesService.js';
import { apiErrorMessage } from '../../utils/apiError.js';
import { ListPage } from '../../components/listview/index.js';
import './clubs.css';

export default function ClubsAndFacilities() {
  const { t } = useTranslation('settings');
  const { hasPerm } = useAuth();
  const canManage = hasPerm('clubs.add') || hasPerm('clubs.edit');
  const [clubModal, setClubModal] = useState(false);
  const [editClub, setEditClub] = useState(null);
  const [activeClub, setActiveClub] = useState(null);
  const [deleteClub, setDeleteClub] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState('');
  const fetcher = useCallback((q) => clubsApi.list(q), []);
  const { rows, loading, reload } = useApiList(fetcher);

  async function runDeleteClub() {
    setDelBusy(true); setDelErr('');
    try {
      await clubsApi.remove(deleteClub.id);
      setDeleteClub(null); toast.success(t('clubDeleted')); reload();
    } catch (e) {
      setDelErr(apiErrorMessage(e, t('unableDeleteClubPleaseTry')));
    } finally { setDelBusy(false); }
  }

  const facilityTotal = rows.reduce((sum, club) => sum + (club.facility_count || 0), 0);

  return (
    <ListPage
      wide
      title={t('clubsFacilities')}
      subtitle={rows.length
        ? t('clubsCount', { clubs: rows.length, facilities: facilityTotal })
        : t('addClubFacilitiesItOffers')}
      actions={canManage && (
        <button className="btn btn-primary" onClick={() => setClubModal(true)}>
          <Plus size={15} /> {t('newClub')}
        </button>
      )}
    >
      {/* A card grid rather than a table, so it goes in `.lv-altbody` and
          occupies the region the table would have (CLAUDE.md section 36). */}
      <div className="lv-altbody">
      {loading ? (
        <div className="card"><div className="card-body center" style={{ padding: 40 }}><span className="muted">Loading…</span></div></div>
      ) : rows.length === 0 ? (
        <div className="card"><div className="empty"><h3>{t('noClubsYet')}</h3><p>{t('addClubFacilitiesItOffers')}</p></div></div>
      ) : (
        <div className="clubs-grid">
          {rows.map((club) => (
            <ClubCard key={club.id} club={club} canManage={canManage}
              onEdit={() => setEditClub(club)} onManageFacilities={() => setActiveClub(club)}
              onDelete={() => { setDelErr(''); setDeleteClub(club); }} />
          ))}
        </div>
      )}

      </div>

      <ClubModal
        open={clubModal || Boolean(editClub)}
        club={editClub}
        onClose={() => { setClubModal(false); setEditClub(null); }}
        onSaved={() => {
          const wasEdit = Boolean(editClub);
          setClubModal(false); setEditClub(null);
          toast.success(wasEdit ? t('clubUpdated') : t('clubCreated'));
          reload();
        }}
      />
      <FacilitiesModal club={activeClub} onClose={() => setActiveClub(null)} onChanged={reload} />
      <ConfirmDialog
        open={Boolean(deleteClub)}
        busy={delBusy}
        tone="danger"
        title={t('deleteClub')}
        confirmLabel={t('common:actions.delete')}
        message={deleteClub ? (
          <>
            {t('common:actions.delete')} <strong>{deleteClub.name}</strong>? This can’t be undone. It’s only allowed if the club isn’t used anywhere.
            {delErr && <div style={{ marginTop: 10, color: '#dc2626', fontSize: 13, fontWeight: 500 }}>{delErr}</div>}
          </>
        ) : null}
        onConfirm={runDeleteClub}
        onClose={() => { if (!delBusy) { setDeleteClub(null); setDelErr(''); } }}
      />
    </ListPage>
  );
}

/**
 * How many facility chips fit before the card stops being scannable.
 *
 * A club with twenty courts used to print twenty badges and grow to several
 * times the height of its neighbours, which is what broke the grid and made
 * the page feel empty and enormous at the same time. The rest are a count,
 * and "Facilities" opens the full list.
 */
const CHIP_LIMIT = 5;

function ClubCard({ club, canManage, onManageFacilities, onEdit, onDelete }) {
  const { t } = useTranslation('settings');
  const facilities = club.facilities || [];
  const shown = facilities.slice(0, CHIP_LIMIT);
  const hidden = facilities.length - shown.length;
  const where = [club.address, club.city].filter(Boolean).join(', ');

  return (
    <article className={`club-card${club.is_active ? '' : ' is-off'}`}>
      <div className="club-card__head">
        <div style={{ minWidth: 0 }}>
          <h3 className="club-card__name" title={club.name}>{club.name}</h3>
          <code className="club-card__code">{club.code}</code>
        </div>
        <StatusBadge
          tone={club.is_active ? 'success' : 'muted'}
          label={club.is_active ? t('common:state.active') : t('common:state.inactive')}
        />
      </div>

      <p className="club-card__meta">
        <MapPin size={14} aria-hidden="true" />
        <span>{where || t('noAddressYet')}</span>
      </p>
      <p className="club-card__meta">
        <Building2 size={14} aria-hidden="true" />
        <span>{t('facilityCount', { count: club.facility_count || 0 })}</span>
      </p>

      {facilities.length === 0 ? (
        <p className="club-card__none">{t('noFacilitiesConfigured')}</p>
      ) : (
        <div className="club-card__chips">
          {shown.map((f) => (
            <span key={f.id}
              className={`club-card__chip${f.is_active ? '' : ' is-off'}`}
              title={f.name}>
              {f.name}
            </span>
          ))}
          {hidden > 0 && (
            <span className="club-card__chip club-card__chip--more">
              {t('andMore', { count: hidden })}
            </span>
          )}
        </div>
      )}

      <div className="club-card__foot">
        <button className="btn btn-secondary btn-sm" onClick={onManageFacilities}>
          <Wrench size={14} /> {t('manageFacilities')}
        </button>
        {canManage && (
          <button className="btn btn-ghost btn-sm" onClick={onEdit}>
            <Pencil size={14} /> {t('common:actions.edit')}
          </button>
        )}
        <span className="club-card__spacer" />
        {canManage && (
          <button className="icon-btn" title={t('deleteClub2')} onClick={onDelete}>
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </article>
  );
}

const DEFAULT_CLUB_HOURS = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    .map((d) => [d, { closed: false, shifts: [{ open: '08:00', close: '20:00' }] }]),
);
const EMPTY_CLUB = {
  code: '', name: '', address: '', city: '', phone: '', email: '', is_active: true,
  latitude: '', longitude: '',
  customHours: false, booking_hours: DEFAULT_CLUB_HOURS, slot_minutes: '',
  buffer_before_minutes: '', buffer_after_minutes: '',
};

// Club code is a slug (max 20 chars) - derive a sensible one from the name.
function slugifyCode(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 20).replace(/-+$/, '');
}

function ClubModal({ open, club, onClose, onSaved }) {
  const { t } = useTranslation('settings');
  const editing = Boolean(club);
  const [form, setForm] = useState(EMPTY_CLUB);
  const [busy, setBusy] = useState(false);
  const codeEdited = useRef(false);   // stop auto-fill once the user edits Code
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  // Name drives Code until the user touches Code (then it's left alone).
  function setName(v) {
    setForm((f) => ({ ...f, name: v, code: codeEdited.current ? f.code : slugifyCode(v) }));
  }
  function setCode(v) { codeEdited.current = true; set('code', slugifyCode(v)); }

  useEffect(() => {
    if (!open) return;
    codeEdited.current = Boolean(club);   // existing clubs keep their code
    if (!club) { setForm(EMPTY_CLUB); return; }
    const hasCustom = club.booking_hours && Object.keys(club.booking_hours).length > 0;
    setForm({
      code: club.code || '', name: club.name || '', address: club.address || '',
      city: club.city || '', phone: club.phone || '', email: club.email || '', is_active: club.is_active,
      latitude: club.latitude ?? '', longitude: club.longitude ?? '',
      customHours: hasCustom,
      booking_hours: hasCustom ? club.booking_hours : {},
      slot_minutes: club.slot_minutes || '',
      buffer_before_minutes: club.buffer_before_minutes ?? '',
      buffer_after_minutes: club.buffer_after_minutes ?? '',
    });
  }, [open, club]);

  async function submit() {
    if (!form.code || !form.name) { toast.error(t('codeNameRequired')); return; }
    if (form.phone && !isPhoneValid(form.phone)) { toast.error(t('enterValidPhoneNumberSelected')); return; }
    const payload = {
      code: form.code, name: form.name, address: form.address, city: form.city,
      phone: form.phone, email: form.email, is_active: form.is_active,
      latitude: form.latitude === '' || form.latitude == null ? null : Number(form.latitude),
      longitude: form.longitude === '' || form.longitude == null ? null : Number(form.longitude),
      // An empty document means "inherit": the club is never given a private
      // copy of the organization's week, so changing the parent still moves it.
      booking_hours: form.customHours ? form.booking_hours : {},
      slot_minutes: form.customHours && form.slot_minutes ? Number(form.slot_minutes) : null,
      buffer_before_minutes: form.customHours && form.buffer_before_minutes !== ''
        ? Number(form.buffer_before_minutes) : null,
      buffer_after_minutes: form.customHours && form.buffer_after_minutes !== ''
        ? Number(form.buffer_after_minutes) : null,
    };
    setBusy(true);
    try {
      if (editing) await clubsApi.update(club.id, payload);
      else await clubsApi.create(payload);
      onSaved?.();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableSaveYourChangesPlease')));
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? t('editClub') : t('newClub')} size="lg"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : (editing ? t('updateClub') : t('saveClub'))}
        </button>
      </>}>
      <div className="row">
        <div className="col"><FormField label={t('common:labels.name')}>
          <input className="form-input" value={form.name} onChange={(e) => setName(e.target.value)} /></FormField></div>
        <div className="col"><FormField label={t('code')}>
          <input className="form-input" value={form.code} onChange={(e) => setCode(e.target.value)} /></FormField></div>
      </div>
      <div className="row">
        <div className="col"><FormField label={t('common:labels.phone')}
          error={form.phone && !isPhoneValid(form.phone) ? 'Enter a valid phone number for the selected country' : undefined}>
          <PhoneField value={form.phone} onChange={(v) => set('phone', v)} invalid={!!form.phone && !isPhoneValid(form.phone)} /></FormField></div>
        <div className="col"><FormField label={t('common:labels.email')}>
          <input className="form-input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></FormField></div>
      </div>

      <ClubLocationPicker
        latitude={form.latitude} longitude={form.longitude}
        address={form.address} city={form.city}
        onChange={({ latitude, longitude }) => setForm((f) => ({ ...f, latitude, longitude }))}
        onAddress={(v) => set('address', v)}
        onCity={(v) => set('city', v)}
      />
      {editing && (
        <FormField label={t('common:labels.status')}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13.5 }}>
            <input type="checkbox" checked={!!form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
            {t('common:state.active')}
          </label>
        </FormField>
      )}

      <div className="modal-section">{t('businessHours')}</div>
      <ScheduleScopePanel
        scope="club"
        parentLabel="Organization"
        query={club ? { club: club.id } : null}
        custom={form.customHours}
        onCustom={(v) => set('customHours', v)}
        week={form.booking_hours}
        onWeek={(v) => set('booking_hours', v)}
        slotMinutes={form.slot_minutes}
        onSlotMinutes={(v) => set('slot_minutes', v)}
        bufferBefore={form.buffer_before_minutes}
        bufferAfter={form.buffer_after_minutes}
        onBuffers={(before, after) => {
          set('buffer_before_minutes', before);
          set('buffer_after_minutes', after);
        }}
      />

    </Modal>
  );
}

function FacilitiesModal({ club, onClose, onChanged }) {
  const { t } = useTranslation('settings');
  const [facilities, setFacilities] = useState([]);
  const [types, setTypes] = useState([]);
  const [label, setLabel] = useState('');
  const [newTypes, setNewTypes] = useState([]);
  const [editing, setEditing] = useState(null);       // facility id being edited
  const [editLabel, setEditLabel] = useState('');
  const [editTypes, setEditTypes] = useState([]);
  const [blocksFor, setBlocksFor] = useState(null);   // facility whose blocks are open
  const [hoursFor, setHoursFor] = useState(null);     // facility whose hours are open
  const [rulesFor, setRulesFor] = useState(null);     // facility whose booking rules are open

  useEffect(() => {
    if (!club) return;
    setFacilities(club.facilities || []);
    setEditing(null);
    setNewTypes([]);
    facilityTypesApi.list({ page_size: 200, is_active: 'true' })
      .then((d) => setTypes(d.results || d))
      .catch(() => setTypes([]));
  }, [club]);

  const typeOptions = types.map((type) => ({ value: type.id, label: type.name }));

  async function addFacility() {
    if (!label.trim()) return;
    try {
      const facility = await facilitiesApi.create({
        club: club.id, name: label.trim(), facility_types: newTypes,
      });
      setFacilities((prev) => [...prev, facility]);
      setLabel(''); setNewTypes([]);
      onChanged?.();
    } catch (e) { toast.error(apiErrorMessage(e, t('unableAddFacilityPleaseTry'))); }
  }

  async function updateFacility(id, patch) {
    try {
      const updated = await facilitiesApi.update(id, patch);
      setFacilities((prev) => prev.map((f) => (f.id === id ? updated : f)));
      onChanged?.();
      return updated;
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUpdateFacilityPleaseTry')));
      return null;
    }
  }

  async function saveEdit() {
    const v = editLabel.trim();
    if (!v) return;
    await updateFacility(editing, { name: v, facility_types: editTypes });
    setEditing(null);
  }

  function startEdit(f) {
    setEditing(f.id);
    setEditLabel(f.name);
    setEditTypes(f.facility_types || []);
  }

  async function removeFacility(id) {
    try { await facilitiesApi.remove(id); setFacilities((prev) => prev.filter((f) => f.id !== id)); onChanged?.(); }
    catch (e) { toast.error(apiErrorMessage(e, t('unableRemoveFacilityPleaseTry'))); }
  }

  return (
    <>
    <Modal open={Boolean(club)} onClose={onClose} title={club ? `Facilities \u00b7 ${club.name}` : ''} size="md"
      footer={<button className="btn btn-secondary" onClick={onClose}>{t('done')}</button>}>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        A facility is one physical unit you own: a court, a pitch, a lane, a hall.
        An activity is what you sell on it, with its price and duration, set up
        under Catalogue &amp; Pricing. Choose which activities this unit can be
        booked for - a hall that is badminton by day and a function room by night
        is ONE facility offering both, so it can never double-book itself. Leave
        it empty to make the unit usable for anything, though it will not be
        advertised on the website until you name an activity.
      </p>

      <div style={{ display: 'grid', gap: 8, marginBottom: 16, padding: 12,
                    border: '1px solid var(--color-border-soft)', borderRadius: 10 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="form-input" placeholder={t('facilityNameEGCourt')}
            value={label} onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFacility(); } }} />
          <button className="btn btn-primary" onClick={addFacility} disabled={!label.trim()}>
            <Plus size={14} /> {t('common:actions.add')}
          </button>
        </div>
        <Select2 multiple options={typeOptions} value={newTypes} onChange={setNewTypes}
          placeholder={t('bookableAsAnyTypeIf')} />
      </div>

      {facilities.length === 0 ? <p className="muted">{t('noFacilitiesYet')}</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {facilities.map((f) => {
            const isEditing = editing === f.id;
            return (
              <div key={f.id} style={{ padding: '10px 12px',
                border: '1px solid var(--color-border-soft)', borderRadius: 8 }}>
                {isEditing ? (
                  <div style={{ display: 'grid', gap: 8 }}>
                    <input className="form-input" autoFocus value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} />
                    <Select2 multiple options={typeOptions} value={editTypes} onChange={setEditTypes}
                      placeholder={t('bookableAsAnyTypeIf')} />
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={!editLabel.trim()}>{t('common:actions.save')}</button>
                      <button className="icon-btn" onClick={() => setEditing(null)} aria-label={t('common:actions.cancel')}><X size={15} /></button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                        {f.name}
                        {!f.is_active && <StatusBadge tone="muted" label={t('common:state.inactive')} />}
                      </span>
                      {/* A unit with no types can be booked as anything, which is
                          useful operationally but means the website has nothing
                          to advertise it as: the public club card lists declared
                          types only, so it cannot claim a sport nobody stated.
                          Saying so here is the difference between a deliberate
                          choice and a gap the operator never noticed. */}
                      {(f.facility_type_names || []).length ? (
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                          {f.facility_type_names.join(', ')}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, marginTop: 2, color: 'var(--color-warning-600)' }}>
                          {t('anyTypeNotAdvertised')}
                        </div>
                      )}
                    </div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--color-text-muted)', cursor: 'pointer' }} title={t('common:state.active')}>
                        <input type="checkbox" checked={!!f.is_active}
                          onChange={(e) => updateFacility(f.id, { is_active: e.target.checked })} /> {t('common:state.active')}
                      </label>
                      <button className="icon-btn" onClick={() => setHoursFor(f)}
                        aria-label={t('businessHours2')} title={t('businessHours2')}>
                        <Clock size={15} />
                      </button>
                      <button className="icon-btn" onClick={() => setBlocksFor(f)} aria-label={t('maintenance')} title={t('maintenance')}>
                        <Wrench size={15} />
                      </button>
                      <button className="icon-btn" onClick={() => setRulesFor(f)}
                        aria-label={t('bookingRules')} title={t('bookingRules')}>
                        <SlidersHorizontal size={15} />
                      </button>
                      <button className="icon-btn" onClick={() => startEdit(f)} aria-label={t('common:actions.edit')}><Pencil size={14} /></button>
                      <button className="icon-btn" onClick={() => removeFacility(f.id)} aria-label={t('common:actions.remove')}><Trash2 size={15} /></button>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>

    <MaintenanceModal facility={blocksFor} onClose={() => setBlocksFor(null)} />
    <FacilityHoursModal
      facility={hoursFor}
      club={club}
      onClose={() => setHoursFor(null)}
      onSaved={(updated) => {
        setFacilities((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
        setHoursFor(null);
        onChanged?.();
      }}
    />
    {/* Guarded on the facility, not on any derived state: React evaluates a
        modal's children before the modal can decide it is closed, so a null
        here would be dereferenced on the render that closes it. */}
    {rulesFor && (
      <BookingRulesModal
        scope={{ facility: rulesFor, club }}
        onClose={() => setRulesFor(null)}
        onSaved={() => onChanged?.()}
      />
    )}
    </>
  );
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const BLANK_BLOCK = { start_date: todayISO(), end_date: todayISO(), allDay: true,
                      start_time: '09:00', end_time: '17:00', reason: '' };

/** Periods a facility is out of service. A blocked facility drops out of
 *  capacity, so the slot engine simply stops offering it. */
function MaintenanceModal({ facility, onClose }) {
  const { t } = useTranslation('settings');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState(BLANK_BLOCK);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const load = useCallback(() => {
    if (!facility) return;
    setLoading(true);
    maintenanceBlocksApi.list({ facility: facility.id, ordering: '-start_date' })
      .then((d) => setRows(d.results || d))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [facility]);

  useEffect(() => { setForm(BLANK_BLOCK); load(); }, [facility, load]);

  async function add() {
    setBusy(true);
    try {
      await maintenanceBlocksApi.create({
        facility: facility.id,
        start_date: form.start_date,
        end_date: form.end_date,
        start_time: form.allDay ? null : form.start_time,
        end_time: form.allDay ? null : form.end_time,
        reason: form.reason,
      });
      toast.success(t('maintenanceScheduled'));
      setForm(BLANK_BLOCK);
      load();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableSaveMaintenancePeriod')));
    } finally { setBusy(false); }
  }

  async function remove(id) {
    try { await maintenanceBlocksApi.remove(id); load(); }
    catch (e) { toast.error(apiErrorMessage(e, t('unableRemoveMaintenancePeriod'))); }
  }

  return (
    <Modal open={Boolean(facility)} onClose={onClose} size="md"
      title={facility ? `Maintenance \u00b7 ${facility.name}` : ''}
      footer={<button className="btn btn-secondary" onClick={onClose}>{t('done')}</button>}>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        While a period is in force this facility is not offered for booking.
        Existing bookings are not cancelled - move or cancel those separately.
      </p>

      <div style={{ display: 'grid', gap: 10, padding: 12, marginBottom: 16,
                    border: '1px solid var(--color-border-soft)', borderRadius: 10 }}>
        <div className="row">
          <div className="col"><FormField label={t('from')}>
            <input className="form-input" type="date" value={form.start_date}
              onChange={(e) => set('start_date', e.target.value)} /></FormField></div>
          <div className="col"><FormField label="To" hint={t('inclusive')}>
            <input className="form-input" type="date" value={form.end_date}
              onChange={(e) => set('end_date', e.target.value)} /></FormField></div>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.allDay}
            onChange={(e) => set('allDay', e.target.checked)} />
          {t('allDay')}
        </label>
        {!form.allDay && (
          <div className="row">
            <div className="col"><FormField label={t('startTime')}>
              <input className="form-input" type="time" value={form.start_time}
                onChange={(e) => set('start_time', e.target.value)} /></FormField></div>
            <div className="col"><FormField label={t('endTime')}>
              <input className="form-input" type="time" value={form.end_time}
                onChange={(e) => set('end_time', e.target.value)} /></FormField></div>
          </div>
        )}
        <FormField label={t('common:labels.reason')} hint={t('shownStaffWhenSlotUnavailable')}>
          <input className="form-input" value={form.reason} placeholder={t('eGResurfacing')}
            onChange={(e) => set('reason', e.target.value)} />
        </FormField>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={add} disabled={busy}>
            {busy ? t('common:state.saving') : t('scheduleMaintenance')}
          </button>
        </div>
      </div>

      {loading ? <p className="muted">Loading…</p>
        : rows.length === 0 ? <p className="muted">{t('noMaintenanceScheduled')}</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', gap: 8, padding: '8px 10px',
              border: '1px solid var(--color-border-soft)', borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                  {r.start_date === r.end_date ? r.start_date : `${r.start_date} to ${r.end_date}`}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {r.is_all_day ? 'All day' : `${String(r.start_time).slice(0, 5)} - ${String(r.end_time).slice(0, 5)}`}
                  {r.reason ? ` \u00b7 ${r.reason}` : ''}
                </div>
              </div>
              <button className="icon-btn" onClick={() => remove(r.id)} aria-label={t('common:actions.remove')}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/**
 * Per-facility business hours. Most units never need this: a facility inherits
 * its club, and a unit that differs only on Friday stores only Friday. The
 * modal therefore opens on "Use club schedule" and stays out of the way.
 */
function FacilityHoursModal({ facility, club, onClose, onSaved }) {
  const { t } = useTranslation('settings');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!facility) { setForm(null); return; }
    const hasCustom = facility.booking_hours
      && Object.keys(facility.booking_hours).length > 0;
    setForm({
      customHours: hasCustom,
      booking_hours: hasCustom ? facility.booking_hours : {},
      slot_minutes: facility.slot_minutes ?? '',
      buffer_before_minutes: facility.buffer_before_minutes ?? '',
      buffer_after_minutes: facility.buffer_after_minutes ?? '',
    });
  }, [facility]);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    setBusy(true);
    try {
      const updated = await facilitiesApi.update(facility.id, {
        booking_hours: form.customHours ? form.booking_hours : {},
        slot_minutes: form.customHours && form.slot_minutes !== ''
          ? Number(form.slot_minutes) : null,
        buffer_before_minutes: form.customHours && form.buffer_before_minutes !== ''
          ? Number(form.buffer_before_minutes) : null,
        buffer_after_minutes: form.customHours && form.buffer_after_minutes !== ''
          ? Number(form.buffer_after_minutes) : null,
      });
      toast.success(`Hours saved for ${facility.name}`);
      onSaved?.(updated);
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableSaveHoursPleaseTry')));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      open={Boolean(facility && form)}
      onClose={busy ? () => {} : onClose}
      title={facility ? `Business hours - ${facility.name}` : 'Business hours'}
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" type="button" disabled={busy}
            onClick={onClose}>{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" type="button" disabled={busy}
            onClick={submit}>{busy ? t('common:state.saving') : t('saveHours')}</button>
        </>
      }
    >
      {/* `facility` must be in the guard, not just `form`. Saving or cancelling
          sets the facility to null, and React evaluates these children before
          Modal can decide it is closed - while `form` still holds the previous
          value, because the effect that clears it runs after the render. That
          read of `facility.id` threw and took the whole page down. */}
      {facility && form && (
        <ScheduleScopePanel
          scope="facility"
          parentLabel={club?.name || 'Club'}
          query={{ facility: facility.id }}
          custom={form.customHours}
          onCustom={(v) => set('customHours', v)}
          week={form.booking_hours}
          onWeek={(v) => set('booking_hours', v)}
          slotMinutes={form.slot_minutes}
          onSlotMinutes={(v) => set('slot_minutes', v)}
          bufferBefore={form.buffer_before_minutes}
          bufferAfter={form.buffer_after_minutes}
          onBuffers={(before, after) => {
            set('buffer_before_minutes', before);
            set('buffer_after_minutes', after);
          }}
        />
      )}
    </Modal>
  );
}
