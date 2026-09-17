import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Pencil, Eye, KeyRound, KeySquare, ShieldCheck, ShieldOff,
  UserCheck, UserX, Unlock, Trash2, Lock, Monitor, LogOut, Shield, Settings,
  User as UserIcon, FileText, RefreshCw, CheckSquare, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import { Controller, useForm } from 'react-hook-form';

import { PageTabs } from '../../components/PageTabs.jsx';
import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { Drawer } from '../../components/Drawer.jsx';
import { RowMenu } from '../../components/RowMenu.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';

import { userRoles, accessApi, accountApi, usersApi, sessionsApi } from '../../services/usersService.js';
import { clubsApi } from '../../services/clubsService.js';
import { facilitiesApi } from '../../services/facilitiesService.js';
import { formatDateTime } from '../../services/timeformat.jsx';
import { useTabParam } from '../../hooks/useTabParam.js';
import { assignableRoleOptions, canManageUser, canTransferSuperAdmin } from '../../utils/rbac.js';

// Roles that are club-scoped (assigned to specific locations).
const SITE_SCOPED_ROLES = ['club_admin', 'manager', 'facility_operator', 'facility_staff'];

const roleLabel = (t, v) => userRoles(t).find((r) => r.value === v)?.label || v;

// Status filter is a composite over is_active / locked / is_deleted (the backend
// has no single "status" field). "Locked" is a real server-side filter
// (?locked=true, matching the is_locked property) - not a client-side post-filter.
const statusOptions = (t) => [
  { value: 'active',   label: t('common:state.active') },
  { value: 'inactive', label: t('common:state.inactive') },
  { value: 'locked',   label: t('locked') },
  { value: 'deleted',  label: t('deleted') },
];
const mfaOptions = (t) => [
  { value: 'true',  label: t('enrolled') },
  { value: 'false', label: t('notEnrolled') },
];

const fmtDateTime = (iso) => (iso ? formatDateTime(iso) : '-');

