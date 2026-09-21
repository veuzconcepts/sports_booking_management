import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Mail, Phone, Star, Pencil, CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { PageTabs } from '../../components/PageTabs.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ScheduleEditor } from '../../components/ScheduleEditor.jsx';
import { useTimeFormat } from '../../services/timeformat.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { useTabParam } from '../../hooks/useTabParam.js';
import { DataTable } from '../../components/DataTable.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { actorLabel } from '../../utils/actor';
import { formatDateTime } from '../../services/timeformat.jsx';
import {
  staffApi, transfersApi, employmentTypes,
  transferShiftOptions, transferStatusLabels,
} from '../../services/staffService.js';
import { clubsApi } from '../../services/clubsService.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { apiErrorMessage } from '../../utils/apiError';
import {
  validateWeek, summarizeDay, DAY_KEYS, DAY_LABELS,
} from '../../utils/schedule.js';

// Friendly labels for audit event names shown in the Activity Log.
const ACTIVITY_LABELS = {
  staff_created: 'Staff created', staff_updated: 'Profile updated', staff_deleted: 'Staff deleted',
  staff_shift_schedule_updated: 'Shift schedule updated',
  shift_created: 'Shift added', shift_updated: 'Shift updated', shift_deleted: 'Shift removed',
  user_created: 'Account created', user_updated: 'Account updated',
  user_activated: 'Account activated', user_deactivated: 'Account deactivated',
  user_soft_deleted: 'Account deleted', admin_set_password: 'Password reset',
  force_password_change: 'Forced password change', user_unlocked: 'Account unlocked',
  admin_disabled_mfa: 'MFA disabled', admin_reset_mfa: 'MFA reset',
  booking_assigned: 'Booking assigned',
  staff_club_transfer_requested: 'Club transfer requested',
  staff_club_transfer_approved: 'Club transfer approved',
  staff_club_transfer_completed: 'Club transfer completed',
  staff_club_transfer_cancelled: 'Club transfer cancelled',
};
const MODULE_OF = (event) => (event || '').split('_')[0]
  .replace('staff', 'Staff').replace('shift', 'Staff').replace('user', 'Accounts')
  .replace('admin', 'Accounts').replace('force', 'Accounts').replace('booking', 'Bookings')
  .replace('_', ' ') || '-';

export default function StaffDetailPage() {
  const { t } = useTranslation('staff');
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const canEdit = hasPerm('staff.edit');
  const canViewActivity = hasPerm('staff.activity');
  const canTransfer = hasPerm('staff.transfer');
  const canClubHistory = hasPerm('staff.club_history');
  const [tab, setTab] = useTabParam('overview');
  const [staff, setStaff] = useState(null);
  const [performance, setPerformance] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([staffApi.get(id), staffApi.performanceHistory(id)])
      .then(([s, p]) => { setStaff(s); setPerformance(p); })
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadStaffMemberPlease'))))
      .finally(() => setLoading(false));
  }, [id, t]);

  useEffect(load, [load]);

  if (loading) {
    return <div className="card"><div className="card-body center" style={{ padding: 64 }}><span className="muted">Loading…</span></div></div>;
  }
  if (!staff) return null;

  return (
    <>
      <button className="btn btn-ghost" onClick={() => navigate('/staff')} style={{ marginBottom: 12 }}>
        <ArrowLeft size={15} /> {t('backStaff')}
      </button>

      <PageHeader
        title={staff.full_name}
        subtitle={`${staff.employee_id} · ${(staff.role || '').replace('_', ' ')}`}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <StatusBadge tone={staff.is_available ? 'success' : 'muted'}
                         label={staff.is_available ? t('available') : t('off')} />
            {canTransfer && (
              <button className="btn btn-secondary" onClick={() => setTransferOpen(true)}>
                <ArrowLeft size={15} style={{ transform: 'rotate(180deg)' }} /> {t('transfer')}
              </button>
            )}
            {canEdit && (
              <button className="btn btn-secondary" onClick={() => setEditOpen(true)}>
                <Pencil size={15} /> {t('common:actions.edit')}
              </button>
            )}
          </div>
        }
      />

      <PageTabs
        active={tab}
        onChange={setTab}
        label={t('overview')}
        tabs={[
          { key: 'overview', label: t('overview') },
          ...(canViewActivity ? [{ key: 'activity', label: t('activityLog') }] : []),
          ...(canClubHistory ? [{ key: 'history', label: t('clubHistory') }] : []),
        ]}
      />

      {tab === 'activity' && canViewActivity ? (
        <ActivityLogTab staffId={id} />
      ) : tab === 'history' && canClubHistory ? (
        <ClubHistoryTab staffId={id} canApprove={hasPerm('staff.transfer_approve')}
          canCancel={hasPerm('staff.transfer_cancel')} refreshKey={transferOpen} />
      ) : (
      <div className="row">
        <div className="col" style={{ flex: '1 1 300px' }}>
          <div className="card">
            <div className="card-header"><h3 className="card-title">{t('profile')}</h3></div>
            <div className="card-body">
              <KV icon={Mail} label={t('common:labels.email')}>{staff.email}</KV>
              <KV icon={Phone} label={t('common:labels.phone')}>{staff.phone || '-'}</KV>
              <KV label={t('employment')}>{(staff.employment_type || '').replace('_', ' ')}</KV>
              <KV label={t('baseClub')}>{staff.base_club_name || '-'}</KV>
              <KV label={t('skills')}>{staff.skills || '-'}</KV>
              <KV icon={Star} label={t('rating')}>{Number(staff.rating).toFixed(2)} / 5</KV>
              {staff.hired_on && <KV label={t('hired')}>{new Date(staff.hired_on).toLocaleDateString()}</KV>}
            </div>
          </div>

          <div style={{ height: 16 }} />

          <div className="card">
            <div className="card-header"><h3 className="card-title">{t('performance')}</h3></div>
            {performance.length === 0 ? (
              <div className="empty"><p>{t('noPerformanceSnapshotsYet')}</p></div>
            ) : (
              <div className="table-wrapper">
                <table className="table">
                  <thead><tr><th>{t('common:labels.date')}</th><th>{t('jobs')}</th><th>{t('rating')}</th><th>{t('time')}</th></tr></thead>
                  <tbody>
                    {performance.map((p) => (
                      <tr key={p.id}>
                        <td>{new Date(p.date).toLocaleDateString()}</td>
                        <td>{p.jobs_completed}</td>
                        <td>{Number(p.avg_rating).toFixed(1)}</td>
                        <td>{Number(p.on_time_percent).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="col" style={{ flex: '1.3 1 380px' }}>
          <StaffShiftSection staff={staff} onSaved={load} canEdit={canEdit} />
        </div>
      </div>
      )}

      <EditStaffModal open={editOpen} staff={staff}
        onClose={() => setEditOpen(false)}
        onSaved={() => { setEditOpen(false); load(); }} />

      <TransferModal open={transferOpen} staff={staff}
        onClose={() => setTransferOpen(false)}
        onDone={() => { setTransferOpen(false); setTab('history'); load(); }} />
    </>
  );
}

function ActivityLogTab({ staffId }) {
  const { t } = useTranslation('staff');
  const { user } = useAuth();
  const fetcher = useCallback((q) => staffApi.activity(staffId, q), [staffId]);
  const { rows, loading, count, query, setQuery } = useApiList(fetcher, { ordering: '-created_at' });
  return (
    <DataTable
      loading={loading}
      rows={rows}
      page={query.page || 1}
      count={count}
      onPageChange={(p) => setQuery({ ...query, page: p })}
      emptyTitle={t('noActivityYet')}
      emptyHint={t('profileShiftAccountRoleAssignment')}
      columns={[
        { key: 'when', header: t('when'), nowrap: true, render: (r) => formatDateTime(r.created_at) },
        { key: 'action', header: t('action'), render: (r) => ACTIVITY_LABELS[r.event] || r.event || '-' },
        { key: 'by', header: 'By', render: (r) => actorLabel(r.actor, r.actor_name, user?.id) },
        { key: 'details', header: t('details'), render: (r) => <ActivityDetails p={r.payload_summary} /> },
        { key: 'source', header: t('source'), render: (r) => MODULE_OF(r.event) },
        { key: 'ip', header: 'IP', nowrap: true, render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.ip || '-'}</span> },
      ]}
    />
  );
}

function ActivityDetails({ p }) {
  if (!p || typeof p !== 'object') return '-';
  const { event, staff, user, changes, ...rest } = p;   // drop noisy keys
  if (changes && typeof changes === 'object') {
    return (
      <div style={{ fontSize: 12.5 }}>
        {Object.entries(changes).map(([f, v]) => (
          <div key={f}>
            <strong>{f.replace(/_/g, ' ')}:</strong>{' '}
            {v && typeof v === 'object'
              ? <>{String(v.from ?? '-')} → {String(v.to ?? '-')}</>
              : String(v)}
          </div>
        ))}
      </div>
    );
  }
  const bits = Object.entries(rest)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  return bits.length ? <span className="muted" style={{ fontSize: 12.5 }}>{bits.join(' · ')}</span> : '-';
}

const TRANSFER_STATUS_TONE = {
  pending_approval: 'warning', approved: 'info', completed: 'success', cancelled: 'muted',
};

function ReassignRow({ label, options, value, onChange }) {
  const { t } = useTranslation('staff');
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ flex: '1 1 170px', minWidth: 0, maxWidth: 240 }}>
        <Select2 options={[{ value: '', label: t('keepCurrent') }, ...options]}
          value={value} onChange={onChange} placeholder={t('keepCurrent')} />
      </div>
    </div>
  );
}