// Pull a human message out of a DRF error response (detail or field errors).
function apiErr(e, fallback) {
  const d = e?.response?.data;
  if (!d) return fallback;
  if (typeof d.detail === 'string') return d.detail;
  const parts = Object.entries(d).map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`);
  return parts.join(' · ') || fallback;
}

// Single status badge with a clear precedence: deleted > locked > inactive > active.
function StatusCell({ u }) {
  const { t } = useTranslation('users');
  if (u.is_deleted) return <StatusBadge tone="danger" label={t('deleted')} />;
  if (u.is_locked) return <StatusBadge tone="warning" label={t('locked')} />;
  if (!u.is_active) return <StatusBadge tone="muted" label={t('common:state.inactive')} />;
  return <StatusBadge tone="success" label={t('common:state.active')} />;
}

// Per-channel login access (additional to role/permissions): Web portal + Mobile.
function AccessCell({ u }) {
  const { t } = useTranslation('users');
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      <StatusBadge tone={u.web_login_enabled ? 'success' : 'muted'}
                   label={u.web_login_enabled ? t('web') : t('noWeb')} />
      <StatusBadge tone={u.mobile_login_enabled ? 'success' : 'muted'}
                   label={u.mobile_login_enabled ? t('mobile') : t('noMobile')} />
    </span>
  );
}

// Read-only MFA status, keyed on the POLICY (Disabled / Enabled / Enforced),
// with enrolment shown separately. Note: admin "Enable" makes MFA *available*
// (optional) - the user still enrols on their device, so a just-enabled user is
// "Enabled" (not yet "Enrolled"), NOT "Disabled".
function MfaCell({ u }) {
  const { t } = useTranslation('users');
  // One mutually-exclusive status badge: Enforced > Disabled > Enrolled > Enabled.
  let tone = 'info';
  let label = t('common:state.enabled');                       // available (optional), not yet set up
  if (u.mfa_policy === 'enforced') { tone = 'warning'; label = t('enforced'); }
  else if (u.mfa_policy === 'disabled') { tone = 'muted'; label = t('common:state.disabled'); }
  else if (u.mfa_enabled) { tone = 'success'; label = t('enrolled'); }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <StatusBadge tone={tone} label={label} />
      {u.mfa_required && <StatusBadge tone="info" label={t('role')} />}
    </span>
  );
}

// Derive the Status filter's current value from the query params.
export default function UsersPage() {
  const { t } = useTranslation('users');
  const [tab, setTab] = useTabParam('users');
  return (
    <ListPage
      title={t('userManagement')}
      subtitle={t('manageUserAccountsMonitorActive')}
      tabs={(
        <PageTabs
          active={tab}
          onChange={setTab}
          label={t('userManagement')}
          tabs={[
            { key: 'users', label: t('title') },
            { key: 'sessions', label: t('activeSessions') },
          ]}
        />
      )}
    >
      {tab === 'users' ? <UsersTable /> : <SessionsAdminPage />}
    </ListPage>
  );
}

/* -------------------- Confirm-dialog copy per action --------------------- */
// A factory rather than a constant: the copy has to follow the active language,
// and `t` only exists inside a component.
const confirmCopy = (t) => {
  const sentence = (kind, email) => (
    <Trans
      t={t}
      i18nKey={`confirm.${kind}.message`}
      values={{ email }}
      components={{ b: <strong />, i: <em /> }}
    />
  );
  const entry = (kind, tone) => ({
    title: t(`confirm.${kind}.title`),
    label: t(`confirm.${kind}.label`),
    tone,
    msg: (u) => sentence(kind, u.email),
  });
  return {
    deactivate: entry('deactivate', 'danger'),
    activate: entry('activate', 'primary'),
    unlock: entry('unlock', 'primary'),
    forcepw: entry('forcepw', 'primary'),
    resetmfa: entry('resetmfa', 'danger'),
    delete: entry('delete', 'danger'),
    transfer: entry('transfer', 'danger'),
  };
};

/* ----------------------------- Users table ------------------------------ */
const USER_GROUP_KEYS = [
  ['role', 'groups.role'],
  ['is_active', 'groups.status'],
];

function UsersTable() {
  const { t } = useTranslation('users');
  const { t: tc } = useTranslation('common');
  const { user: me, hasPerm } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [viewUser, setViewUser] = useState(null);
  const [pwUser, setPwUser] = useState(null);
  const [confirm, setConfirm] = useState(null);   // { user, kind }
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmErr, setConfirmErr] = useState('');
  const [roles, setRoles] = useState([]);
  const fetcher = useCallback((q) => usersApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const actorIsSuper = me?.role === 'super_admin';
  // Mirror backend _guard_manage_target (UI honesty only - backend is the gate).
  const canManage = useCallback((u) => canManageUser(me, u), [me]);

  // Mirror backend _can_manage_sessions: own; super manages anyone; admin
  // manages only non-senior users. Drives whether the drawer shows Sessions.
  const canManageSessions = useCallback((u) => {
    if (u.id === me?.id) return true;
    if (actorIsSuper) return true;
    if (me?.role === 'admin' && !(u.is_super_admin || u.role === 'admin')) return true;
    return false;
  }, [me, actorIsSuper]);

  // ---- bulk actions (multi-user; reuse the per-user endpoints) --------------
  // Selection now lives in ListView, which clears it whenever the query
  // changes. `bulk` carries the chosen action AND the rows it was raised for,
  // so the confirmation cannot drift from what was selected.
  const [bulk, setBulk] = useState(null);       // { ...action, targets: [...] }
  const [bulkBusy, setBulkBusy] = useState(false);
  const selectedUsers = bulk?.targets || [];

  // Each bulk action reuses an existing per-user endpoint (no new behaviour);
  // ineligible rows (guards / self / owner) are skipped, backend still enforces.
  const BULK_ACTIONS = [
    { key: 'activate', label: t('common:actions.activate'), tone: 'primary', done: 'activated', icon: <UserCheck size={14} />, primary: true,
      eligible: (u) => canManage(u) && !u.is_deleted && !u.is_active,
      run: (u) => usersApi.activate(u.id) },
    { key: 'deactivate', label: t('common:actions.deactivate'), tone: 'danger', done: 'deactivated', icon: <UserX size={14} />, primary: true,
      eligible: (u) => canManage(u) && !u.is_deleted && u.is_active && u.id !== me?.id && !u.is_super_admin,
      run: (u) => usersApi.deactivate(u.id) },
    { key: 'enable_mfa', label: t('enableMfa'), tone: 'primary', done: 'MFA enabled', icon: <ShieldCheck size={14} />,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && !u.is_super_admin && u.role !== 'admin' && !u.mfa_required && u.mfa_policy === 'disabled',
      run: (u) => usersApi.setMfaPolicy(u.id, 'optional') },
    { key: 'enforce_mfa', label: t('enforceMfa'), tone: 'primary', done: 'MFA enforced', icon: <Shield size={14} />,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && !u.is_super_admin && u.role !== 'admin',
      run: (u) => usersApi.setMfaPolicy(u.id, 'enforced') },
    { key: 'disable_mfa', label: t('disableMfa'), tone: 'danger', done: 'MFA disabled', icon: <ShieldOff size={14} />,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && !u.is_super_admin && u.role !== 'admin' && !u.mfa_required,
      run: (u) => usersApi.setMfaPolicy(u.id, 'disabled') },
    { key: 'reset_mfa', label: t('resetMfa2'), tone: 'danger', done: 'MFA reset', icon: <RefreshCw size={14} />,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && u.mfa_enabled,
      run: (u) => usersApi.resetMfa(u.id) },
    { key: 'force_pw', label: t('forcePasswordChange'), tone: 'primary', done: 'flagged for password change', icon: <KeySquare size={14} />, primary: true,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && !u.must_change_password,
      run: (u) => usersApi.forcePasswordChange(u.id) },
    { key: 'logout_all', label: t('forceLogoutAll'), tone: 'danger', done: 'logged out', icon: <LogOut size={14} />, primary: true,
      eligible: (u) => canManageSessions(u) && u.id !== me?.id,
      run: (u) => sessionsApi.terminateAll(u.id) },
    { key: 'delete', label: t('common:actions.delete'), tone: 'danger', done: 'deleted', icon: <Trash2 size={14} />,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && !u.is_super_admin && !u.last_login,
      run: (u) => usersApi.remove(u.id) },
  ];

  async function runBulk() {
    if (!bulk) return;
    const targets = selectedUsers.filter(bulk.eligible);
    const skipped = selectedUsers.length - targets.length;
    setBulkBusy(true);
    let ok = 0; let fail = 0;
    for (const u of targets) {
      try { await bulk.run(u); ok += 1; } catch { fail += 1; }
    }
    setBulkBusy(false);
    setBulk(null);
    reload();
    const parts = [`${ok} ${bulk.done}`];
    if (skipped) parts.push(`${skipped} skipped`);
    if (fail) parts.push(`${fail} failed`);
    (fail ? toast.error : toast.success)(parts.join(' · '));
  }

  useEffect(() => {
    // Default to an empty list: a payload without `roles` must not leave the
    // state undefined, which would throw the moment the filter reads it.
    accessApi.listRoles()
      .then((d) => setRoles(d?.roles || []))
      .catch(() => setRoles([]));
  }, []);


  async function runConfirm() {
    if (!confirm) return;
    const { user: u, kind } = confirm;
    setConfirmBusy(true);
    setConfirmErr('');
    try {
      if (kind === 'deactivate') { await usersApi.deactivate(u.id); toast.success(t('actions.deactivated')); }
      else if (kind === 'activate') { await usersApi.activate(u.id); toast.success(t('actions.activated')); }
      else if (kind === 'unlock') { await usersApi.unlock(u.id); toast.success(t('actions.unlocked')); }
      else if (kind === 'forcepw') { await usersApi.forcePasswordChange(u.id); toast.success(t('actions.mustChangePassword')); }
      else if (kind === 'resetmfa') { await usersApi.disableMfa(u.id); toast.success(t('actions.mfaReset')); }
      else if (kind === 'delete') { await usersApi.remove(u.id); toast.success(t('actions.deleted')); }
      else if (kind === 'transfer') {
        await usersApi.transferSuperAdmin(u.id);
        toast.success(t('actions.ownerTransferred'));
        setConfirm(null);
        // The caller just demoted themselves - reload so their new context applies.
        window.location.assign('/users');
        return;
      }
      setConfirm(null);
      reload();
    } catch (e) {
      // Surface the backend 403/400 inline in the dialog - never a silent fail.
      setConfirmErr(apiErr(e, t('actions.failed')));
    } finally {
      setConfirmBusy(false);
    }
  }

  // Build the per-row kebab. Owner & self end up with no items -> no kebab.
  function rowMenuItems(u) {
    const isSelf = u.id === me?.id;
    if (u.is_super_admin) return [];          // owner: VIEW context only
    const manage = canManage(u);
    return [
      !isSelf && manage && {
        key: 'toggle',
        label: u.is_active ? t('common:actions.deactivate') : t('common:actions.activate'),
        icon: u.is_active ? <UserX size={15} /> : <UserCheck size={15} />,
        danger: u.is_active,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: u.is_active ? 'deactivate' : 'activate' }); },
      },
      !isSelf && manage && !u.is_deleted && {
        key: 'resetpw',
        label: t('resetPassword'),
        icon: <KeyRound size={15} />,
        onClick: () => setPwUser(u),
      },
      !isSelf && manage && !u.is_deleted && !u.must_change_password && {
        key: 'forcepw',
        label: t('forcePasswordChange'),
        icon: <KeySquare size={15} />,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: 'forcepw' }); },
      },
      !isSelf && manage && !u.is_deleted && {
        key: 'resetmfa',
        label: t('resetMfa2'),
        icon: <ShieldOff size={15} />,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: 'resetmfa' }); },
      },
      manage && u.is_locked && {
        key: 'unlock',
        label: t('unlockAccount'),
        icon: <Unlock size={15} />,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: 'unlock' }); },
      },
      // Owner-only: hand the single super-admin to an eligible active staff user.
      canTransferSuperAdmin(me, u) && {
        key: 'transfer',
        label: t('makeSuperAdmin'),
        icon: <ShieldCheck size={15} />,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: 'transfer' }); },
      },
      // Delete is only for accounts that never signed in - once a user has
      // logged in, keep them for history and use Deactivate instead.
      !isSelf && manage && !u.is_deleted && !u.last_login && {
        key: 'delete',
        label: t('deleteUser'),
        icon: <Trash2 size={15} />,
        danger: true,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: 'delete' }); },
      },
    ];
  }

  const cfg = confirm ? confirmCopy(t)[confirm.kind] : null;

  // --- Listing configuration ------------------------------------------------
  const columns = useMemo(() => [
    { key: 'name', header: t('columns.name'), sortKey: 'first_name', minWidth: 180,
      alwaysVisible: true,
      render: (u) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{u.full_name}</span>
          {u.is_super_admin && <StatusBadge tone="info" label={t('badges.owner')} />}
        </span>
      ) },
    { key: 'email', header: t('columns.email'), sortKey: 'email', truncate: true,
      minWidth: 200, render: (u) => <span className="muted">{u.email}</span> },
    { key: 'role', header: t('columns.role'), sortKey: 'role', minWidth: 130,
      render: (u) => <StatusBadge tone="info" label={u.role_name || roleLabel(t, u.role)} /> },
    { key: 'status', header: t('columns.status'), sortKey: 'is_active', minWidth: 110,
      render: (u) => <StatusCell u={u} /> },
    { key: 'access', header: t('columns.loginAccess'), minWidth: 130, priority: 'medium',
      render: (u) => <AccessCell u={u} /> },
    { key: 'mfa', header: t('columns.mfa'), minWidth: 100, priority: 'low',
      render: (u) => <MfaCell u={u} /> },
    { key: 'last_login', header: t('columns.lastLogin'), sortKey: 'last_login',
      nowrap: true, minWidth: 160, priority: 'low',
      render: (u) => <span className="muted">{fmtDateTime(u.last_login)}</span> },
  ], [t]);

  // "Status" is one choice the user makes but several parameters the API needs,
  // so the filter declares the expansion rather than the page rewriting the query.
  const filters = useMemo(() => [
    { key: 'role', label: t('filters.role'), type: 'select',
      options: (roles || []).filter((r) => r.is_system)
        .map((r) => ({ value: r.slug, label: r.name })) },
    { key: 'status', label: t('filters.status'), type: 'select', options: statusOptions(t),
      toParams: (v) => (
        v === 'deleted' ? { is_deleted: 'true' }
          : v === 'active' ? { is_active: 'true', is_deleted: 'false' }
            : v === 'inactive' ? { is_active: 'false', is_deleted: 'false' }
              : v === 'locked' ? { locked: 'true', is_deleted: 'false' }
                : { is_deleted: 'false' }) },
    { key: 'mfa_enabled', label: t('filters.mfa'), type: 'select', options: mfaOptions(t) },
  ], [roles, t]);

  const userGroups = useMemo(
    () => USER_GROUP_KEYS.map(([key, k]) => ({ key, label: t(k) })), [t]);

  const rowActions = useCallback((u) => [
    { key: 'view', label: tc('actions.viewDetails'), icon: <Eye size={14} />,
      onClick: () => setViewUser(u) },
    !u.is_deleted && { key: 'edit', label: tc('actions.edit'), icon: <Pencil size={14} />,
      onClick: () => setEditUser(u) },
    ...rowMenuItems(u),
  ].filter(Boolean), [rowMenuItems]);

  // Each bulk action reuses a per-user endpoint. `run` receives the rows the
  // user actually selected, which the confirmation then reports on.
  const bulkActions = useMemo(() => BULK_ACTIONS.map((a) => ({
    key: a.key,
    label: a.label,
    icon: a.icon,
    danger: a.tone === 'danger',
    run: (ids, selectedRows) => setBulk({ ...a, targets: selectedRows }),
  })), [BULK_ACTIONS]);

  return (
    <>
      <ListView
        tableKey="users"
        fetcher={fetcher}
        reloadKey={reloadKey}
        baseParams={{ is_deleted: 'false' }}
        defaultOrdering="-date_joined"
        searchPlaceholder={t('searchPlaceholder')}
        emptyTitle={t('emptyTitle')}
        emptyHint={t('emptyHint')}
        columns={columns}
        filters={filters}
        groupOptions={userGroups}
        rowActions={rowActions}
        bulkActions={bulkActions}
        toolbarRight={hasPerm('users.add') && (
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> {t('newUser')}
          </button>
        )}
      />

      <UserFormModal open={createOpen} roles={roles} onClose={() => setCreateOpen(false)}
        onSaved={() => { setCreateOpen(false); toast.success(t('actions.created')); reload(); }} />
      <UserFormModal open={Boolean(editUser)} user={editUser} roles={roles} onClose={() => setEditUser(null)}
        onSaved={() => { setEditUser(null); toast.success(t('actions.updated')); reload(); }}
        onMfaChanged={reload} />
      <SetPasswordModal user={pwUser} onClose={() => setPwUser(null)}
        onSaved={() => { setPwUser(null); toast.success(t('actions.passwordUpdated')); reload(); }} />
      <ViewUserDrawer user={viewUser}
        canManageSessions={viewUser ? canManageSessions(viewUser) : false}
        onClose={() => setViewUser(null)} />

      <ConfirmDialog
        open={Boolean(confirm)}
        busy={confirmBusy}
        tone={cfg?.tone}
        title={cfg?.title}
        confirmLabel={cfg?.label}
        message={confirm ? (
          <>
            {cfg?.msg(confirm.user)}
            {confirmErr && (
              <div style={{ marginTop: 10, color: '#dc2626', fontSize: 13, fontWeight: 500 }}>{confirmErr}</div>
            )}
          </>
        ) : null}
        onConfirm={runConfirm}
        onClose={() => { if (!confirmBusy) { setConfirm(null); setConfirmErr(''); } }}
      />

      <ConfirmDialog
        open={Boolean(bulk)}
        busy={bulkBusy}
        tone={bulk?.tone}
        title={bulk ? `${bulk.label} - ${selectedUsers.length} selected` : ''}
        confirmLabel={bulk?.label}
        message={bulk ? (() => {
          const eligible = selectedUsers.filter(bulk.eligible).length;
          const skipped = selectedUsers.length - eligible;
          return (
            <>
              <strong>{bulk.label}</strong> will apply to <strong>{eligible}</strong> of {selectedUsers.length} selected user(s).
              {skipped > 0 && (
                <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
                  {skipped} will be skipped (your permissions, the owner, your own account, or not applicable).
                </div>
              )}
              {eligible === 0 && (
                <div style={{ marginTop: 8, color: '#dc2626', fontSize: 13 }}>{t('actions.noneEligible')}</div>
              )}
            </>
          );
        })() : null}
        onConfirm={runBulk}
        onClose={() => { if (!bulkBusy) setBulk(null); }}
      />
    </>
  );
}

/* --------------------------- View drawer (RO) ---------------------------- */
function DLRow({ label, children }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 16, padding: '9px 0',
      borderBottom: '1px solid var(--color-border-soft, #eef0f3)', fontSize: 13.5,
    }}>
      <span className="muted" style={{ flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: 'right', fontWeight: 500, wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

function ViewUserDrawer({ user, canManageSessions = false, onClose }) {
  const { t } = useTranslation('users');
  const u = user;
  // Live session count from the Sessions panel; falls back to the list value.
  const [sessionCount, setSessionCount] = useState(null);
  useEffect(() => { setSessionCount(null); }, [u?.id]);
  const liveCount = sessionCount ?? u?.active_sessions_count ?? '-';

  return (
    <Drawer open={Boolean(u)} onClose={onClose} title={u?.full_name || 'User'} subtitle={u?.email}>
      {u && (
        <div>
          {u.is_super_admin && (
            <div style={{ marginBottom: 12 }}><StatusBadge tone="info" label={t('owner')} /></div>
          )}
          <DLRow label={t('sessions.status')}><StatusCell u={u} /></DLRow>
          <DLRow label={t('form.webLogin')}>
            <StatusBadge tone={u.web_login_enabled ? 'success' : 'muted'}
                         label={u.web_login_enabled ? t('common:state.enabled') : t('common:state.disabled')} />
          </DLRow>
          <DLRow label={t('form.mobileLogin')}>
            <StatusBadge tone={u.mobile_login_enabled ? 'success' : 'muted'}
                         label={u.mobile_login_enabled ? t('common:state.enabled') : t('common:state.disabled')} />
          </DLRow>
          <DLRow label={t('form.role')}>{u.role_name || roleLabel(t, u.role)}</DLRow>
          <DLRow label={t('common:labels.phone')}>{u.phone || '-'}</DLRow>
          <DLRow label={t('form.assignedClubs')}>{(u.assigned_club_names || []).join(', ') || '-'}</DLRow>
          <DLRow label={t('drawer.mfaEnrolled')}>{u.mfa_enabled ? 'Yes' : 'No'}</DLRow>
          <DLRow label={t('drawer.mfaRequired')}>{u.mfa_required ? 'Yes' : 'No'}</DLRow>
          <DLRow label={t('form.mfaEnforced')}>{u.mfa_enforced ? 'Yes' : 'No'}</DLRow>
          <DLRow label={t('mustChangePassword')}>{u.must_change_password ? 'Yes' : 'No'}</DLRow>
          <DLRow label={t('drawer.failedAttempts')}>{u.failed_login_attempts ?? 0}</DLRow>
          <DLRow label={t('locked')}>{u.is_locked ? `Yes - until ${fmtDateTime(u.locked_until)}` : 'No'}</DLRow>
          <DLRow label={t('drawer.activeSessions')}>{liveCount}</DLRow>
          <DLRow label={t('drawer.lastLogin')}>{fmtDateTime(u.last_login)}</DLRow>
          <DLRow label={t('drawer.lastLoginIp')}>{u.last_login_ip || '-'}</DLRow>
          <DLRow label={t('drawer.lastActivity')}>{fmtDateTime(u.last_activity_at)}</DLRow>
          <DLRow label={t('drawer.passwordChanged')}>{fmtDateTime(u.last_password_change_at)}</DLRow>
          <DLRow label={t('drawer.created')}>{fmtDateTime(u.created_at)}</DLRow>

          {/* Sessions: only when the actor may manage them (owner/other-admin
              hidden per senior guard; the backend would 403 anyway). */}
          {canManageSessions && (
            <>
              <div className="divider" />
              <SessionsPanel userId={u.id} title={t('sessionsTab')} onCount={setSessionCount}
                terminateWarning="They will be signed out on every device." />
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

/* --------------------- Session inventory (shared) ------------------------ */
// Used by the self security card (userId=null -> own) and the admin View
// drawer (userId=<id>). List + revoke-one + terminate-all, all via the
// existing /auth/sessions endpoints. Errors surface inline, never silent.
function SessionsPanel({ userId = null, title, terminateWarning, onCount, onTerminatedSelf }) {
  const { t } = useTranslation('users');
  const heading = title || t('activeSessions2');
  const [rows, setRows] = useState(null);          // null = loading
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null);    // { kind: 'revoke'|'all', id? }
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState('');
  const { user: me, logout } = useAuth();
  // This panel may show the current admin's own sessions (own card OR viewing
  // your own row): terminating ALL of them ends this session too.
  const isSelf = userId == null || (me && userId === me.id);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await sessionsApi.list(userId);
      const list = Array.isArray(data) ? data : (data?.results || []);
      setRows(list);
      onCount?.(list.length);
    } catch (e) {
      setRows([]);
      setError(apiErr(e, 'Unable to load the sessions. Please try again.'));
    }
  }, [userId, onCount]);

  useEffect(() => { load(); }, [load]);

  async function run() {
    if (!confirm) return;
    setBusy(true);
    setActErr('');
    try {
      if (confirm.kind === 'revoke') {
        await sessionsApi.revoke(confirm.id);
        setConfirm(null);
        await load();                              // refresh list + count
        toast.success(t('sessions.revoked'));
      } else {
        await sessionsApi.terminateAll(userId);
        setConfirm(null);
        // Terminating ALL of your OWN sessions revokes THIS one too - sign out
        // cleanly + redirect instead of a follow-up load() that would 401.
        if (onTerminatedSelf || isSelf) {
          if (onTerminatedSelf) { await onTerminatedSelf(); }
          else {
            toast.success(t('sessions.allTerminatedSelf'));
            try { await logout(); } finally { window.location.assign('/login'); }
          }
          return;
        }
        await load();
        toast.success(t('sessions.allTerminated'));
      }
    } catch (e) {
      setActErr(apiErr(e, 'Unable to revoke the session(s). Please try again.'));      // IDOR/permission -> inline
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="form-label" style={{ margin: 0 }}>
          <Monitor size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
          {heading}{rows ? ` (${rows.length})` : ''}
        </div>
        {rows && rows.length > 0 && (
          <button className="btn btn-ghost" style={{ fontSize: 13 }}
            onClick={() => { setActErr(''); setConfirm({ kind: 'all' }); }}>
            <LogOut size={14} /> {t('terminateAll')}
          </button>
        )}
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>{t('drawer.noActiveSessions')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((s) => (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              padding: '8px 10px', border: '1px solid var(--color-border-soft, #eef0f3)', borderRadius: 8, fontSize: 13,
            }}>
              <span>
                <div>Started {fmtDateTime(s.created_at)}</div>
                <div className="muted" style={{ fontSize: 12 }}>Expires {fmtDateTime(s.expires_at)}</div>
              </span>
              <button className="icon-btn" title={t('revokeSession')}
                onClick={() => { setActErr(''); setConfirm({ kind: 'revoke', id: s.id }); }}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        busy={busy}
        tone="danger"
        title={confirm?.kind === 'all' ? t('terminateAllSessions') : t('revokeSession2')}
        confirmLabel={confirm?.kind === 'all' ? t('terminateAll') : t('revoke')}
        message={confirm ? (
          <>
            {confirm.kind === 'all'
              ? <>Sign out of all active sessions? {terminateWarning}</>
              : <>{t('revokeSessionDeviceSignedOut')}</>}
            {actErr && (
              <div style={{ marginTop: 10, color: '#dc2626', fontSize: 13, fontWeight: 500 }}>{actErr}</div>
            )}
          </>
        ) : null}
        onConfirm={run}
        onClose={() => { if (!busy) { setConfirm(null); setActErr(''); } }}
      />
    </div>
  );
}

/* ----------------------- Active Sessions (admin) ------------------------- */
function fmtDuration(fromIso) {
  if (!fromIso) return '-';
  const ms = Date.now() - new Date(fromIso).getTime();
  if (ms < 0 || Number.isNaN(ms)) return '-';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
const SESSION_TONE = { active: 'success', idle: 'warning', expired: 'muted' };
const SESSIONS_PAGE_SIZE = 20;

function SessionsAdminPage() {
  const { t } = useTranslation('users');
  const navigate = useNavigate();
  const { user: me, logout } = useAuth();
  const [rows, setRows] = useState(null);   // null = loading
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const [viewUser, setViewUser] = useState(null);
  const [confirm, setConfirm] = useState(null);    // { kind: 'terminate'|'all', row }
  const [busy, setBusy] = useState(false);
  const [confirmErr, setConfirmErr] = useState('');

  const load = useCallback(async () => {
    setError('');
    try { const d = await sessionsApi.listAll(); setRows(Array.isArray(d) ? d : []); }
    catch (e) { setRows([]); setError(apiErr(e, 'Unable to load the active sessions. Please try again.')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = (rows || []).filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [r.full_name, r.email, r.role_name, r.session_id, r.jti, r.ip_address]
      .some((v) => String(v ?? '').toLowerCase().includes(q));
  });
  const pageRows = filtered.slice((page - 1) * SESSIONS_PAGE_SIZE, page * SESSIONS_PAGE_SIZE);

  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    setConfirmErr('');
    const { kind, row } = confirm;
    try {
      if (kind === 'terminate') { await sessionsApi.revoke(row.id); toast.success(t('sessions.terminated')); }
      else { await sessionsApi.terminateAll(row.user_id); toast.success(t('sessions.allTerminatedForUser')); }
      // Force-logging-out ALL of your OWN sessions ends this one too - sign out
      // cleanly + redirect instead of leaving a dead-token tab that looks logged in.
      if (kind === 'all' && row.user_id === me?.id) {
        try { await logout(); } finally { window.location.assign('/login'); }
        return;
      }
      setConfirm(null);
      await load();
    } catch (e) { setConfirmErr(apiErr(e, 'Unable to terminate the session(s). Please try again.')); }
    finally { setBusy(false); }
  }

  async function viewProfile(row) {
    try { setViewUser(await usersApi.get(row.user_id)); }
    catch (e) { toast.error(apiErr(e, 'Unable to load the user profile. Please try again.')); }
  }

  function rowMenu(r) {
    return [
      { key: 'details', label: t('viewSessionDetails'), icon: <Eye size={15} />, onClick: () => setDetail(r) },
      { key: 'profile', label: t('viewUserProfile'), icon: <UserIcon size={15} />, onClick: () => viewProfile(r) },
      { key: 'audit', label: t('viewAuditLogs'), icon: <FileText size={15} />,
        onClick: () => navigate(`/auditlogs?search=${encodeURIComponent(r.email || '')}`) },
      r.can_manage && { key: 'terminate', label: t('terminateSession2'), icon: <Trash2 size={15} />, danger: true,
        onClick: () => { setConfirmErr(''); setConfirm({ kind: 'terminate', row: r }); } },
      r.can_manage && { key: 'all', label: t('forceLogoutAllUser'), icon: <LogOut size={15} />, danger: true,
        onClick: () => { setConfirmErr(''); setConfirm({ kind: 'all', row: r }); } },
    ];
  }

  const columns = [
    { key: 'user', header: t('user'), render: (r) => (
      <span><div style={{ fontWeight: 600 }}>{r.full_name}</div>
        <div className="muted" style={{ fontSize: 12 }}>{r.email}</div></span>
    ) },
    { key: 'role', header: t('role'), render: (r) => <StatusBadge tone="info" label={r.role_name || r.role} /> },
    { key: 'status', header: t('common:labels.status'), render: (r) => <StatusBadge tone={SESSION_TONE[r.status] || 'muted'} label={r.status} /> },
    { key: 'device', header: t('device'), render: (r) => (
      <span style={{ fontSize: 12.5 }}>
        {[r.browser, r.operating_system, r.device_type].filter(Boolean).join(' · ') || '-'}
      </span>
    ) },
    { key: 'ip', header: 'IP', nowrap: true, render: (r) => <span className="muted">{r.ip_address || '-'}</span> },
    { key: 'login', header: t('login'), nowrap: true, render: (r) => <span className="muted">{fmtDateTime(r.login_at)}</span> },
    { key: 'last', header: t('lastActivity'), nowrap: true, render: (r) => <span className="muted">{fmtDateTime(r.last_activity_at)}</span> },
    { key: 'mfa', header: 'MFA', render: (r) => (r.mfa_verified ? <StatusBadge tone="success" label={t('verified')} /> : <span className="muted">-</span>) },
    { key: 'actions', header: '', align: 'right', render: (r) => (
      <div className="table-actions" style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
        <button className="icon-btn" title={t('sessionDetails')} onClick={() => setDetail(r)}><Eye size={15} /></button>
        <RowMenu items={rowMenu(r)} />
      </div>
    ) },
  ];

  return (
    <>
      <Toolbar
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder={t('nameEmailSessionIdIp')}
        filters={[]}
        right={<button className="btn btn-secondary" onClick={load}><RefreshCw size={15} /> {t('common:actions.refresh')}</button>}
      />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <DataTable
          loading={rows === null}
          rows={pageRows}
          page={page}
          count={filtered.length}
          onPageChange={setPage}
          emptyTitle={t('noActiveSessions')}
          emptyHint={t('activeSessionsAppearHereWhen')}
          columns={columns}
        />
      )}

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)}
        title={detail ? `Session · ${detail.full_name}` : ''} size="md"
        footer={<button className="btn btn-secondary" onClick={() => setDetail(null)}>{t('common:actions.close')}</button>}>
        {detail && (
          <div>
            <DLRow label={t('sessions.sessionId')}>{detail.session_id} <span className="muted">({detail.jti})</span></DLRow>
            <DLRow label={t('sessions.user')}>{detail.full_name} - {detail.email}</DLRow>
            <DLRow label={t('sessions.role')}>{detail.role_name || detail.role}</DLRow>
            <DLRow label={t('drawer.clubs')}>{(detail.club_names || []).join(', ') || '-'}</DLRow>
            <DLRow label={t('common:labels.status')}>{detail.status}</DLRow>
            <DLRow label={t('sessions.mfaVerified')}>{detail.mfa_verified ? 'Yes' : 'No'}</DLRow>
            <DLRow label={t('sessions.ipAddress')}>{detail.ip_address || '-'}</DLRow>
            <DLRow label={t('sessions.deviceType')}>{detail.device_type || '-'}</DLRow>
            <DLRow label={t('sessions.browser')}>{detail.browser || '-'}</DLRow>
            <DLRow label={t('sessions.operatingSystem')}>{detail.operating_system || '-'}</DLRow>
            <DLRow label={t('sessions.loginTime')}>{fmtDateTime(detail.login_at)}</DLRow>
            <DLRow label={t('lastActivity')}>{fmtDateTime(detail.last_activity_at)}</DLRow>
            <DLRow label={t('sessions.duration')}>{fmtDuration(detail.login_at)}</DLRow>
            <DLRow label={t('sessions.expires')}>{fmtDateTime(detail.expires_at)}</DLRow>
          </div>
        )}
      </Modal>

      <ViewUserDrawer user={viewUser} canManageSessions={false} onClose={() => setViewUser(null)} />

      <ConfirmDialog
        open={Boolean(confirm)}
        busy={busy}
        tone="danger"
        title={confirm?.kind === 'all' ? t('forceLogoutAllSessions') : t('terminateSession3')}
        confirmLabel={confirm?.kind === 'all' ? t('forceLogoutAll') : t('terminate')}
        message={confirm ? (
          <>
            {confirm.kind === 'all'
              ? <>{t('end')} <strong>all</strong> active sessions for <strong>{confirm.row.email}</strong>? They'll be signed out on every device.</>
              : <>{t('terminateSession')} <strong>{confirm.row.email}</strong>? That device is signed out on its next request.</>}
            {confirmErr && <div style={{ marginTop: 10, color: '#dc2626', fontSize: 13, fontWeight: 500 }}>{confirmErr}</div>}
          </>
        ) : null}
        onConfirm={runConfirm}
        onClose={() => { if (!busy) { setConfirm(null); setConfirmErr(''); } }}
      />
    </>
  );
}

/* --------------------- MFA manager (edit modal, admin) ------------------- */
// Per-user MFA state machine (M365-style): Disabled / Enabled (optional) /
// Enforced. All transitions go through ONE backend endpoint (POST mfa-policy)
// so the state can't go inconsistent; Reset uses disable-mfa (re-enrol). An
// admin can't enrol on a user's behalf (TOTP self-enrol), so "Enable" = make MFA
// AVAILABLE (optional), not "turn it on for them". Honest to the backend.
const policyBadge = (t) => ({
  enforced: { tone: 'warning', label: t('enforced') },
  disabled: { tone: 'danger', label: t('common:state.disabled') },
  optional: { tone: 'info', label: t('enabledOptional') },
});
const POLICY_DONE = {
  optional: 'MFA enabled (optional)', disabled: 'MFA disabled', enforced: 'MFA enforced',
};

function MfaSettingRow({ title, desc, top, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      padding: top ? '8px 0 4px' : '4px 0',
      borderTop: top ? '1px solid var(--color-border-soft, #eef0f3)' : undefined,
    }}>
      <span style={{ fontSize: 13 }}>
        <strong>{title}</strong>
        <div className="muted" style={{ fontSize: 12 }}>{desc}</div>
      </span>
      {children}
    </div>
  );
}

function MfaManager({ userId, policyInit, enabledInit, roleRequired, isSelf, isOwner, canManage, onChanged }) {
  const { t } = useTranslation('users');
  const [policy, setPolicy] = useState(policyInit);   // 'disabled' | 'optional' | 'enforced'
  const [enabled, setEnabled] = useState(enabledInit);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);       // { kind }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const ask = (kind) => { setErr(''); setConfirm({ kind }); };
  // kind -> target policy ('reset' is a separate enrolment clear, not a policy).
  const KIND_TO_POLICY = { enable: 'optional', disable: 'disabled', enforce: 'enforced', unenforce: 'optional' };

  async function run() {
    if (!confirm) return;
    const kind = confirm.kind;
    setBusy(true);
    setErr('');
    try {
      if (kind === 'reset') {
        await usersApi.disableMfa(userId);
        setEnabled(false);
        toast.success(t('mfaResetUserMustRe'));
      } else {
        const target = KIND_TO_POLICY[kind];
        const r = await usersApi.setMfaPolicy(userId, target);
        setPolicy(r.mfa_policy || target);
        if (target === 'disabled') setEnabled(false);
        toast.success(POLICY_DONE[target] || 'Updated');
      }
      setConfirm(null);
      onChanged?.();
    } catch (e) {
      setErr(apiErr(e, 'Unable to update the MFA settings. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  const badge = policyBadge(t)[policy] || policyBadge(t).optional;
  const status = (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      <StatusBadge tone={enabled ? 'success' : 'muted'} label={enabled ? t('enrolled') : t('notEnrolled')} />
      <StatusBadge tone={badge.tone} label={badge.label} />
      {roleRequired && <StatusBadge tone="info" label={t('requiredRole')} />}
    </span>
  );

  // Your own MFA is managed from the security card, not here.
  if (isSelf) {
    return (
      <div>{status}
        <p className="muted" style={{ fontSize: 12 }}>Manage your own MFA from “Your account security” above.</p>
      </div>
    );
  }
  if (!canManage) {
    return (
      <div>{status}
        <p className="muted" style={{ fontSize: 12 }}>{t('onlySuperAdminCanManage')}</p>
      </div>
    );
  }

  return (
    <div>
      {status}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {policy === 'disabled' && (
          <button type="button" className="btn btn-primary" onClick={() => ask('enable')}>
            <ShieldCheck size={15} /> {t('enableMfa')}
          </button>
        )}
        {policy === 'optional' && (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => ask('disable')}>
              <ShieldOff size={15} /> {t('disableMfa')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => ask('enforce')}>
              <Shield size={15} /> {t('enforceMfa')}
            </button>
          </>
        )}
        {policy !== 'disabled' && (
          <button type="button" className="btn btn-secondary" onClick={() => setSettingsOpen((o) => !o)}>
            <Settings size={15} /> {t('userMfaSettings')}
          </button>
        )}
      </div>

      {policy === 'disabled' && (
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {t('mfaTurnedOffUserEnabling')}
        </p>
      )}
      {policy === 'enforced' && !settingsOpen && (
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {t('mfaEnforcedTurnItOff')} <strong>{t('userMfaSettings')}</strong> and remove enforcement first.
        </p>
      )}

      {settingsOpen && policy !== 'disabled' && (
        <div style={{ marginTop: 10, padding: 12, border: '1px solid var(--color-border-soft, #eef0f3)', borderRadius: 8 }}>
          <MfaSettingRow title={t('enforcement')} desc="Require this user to keep MFA enrolled.">
            {roleRequired ? (
              <StatusBadge tone="info" label={t('requiredRole')} />
            ) : policy === 'enforced' ? (
              <button type="button" className="btn btn-ghost" onClick={() => ask('unenforce')}>{t('common:actions.remove')}</button>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={() => ask('enforce')}>{t('enforce')}</button>
            )}
          </MfaSettingRow>
          <MfaSettingRow top title={t('resetMfa2')} desc="Remove the current authenticator; the user must set it up again.">
            <button type="button" className="btn btn-ghost" disabled={!enabled} onClick={() => ask('reset')}>{t('common:actions.reset')}</button>
          </MfaSettingRow>
          <MfaSettingRow top title={t('disableMfa')} desc="Turn MFA off for this user (they can’t use it).">
            <button type="button" className="btn btn-ghost" disabled={roleRequired || isOwner} onClick={() => ask('disable')}>{t('common:actions.disable')}</button>
          </MfaSettingRow>
          {(roleRequired || isOwner) && (
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {roleRequired ? t('userSRoleRequiresMfa')
                : t('ownerAccountCanTHave')}
            </p>
          )}
          <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            App passwords and “remembered devices” aren’t used in this system (TOTP only), so those M365 options don’t apply.
          </p>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        busy={busy}
        tone={(confirm?.kind === 'reset' || confirm?.kind === 'disable') ? 'danger' : 'primary'}
        title={{
          reset: 'Reset MFA?', disable: 'Disable MFA?', enforce: 'Enforce MFA?',
          unenforce: 'Remove enforcement?', enable: 'Enable MFA?',
        }[confirm?.kind]}
        confirmLabel={{
          reset: 'Reset MFA', disable: 'Disable MFA', enforce: 'Enforce',
          unenforce: 'Remove', enable: 'Enable MFA',
        }[confirm?.kind]}
        message={confirm ? (
          <>
            {confirm.kind === 'enable' && <>{t('makeMfaAvailableUserThey')}</>}
            {confirm.kind === 'disable' && <>{t('turnMfaOff')} <strong>this user</strong>? Any existing authenticator is removed and they can’t use MFA until it’s re-enabled.</>}
            {confirm.kind === 'enforce' && <>{t('requireUserKeepMfaEnrolled')}</>}
            {confirm.kind === 'unenforce' && <>{t('removeEnforcementMfaBecomesOptional')}</>}
            {confirm.kind === 'reset' && <>Remove this user’s authenticator? They must re-enrol{roleRequired ? ' and will be gated to set it up again at next login.' : '.'}</>}
            {err && <div style={{ marginTop: 10, color: '#dc2626', fontSize: 13, fontWeight: 500 }}>{err}</div>}
          </>
        ) : null}
        onConfirm={run}
        onClose={() => { if (!busy) { setConfirm(null); setErr(''); } }}
      />
    </div>
  );
}

/* ----------------------------- Create / edit ----------------------------- */
function UserFormModal({ open, user, roles = [], onClose, onSaved, onMfaChanged }) {
  const { t } = useTranslation('users');
  const { user: me } = useAuth();
  const isEdit = Boolean(user);
  const isSelf = isEdit && me?.id === user?.id;
  const isOwner = Boolean(user?.is_super_admin);
  const actorIsSuper = me?.role === 'super_admin';

  const { register, handleSubmit, reset, watch, control, formState: { errors, isSubmitting } } = useForm({
    defaultValues: {
      role: 'customer', is_active: true, mfa_enforced: false,
      web_login_enabled: true, mobile_login_enabled: true,
    },
  });
  const role = watch('role');
  const pwValue = watch('password');
  // Behaviour base of the selected role (system roles map to themselves).
  const baseRole = roles.find((r) => r.slug === role)?.base_role || role;

  const [clubs, setSites] = useState([]);
  const [facilities, setBays] = useState([]);
  const [siteIds, setSiteIds] = useState(new Set());
  const [bayIds, setBayIds] = useState(new Set());
  const [formError, setFormError] = useState('');

  // Roles the current actor may assign (super_admin never appears; admin base is
  // super-admin-only) - mirrors the backend role guards.
  const roleOptions = assignableRoleOptions(t, roles, me);

  const roleDisabled = isSelf;                          // can't change your own role
  const statusHidden = isOwner;                         // owner status never shown
  const statusDisabled = isSelf;                        // can't change your own status
  // Admin Web Portal access can lock someone out: never editable for yourself or
  // the owner account (mirrors the backend guard).
  const webAccessLocked = isSelf || isOwner;
  // mfa_enforced lock: self, owner, and admin-role targets (senior guard).
  const mfaLocked = isSelf || isOwner || baseRole === 'admin' || baseRole === 'super_admin';
  // Reset MFA (disable-mfa) mirrors _guard_manage_target: super acts on anyone;
  // others only on non-senior targets. Never on yourself (use the security card).
  const targetSenior = isOwner || baseRole === 'admin' || baseRole === 'super_admin';
  const canResetTarget = !isSelf && (actorIsSuper || !targetSenior);

  // Load reference data (clubs + facilities) once the modal opens.
  useEffect(() => {
    if (!open) return;
    clubsApi.list({ page_size: 100 }).then((d) => setSites(d.results || d)).catch(() => {});
    facilitiesApi.list({ page_size: 200 }).then((d) => setBays(d.results || d)).catch(() => {});
  }, [open]);

  // Prefill form + selections when opening.
  useEffect(() => {
    if (!open) return;
    setFormError('');
    reset(user
      ? { first_name: user.first_name, last_name: user.last_name, email: user.email,
          phone: user.phone || '', role: user.role_slug || user.role, password: '', confirm_password: '',
          is_active: user.is_active, mfa_enforced: Boolean(user.mfa_enforced),
          web_login_enabled: user.web_login_enabled !== false,
          mobile_login_enabled: user.mobile_login_enabled !== false }
      : { first_name: '', last_name: '', email: '', phone: '', role: 'customer', password: '', confirm_password: '',
          is_active: true, mfa_enforced: false,
          web_login_enabled: true, mobile_login_enabled: true });
    setSiteIds(new Set(user?.assigned_clubs || []));
    setBayIds(new Set(user?.assigned_facilities || []));
  }, [open, user, reset]);

  const showSites = SITE_SCOPED_ROLES.includes(baseRole);
  const baysForSites = facilities.filter((b) => siteIds.has(b.club));

  function toggleId(setter) {
    return (id) => setter((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function onSubmit(v) {
    const payload = { ...v };
    delete payload.confirm_password;             // client-side check only
    if (!payload.password) delete payload.password;

    // Drop fields the actor isn't allowed to change (UI mirror; backend is the gate).
    if (roleDisabled) delete payload.role;
    if (statusHidden || statusDisabled) delete payload.is_active;
    if (webAccessLocked) delete payload.web_login_enabled;   // can't lock yourself/owner out
    // Edit mode: enforcement is changed via the immediate MFA controls below,
    // not the form save. Create mode: keep it (unless locked for a senior role).
    if (isEdit || mfaLocked) delete payload.mfa_enforced;

    // Permissions always follow the assigned role - no per-user overrides.
    payload.permission_overrides = { grant: [], revoke: [] };
    payload.assigned_clubs = showSites ? [...siteIds] : [];
    payload.assigned_facilities = showSites
      ? [...bayIds].filter((id) => baysForSites.some((b) => b.id === id))
      : [];

    try {
      if (isEdit) await usersApi.update(user.id, payload);
      else await usersApi.create(payload);
      onSaved();
    } catch (e) {
      setFormError(apiErr(e, isEdit ? t('form.updateFailed') : t('form.createFailed')));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${user.email}` : 'New user'} size="lg"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
          {isEdit ? t('common:actions.saveChanges') : t('createUser')}
        </button>
      </>}>
      {formError && (
        <div style={{
          marginBottom: 14, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: 'rgba(220,38,38,0.08)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.25)',
        }}>{formError}</div>
      )}
      <div className="row">
        <div className="col"><FormField label={t('form.firstName')} error={errors.first_name?.message}>
          <input className="form-input" {...register('first_name', { required: 'Required' })} /></FormField></div>
        <div className="col"><FormField label={t('form.lastName')} error={errors.last_name?.message}>
          <input className="form-input" {...register('last_name', { required: 'Required' })} /></FormField></div>
      </div>
      <div className="row">
        <div className="col"><FormField label={t('common:labels.email')} hint={t('usedAsLoginIdentifier')} error={errors.email?.message}>
          <input className="form-input" type="email" {...register('email', { required: 'Required' })} /></FormField></div>
        <div className="col"><FormField label={t('common:labels.phone')}>
          <input className="form-input" {...register('phone')} /></FormField></div>
      </div>
      <div className="row">
        <div className="col"><FormField label={t('role')}
          hint={roleDisabled ? 'You cannot change your own role.' : undefined}>
          <Controller name="role" control={control} render={({ field }) => (
            <Select2
              options={roleOptions}
              value={field.value} onChange={field.onChange} placeholder={t('form.rolePlaceholder')}
              disabled={roleDisabled}
            />
          )} /></FormField></div>
        <div className="col">
          {!statusHidden && (
            <FormField label={t('common:labels.status')}
              hint={statusDisabled ? t('youCannotChangeYourOwn') : t('inactiveUsersCannotLog')}>
              <Toggle label={t('common:state.active')} disabled={statusDisabled} {...register('is_active')} />
            </FormField>
          )}
        </div>
      </div>

      {/* Per-channel login access - an additional control on top of the role.
          Independent: a user may be allowed on one channel and blocked on the other. */}
      <div className="row">
        <div className="col">
          <FormField label={t('form.webLoginAccess')}
            hint={webAccessLocked
              ? t('youCannotChangeYourOwn2')
              : t('whenDisabledUserCannotSign2')}>
            <Toggle label={t('common:state.enabled')} disabled={webAccessLocked} {...register('web_login_enabled')} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('form.mobileLoginAccess')}
            hint={t('whenDisabledUserCannotSign')}>
            <Toggle label={t('common:state.enabled')} {...register('mobile_login_enabled')} />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col"><FormField
          label={isEdit ? t('newPassword') : t('password')}
          hint={isEdit ? t('leaveBlankKeepCurrent') : t('min10CharsUpperLower2')}
          error={errors.password?.message}>
          <input className="form-input" type="text" autoComplete="new-password"
            {...register('password', {
              required: isEdit ? false : 'Required',
              minLength: { value: 10, message: 'Min 10 characters' },
            })} />
        </FormField></div>
        <div className="col"><FormField label={t('form.confirmPassword')} error={errors.confirm_password?.message}>
          <input className="form-input" type="text" autoComplete="new-password"
            {...register('confirm_password', {
              validate: (val) => (!pwValue && !val) || val === pwValue || 'Passwords do not match',
            })} />
        </FormField></div>
      </div>

      {/* --- Multi-factor authentication --- */}
      <FormField label={t('drawer.multiFactor')}>
        {isEdit ? (
          <MfaManager
            key={user.id}
            userId={user.id}
            policyInit={user.mfa_policy || (user.mfa_enforced || user.mfa_required ? 'enforced' : 'optional')}
            enabledInit={Boolean(user.mfa_enabled)}
            roleRequired={Boolean(user.mfa_required)}
            isSelf={isSelf}
            isOwner={isOwner}
            canManage={canResetTarget}
            onChanged={onMfaChanged}
          />
        ) : (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
              <input type="checkbox" disabled={mfaLocked} {...register('mfa_enforced')} />
              {t('enforceMfaRequireUserEnrol')}
            </label>
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              New users set up MFA themselves on their device; enforcing requires them to enrol at first login.
            </p>
          </>
        )}
      </FormField>

      {baseRole === 'super_admin' && (
        <p className="muted" style={{ fontSize: 13 }}>{t('form.ownerNote')}</p>
      )}

      {/* --- Clubs & facilities --- */}
      {showSites && (
        <>
          <div className="divider" />
          <FormField label={t('assignedClubs')} hint={t('userOnlySeesDataThese')}>
            <Select2
              multiple
              options={clubs.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }))}
              value={[...siteIds]}
              onChange={(arr) => setSiteIds(new Set(arr))}
              placeholder={t('form.clubsPlaceholder')}
              emptyText="No clubs configured yet."
            />
          </FormField>
          <FormField label={t('form.assignedFacilities')} hint={t('form.facilitiesHint')}>
            <CheckList
              items={baysForSites.map((b) => ({ id: b.id, label: b.label }))}
              selected={bayIds}
              onToggle={toggleId(setBayIds)}
              empty="Select a club to choose its facilities."
            />
          </FormField>
        </>
      )}
    </Modal>
  );
}