function TransferModal({ open, staff, onClose, onDone }) {
  const { t } = useTranslation('staff');
  const [clubs, setClubs] = useState([]);
  const [staffOpts, setStaffOpts] = useState([]);
  const [impact, setImpact] = useState(null);
  const [form, setForm] = useState({ to_club: '', transfer_type: 'immediate', effective_date: '', reason: '', remarks: '', shift_option: 'apply_club' });
  const [reassign, setReassign] = useState({ bookings: {} });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !staff) return;
    setForm({ to_club: '', transfer_type: 'immediate', effective_date: '', reason: '', remarks: '', shift_option: 'apply_club' });
    setReassign({ bookings: {} });
    setErrors({});
    clubsApi.list({ is_active: 'true' })
      .then((d) => setClubs((d.results || d).filter((s) => s.id !== staff.base_club)));
    staffApi.list({ page_size: 100 })
      .then((d) => setStaffOpts((d.results || d).filter((s) => s.id !== staff.id)
        .map((s) => ({ value: s.user, label: `${s.full_name} (${s.base_club_name || '-'})` }))));
    staffApi.transferImpact(staff.id).then(setImpact).catch(() => setImpact(null));
  }, [open, staff]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setReassignFor = (kind, id, v) => setReassign((r) => {
    const m = { ...r[kind] };
    if (v) m[id] = Number(v); else delete m[id];
    return { ...r, [kind]: m };
  });
  const scheduled = form.transfer_type === 'scheduled';

  async function submit() {
    setBusy(true); setErrors({});
    try {
      const plan = {};
      if (Object.keys(reassign.bookings).length) plan.bookings = reassign.bookings;
      await transfersApi.create({
        staff: staff.id, to_club: Number(form.to_club), transfer_type: form.transfer_type,
        ...(scheduled ? { effective_date: form.effective_date } : {}),
        reason: form.reason, remarks: form.remarks, shift_option: form.shift_option,
        reassign_plan: plan,
      });
      toast.success(t('transferRequestedPendingApproval'));
      onDone?.();
    } catch (e) {
      const d = e.response?.data;
      if (d && typeof d === 'object') setErrors(d);
      toast.error(apiErrorMessage(e, t('unableCreateTransferPleaseTry')));
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('transferEmployee')} side size="lg"
      footer={(
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !form.to_club}>
            {busy ? t('submitting') : t('requestTransfer')}
          </button>
        </>
      )}>
      <div className="row">
        <div className="col"><FormField label={t('currentClub')}>
          <input className="form-input" value={staff?.base_club_name || '-'} disabled />
        </FormField></div>
        <div className="col"><FormField label={t('newClub')} error={errors.to_club}>
          <Select2 options={clubs.map((s) => ({ value: s.id, label: s.name }))}
            value={form.to_club} onChange={(v) => setField('to_club', v)} placeholder={t('chooseClub')} />
        </FormField></div>
      </div>
      <div className="row">
        <div className="col"><FormField label={t('type')}>
          <Select2 options={[{ value: 'immediate', label: t('immediate') }, { value: 'scheduled', label: t('scheduled') }]}
            value={form.transfer_type} onChange={(v) => setField('transfer_type', v)} />
        </FormField></div>
        {scheduled && (
          <div className="col"><FormField label={t('effectiveDate')} error={errors.effective_date}>
            <input className="form-input" type="date" value={form.effective_date}
              onChange={(e) => setField('effective_date', e.target.value)} />
          </FormField></div>
        )}
        <div className="col"><FormField label={t('shiftAfterTransfer')}>
          <Select2 options={transferShiftOptions(t)} value={form.shift_option}
            onChange={(v) => setField('shift_option', v)} />
        </FormField></div>
      </div>
      <FormField label={t('common:labels.reason')}>
        <input className="form-input" value={form.reason} onChange={(e) => setField('reason', e.target.value)}
          placeholder={t('eGOperationalExpansion')} />
      </FormField>
      <FormField label={t('remarks')}>
        <textarea className="form-textarea" rows={2} value={form.remarks} onChange={(e) => setField('remarks', e.target.value)} />
      </FormField>

      <div className="modal-section">{t('impact')}</div>
      {!impact ? (
        <p className="muted">Checking impact…</p>
      ) : (
        <>
          <p style={{ fontSize: 13 }}>
            {impact.counts.bookings} future booking(s), {impact.counts.shifts} upcoming shift(s).
          </p>
          {impact.bookings.length > 0 && (
            <p className="muted" style={{ fontSize: 12.5 }}>{t('keepAssignmentsReassignEachAnother')}</p>
          )}
          {impact.bookings.map((bk) => (
            <ReassignRow key={`b${bk.id}`} label={`Booking ${bk.reference} · ${bk.scheduled_date}`}
              options={staffOpts} value={reassign.bookings[bk.id] || ''}
              onChange={(v) => setReassignFor('bookings', bk.id, v)} />
          ))}
        </>
      )}
    </Modal>
  );
}

function ClubHistoryTab({ staffId, canApprove, canCancel }) {
  const { t } = useTranslation('staff');
  const fetcher = useCallback((q) => transfersApi.list({ ...q, staff: staffId }), [staffId]);
  const { rows, loading, count, query, setQuery, reload } = useApiList(fetcher, { ordering: '-created_at' });
  const [cancelId, setCancelId] = useState(null);
  const [busy, setBusy] = useState(false);

  async function approve(transferId) {
    setBusy(true);
    try { await transfersApi.approve(transferId); toast.success(t('transferApproved')); reload(); }
    catch (e) { toast.error(apiErrorMessage(e, t('unableApproveTransferPleaseTry'))); }
    finally { setBusy(false); }
  }
  async function doCancel() {
    setBusy(true);
    try { await transfersApi.cancel(cancelId); toast.success(t('transferCancelled')); setCancelId(null); reload(); }
    catch (e) { toast.error(apiErrorMessage(e, t('unableCancelTransferPleaseTry'))); }
    finally { setBusy(false); }
  }

  return (
    <>
      <DataTable
        loading={loading} rows={rows} page={query.page || 1} count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        emptyTitle={t('noTransfersYet')} emptyHint={t('clubTransfersEmployeeWillAppear')}
        columns={[
          { key: 'route', header: t('fromTo'), render: (r) => `${r.from_club_name || '-'} → ${r.to_club_name || '-'}` },
          { key: 'effective', header: t('effective'), nowrap: true, render: (r) => new Date(r.effective_date).toLocaleDateString() },
          { key: 'reason', header: t('common:labels.reason'), render: (r) => r.reason || '-' },
          { key: 'status', header: t('common:labels.status'), render: (r) => <StatusBadge tone={TRANSFER_STATUS_TONE[r.status]} label={transferStatusLabels(t)[r.status] || r.status} /> },
          { key: 'by', header: t('requested'), render: (r) => r.created_by_name || '-' },
          { key: 'approved', header: t('approved'), render: (r) => r.approved_by_name || '-' },
          {
            key: 'actions', header: '', render: (r) => (
              (r.status === 'pending_approval' || r.status === 'approved') ? (
                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  {canApprove && r.status === 'pending_approval' && (
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => approve(r.id)}>{t('common:actions.approve')}</button>
                  )}
                  {canCancel && (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setCancelId(r.id)}>{t('common:actions.cancel')}</button>
                  )}
                </div>
              ) : null
            ),
          },
        ]}
      />
      <ConfirmDialog open={Boolean(cancelId)} tone="danger" title={t('cancelTransfer')}
        message={t('cancelClubTransfer')} confirmLabel={t('cancelTransfer')} busy={busy}
        onConfirm={doCancel} onClose={() => { if (!busy) setCancelId(null); }} />
    </>
  );
}