function CheckList({ items, selected, onToggle, empty }) {
  if (!items.length) return <p className="muted" style={{ fontSize: 13 }}>{empty}</p>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {items.map((it) => (
        <label key={it.id} style={{
          display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
          border: '1px solid var(--color-border-soft)', borderRadius: 8, padding: '5px 10px', cursor: 'pointer',
        }}>
          <input type="checkbox" checked={selected.has(it.id)} onChange={() => onToggle(it.id)} />
          {it.label}
        </label>
      ))}
    </div>
  );
}

function SetPasswordModal({ user, onClose, onSaved }) {
  const { t } = useTranslation('users');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit() {
    setBusy(true);
    setErr('');
    try { await usersApi.setPassword(user.id, pw); setPw(''); onSaved(); }
    catch (e) { setErr(apiErr(e, 'Unable to set the password. Please try again.')); }
    finally { setBusy(false); }
  }
  return (
    <Modal open={Boolean(user)} onClose={onClose} title={user ? `Reset password · ${user.email}` : ''} size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || pw.length < 10}>{t('setPassword')}</button>
      </>}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {t('userMustSetNewPassword')}
      </p>
      <FormField label={t('form.newPassword')} hint={t('min10CharsUpperLower')}
        error={err || undefined}>
        <input className="form-input" type="text" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      </FormField>
    </Modal>
  );
}