function EditStaffModal({ open, staff, onClose, onSaved }) {
  const { t } = useTranslation('staff');
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && staff) {
      setForm({
        employee_id: staff.employee_id || '',
        employment_type: staff.employment_type || 'full_time',
        base_site: staff.base_club || '',
        skills: staff.skills || '',
        hired_on: staff.hired_on || '',
        is_available: Boolean(staff.is_available),
        notes: staff.notes || '',
      });
    }
  }, [open, staff]);

  async function save() {
    setBusy(true);
    try {
      await staffApi.update(staff.id, {
        ...form, hired_on: form.hired_on || null, base_site: form.base_site || null,
      });
      toast.success(t('staffUpdated'));
      onSaved?.();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUpdateStaffMemberPlease')));
    } finally { setBusy(false); }
  }

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open={open} onClose={onClose} title={t('editStaff')} size="md"
      footer={(
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? t('common:state.saving') : t('common:actions.saveChanges')}
          </button>
        </>
      )}>
      <div className="row">
        <div className="col">
          <FormField label={t('employeeId')}>
            <input className="form-input" value={form.employee_id || ''}
              onChange={(e) => set('employee_id', e.target.value)} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('employmentType')}>
            <Select2 options={employmentTypes(t)} value={form.employment_type}
              onChange={(v) => set('employment_type', v)} />
          </FormField>
        </div>
      </div>
      <div className="row">
        <div className="col">
          <FormField label={t('baseClub')} hint={t('useTransferEmployeeChangeClub')}>
            <input className="form-input" value={staff?.base_club_name || '-'} disabled />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('hired2')}>
            <input className="form-input" type="date" value={form.hired_on || ''}
              onChange={(e) => set('hired_on', e.target.value)} />
          </FormField>
        </div>
      </div>
      <FormField label={t('skills')} hint={t('commaSeparatedTagsEG')}>
        <input className="form-input" value={form.skills || ''}
          onChange={(e) => set('skills', e.target.value)} />
      </FormField>
      <FormField label={t('common:labels.notes')}>
        <textarea className="form-textarea" rows={2} value={form.notes || ''}
          onChange={(e) => set('notes', e.target.value)} />
      </FormField>
      <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13.5 }}>
        <input type="checkbox" checked={Boolean(form.is_available)}
          onChange={(e) => set('is_available', e.target.checked)} />
        {t('availableNewAssignments')}
      </label>
    </Modal>
  );
}

const SOURCE_LABEL = {
  employee: 'Using Employee Schedule',
  club: 'Using Club Schedule',
  organization: 'Using Organization Default Schedule',
};

function StaffShiftSection({ staff, onSaved, canEdit }) {
  const { t } = useTranslation('staff');
  const hasCustom = Boolean(staff.shift_hours && Object.keys(staff.shift_hours).length);
  const [custom, setCustom] = useState(hasCustom);
  const [draft, setDraft] = useState(hasCustom ? staff.shift_hours : staff.effective_schedule);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCustom(hasCustom);
    setDraft(hasCustom ? staff.shift_hours : staff.effective_schedule);
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff.id, staff.shift_hours, staff.effective_schedule]);

  async function save(week) {
    if (week && Object.keys(week).length) {
      const res = validateWeek(week);
      if (!res.ok) { setErrors(res.errors); toast.error(t('fixHighlightedDaysBeforeSaving')); return; }
    }
    setErrors({});
    setBusy(true);
    try {
      await staffApi.setSchedule(staff.id, week);
      toast.success(t('shiftScheduleSavedSuccessfully'));
      onSaved?.();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableSaveSchedulePleaseTry')));
    } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title"><CalendarClock size={15} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />{t('shiftSchedule')}</h3>
          <p className="card-subtitle">{t('weeklyWorkingHoursEmployeeElse')}</p>
        </div>
        <span className="badge badge-info">{SOURCE_LABEL[staff.schedule_source] || 'Schedule'}</span>
      </div>
      <div className="card-body">
        {canEdit && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600, marginBottom: 12 }}>
            <input type="checkbox" checked={custom}
              onChange={(e) => {
                const on = e.target.checked;
                setCustom(on);
                if (on) setDraft(staff.shift_hours && Object.keys(staff.shift_hours).length ? staff.shift_hours : staff.effective_schedule);
                else save({});   // disabling custom = inherit
              }} />
            {t('useCustomEmployeeSchedule')}
          </label>
        )}

        {custom ? (
          <>
            {canEdit && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
                  onClick={() => { setDraft(staff.club_schedule); setErrors({}); }}>{t('copyClub')}</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
                  onClick={() => { setDraft(staff.organization_schedule); setErrors({}); }}>{t('copyOrganization')}</button>
              </div>
            )}
            <ScheduleEditor
              scope="organization"
              value={draft}
              onChange={canEdit ? setDraft : () => {}}
              canEdit={canEdit}
              showConfig={false}
            />
            {Object.keys(errors).length > 0 && (
              <div style={{ marginTop: 8 }}>
                {DAY_KEYS.filter((d) => errors[d]).map((d) => (
                  <div key={d} style={{ fontSize: 12.5, color: 'var(--color-danger, #dc2626)' }}>
                    <strong>{DAY_LABELS[d]}:</strong> {errors[d]}
                  </div>
                ))}
              </div>
            )}
            {canEdit && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => save(draft)}>
                  {busy ? t('common:state.saving') : t('saveSchedule')}
                </button>
                <button className="btn btn-secondary" disabled={busy}
                  onClick={() => { setDraft(staff.shift_hours); setErrors({}); }}>{t('common:actions.reset')}</button>
              </div>
            )}
          </>
        ) : (
          <ScheduleSummary
            title={`Effective hours (${(SOURCE_LABEL[staff.schedule_source] || '').replace('Using ', '') || 'inherited'})`}
            week={staff.effective_schedule}
          />
        )}

        {/* Single-view reference: club + organization schedules */}
        <div className="row" style={{ marginTop: 16 }}>
          <div className="col"><ScheduleSummary title={t('clubSchedule')} week={staff.club_schedule} /></div>
          <div className="col"><ScheduleSummary title={t('organizationDefault')} week={staff.organization_schedule} /></div>
        </div>
      </div>
    </div>
  );
}

function ScheduleSummary({ title, week }) {
  const { format24 } = useTimeFormat();
  return (
    <div>
      <div className="modal-section" style={{ marginTop: 0 }}>{title}</div>
      {/* responsive-ok: label and value; the value track absorbs the width. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '2px 12px', fontSize: 12.5 }}>
        {DAY_KEYS.map((d) => (
          <span key={d} style={{ display: 'contents' }}>
            <span style={{ fontWeight: 600 }}>{DAY_LABELS[d].slice(0, 3)}</span>
            <span className="muted">{summarizeDay((week || {})[d], format24)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function KV({ icon: Icon, label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0' }}>
      {Icon && <Icon size={16} style={{ marginTop: 2, color: 'var(--color-text-muted)' }} />}
      <div style={{ flex: 1 }}>
        <div className="muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
        <div style={{ fontWeight: 500 }}>{children}</div>
      </div>
    </div>
  );
}
