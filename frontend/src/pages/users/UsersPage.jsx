import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Pencil, Eye, KeyRound, KeySquare, ShieldCheck, ShieldOff,
  UserCheck, UserX, Unlock, Trash2, Lock, Monitor, LogOut, Shield, Settings,
  User as UserIcon, FileText, RefreshCw, CheckSquare, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Controller, useForm } from 'react-hook-form';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toolbar } from '../../components/Toolbar.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { Toggle } from '../../components/Toggle.jsx';
import { Drawer } from '../../components/Drawer.jsx';
import { RowMenu } from '../../components/RowMenu.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';

import { USER_ROLES, accessApi, accountApi, usersApi, sessionsApi } from '../../services/usersService.js';
import { clubsApi } from '../../services/clubsService.js';
import { facilitiesApi } from '../../services/facilitiesService.js';
import { formatDateTime } from '../../services/timeformat.jsx';
import { useTabParam } from '../../hooks/useTabParam.js';
import { assignableRoleOptions, canManageUser, canTransferSuperAdmin } from '../../utils/rbac.js';

// Roles that are club-scoped (assigned to specific locations).
const SITE_SCOPED_ROLES = ['club_admin', 'manager', 'facility_operator', 'facility_staff'];

const roleLabel = (v) => USER_ROLES.find((r) => r.value === v)?.label || v;

// Status filter is a composite over is_active / locked / is_deleted (the backend
// has no single "status" field). "Locked" is a real server-side filter
// (?locked=true, matching the is_locked property) - not a client-side post-filter.
const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'locked',   label: 'Locked' },
  { value: 'deleted',  label: 'Deleted' },
];
const MFA_OPTIONS = [
  { value: 'true',  label: 'Enrolled' },
  { value: 'false', label: 'Not enrolled' },
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
  if (u.is_deleted) return <StatusBadge tone="danger" label="Deleted" />;
  if (u.is_locked) return <StatusBadge tone="warning" label="Locked" />;
  if (!u.is_active) return <StatusBadge tone="muted" label="Inactive" />;
  return <StatusBadge tone="success" label="Active" />;
}

// Per-channel login access (additional to role/permissions): Web portal + Mobile.
function AccessCell({ u }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      <StatusBadge tone={u.web_login_enabled ? 'success' : 'muted'}
                   label={u.web_login_enabled ? 'Web' : 'No Web'} />
      <StatusBadge tone={u.mobile_login_enabled ? 'success' : 'muted'}
                   label={u.mobile_login_enabled ? 'Mobile' : 'No Mobile'} />
    </span>
  );
}

// Read-only MFA status, keyed on the POLICY (Disabled / Enabled / Enforced),
// with enrolment shown separately. Note: admin "Enable" makes MFA *available*
// (optional) - the user still enrols on their device, so a just-enabled user is
// "Enabled" (not yet "Enrolled"), NOT "Disabled".
function MfaCell({ u }) {
  // One mutually-exclusive status badge: Enforced > Disabled > Enrolled > Enabled.
  let tone = 'info';
  let label = 'Enabled';                       // available (optional), not yet set up
  if (u.mfa_policy === 'enforced') { tone = 'warning'; label = 'Enforced'; }
  else if (u.mfa_policy === 'disabled') { tone = 'muted'; label = 'Disabled'; }
  else if (u.mfa_enabled) { tone = 'success'; label = 'Enrolled'; }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <StatusBadge tone={tone} label={label} />
      {u.mfa_required && <StatusBadge tone="info" label="Role" />}
    </span>
  );
}

// Derive the Status filter's current value from the query params.
function statusValueFromQuery(q) {
  if (q.is_deleted === 'true') return 'deleted';
  if (q.locked === 'true') return 'locked';
  if (q.is_active === 'true') return 'active';
  if (q.is_active === 'false') return 'inactive';
  return '';
}

const tabBtnStyle = (active) => ({
  padding: '8px 14px',
  border: 'none',
  background: 'transparent',
  borderBottom: active ? '2px solid var(--color-primary-600)' : '2px solid transparent',
  color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
  fontWeight: 600,
  fontSize: 13.5,
  cursor: 'pointer',
});

export default function UsersPage() {
  const [tab, setTab] = useTabParam('users');
  return (
    <>
      <PageHeader
        title="User Management"
        subtitle="Manage user accounts and monitor active sessions."
      />
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', marginBottom: 18 }}>
        <button style={tabBtnStyle(tab === 'users')} onClick={() => setTab('users')}>Users</button>
        <button style={tabBtnStyle(tab === 'sessions')} onClick={() => setTab('sessions')}>Active Sessions</button>
      </div>
      {tab === 'users' ? <UsersTable /> : <SessionsAdminPage />}
    </>
  );
}

/* -------------------- Confirm-dialog copy per action --------------------- */
const CONFIRM = {
  deactivate: { title: 'Deactivate user?', label: 'Deactivate', tone: 'danger',
    msg: (u) => <>Deactivate <strong>{u.email}</strong>? They will be signed out and unable to log in until reactivated.</> },
  activate: { title: 'Activate user?', label: 'Activate', tone: 'primary',
    msg: (u) => <>Reactivate <strong>{u.email}</strong>? They will be able to log in again.</> },
  unlock: { title: 'Unlock account?', label: 'Unlock', tone: 'primary',
    msg: (u) => <>Clear the lockout on <strong>{u.email}</strong>? Their failed-attempt counter is reset.</> },
  forcepw: { title: 'Force password change?', label: 'Force change', tone: 'primary',
    msg: (u) => <>Require <strong>{u.email}</strong> to set a new password at their next login? Their current password keeps working only until then - no password is set now.</> },
  resetmfa: { title: 'Reset MFA?', label: 'Reset MFA', tone: 'danger',
    msg: (u) => <>Reset MFA for <strong>{u.email}</strong>? Their current authenticator is removed and they must set up a <strong>fresh</strong> one at their next sign-in (MFA stays required). To turn MFA off instead, use <em>Disable MFA</em>.</> },
  delete: { title: 'Delete user?', label: 'Delete', tone: 'danger',
    msg: (u) => <>Delete <strong>{u.email}</strong>? They are signed out and hidden from lists; the record is kept for history (soft delete).</> },
  transfer: { title: 'Transfer super admin?', label: 'Transfer & step down', tone: 'danger',
    msg: (u) => <>Make <strong>{u.email}</strong> the new <strong>super admin</strong>? There is only ever one super admin, so <strong>you will be demoted to Admin</strong>. Only the super admin can do this, and only the new super admin can transfer it back.</> },
};

/* ----------------------------- Users table ------------------------------ */
function UsersTable() {
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
  // Default: hide soft-deleted users unless the Status filter selects them.
  const { rows, loading, error, count, query, setQuery, reload } =
    useApiList(fetcher, { is_deleted: 'false' });

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

  // ---- bulk selection (multi-user actions; reuse the per-user endpoints) ----
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState(null);       // chosen bulk action (pending confirm)
  const [bulkBusy, setBulkBusy] = useState(false);
  // Selection is scoped to the current page; reset on any query change.
  useEffect(() => { setSelected(new Set()); }, [query]);

  const pageIds = rows.map((u) => u.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  function toggleRow(id) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAllPage() {
    setSelected((prev) => {
      const n = new Set(prev);
      if (allPageSelected) pageIds.forEach((id) => n.delete(id));
      else pageIds.forEach((id) => n.add(id));
      return n;
    });
  }
  const selectedUsers = rows.filter((u) => selected.has(u.id));

  // Each bulk action reuses an existing per-user endpoint (no new behaviour);
  // ineligible rows (guards / self / owner) are skipped, backend still enforces.
  const BULK_ACTIONS = [
    { key: 'activate', label: 'Activate', tone: 'primary', done: 'activated', icon: <UserCheck size={14} />, primary: true,
      eligible: (u) => canManage(u) && !u.is_deleted && !u.is_active,
      run: (u) => usersApi.activate(u.id) },
    { key: 'deactivate', label: 'Deactivate', tone: 'danger', done: 'deactivated', icon: <UserX size={14} />, primary: true,
      eligible: (u) => canManage(u) && !u.is_deleted && u.is_active && u.id !== me?.id && !u.is_super_admin,
      run: (u) => usersApi.deactivate(u.id) },
    { key: 'enable_mfa', label: 'Enable MFA', tone: 'primary', done: 'MFA enabled', icon: <ShieldCheck size={14} />,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && !u.is_super_admin && u.role !== 'admin' && !u.mfa_required && u.mfa_policy === 'disabled',
      run: (u) => usersApi.setMfaPolicy(u.id, 'optional') },
    { key: 'enforce_mfa', label: 'Enforce MFA', tone: 'primary', done: 'MFA enforced', icon: <Shield size={14} />,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && !u.is_super_admin && u.role !== 'admin',
      run: (u) => usersApi.setMfaPolicy(u.id, 'enforced') },
    { key: 'disable_mfa', label: 'Disable MFA', tone: 'danger', done: 'MFA disabled', icon: <ShieldOff size={14} />,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && !u.is_super_admin && u.role !== 'admin' && !u.mfa_required,
      run: (u) => usersApi.setMfaPolicy(u.id, 'disabled') },
    { key: 'reset_mfa', label: 'Reset MFA', tone: 'danger', done: 'MFA reset', icon: <RefreshCw size={14} />,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && u.mfa_enabled,
      run: (u) => usersApi.resetMfa(u.id) },
    { key: 'force_pw', label: 'Force password change', tone: 'primary', done: 'flagged for password change', icon: <KeySquare size={14} />, primary: true,
      eligible: (u) => canManage(u) && !u.is_deleted && u.id !== me?.id && !u.must_change_password,
      run: (u) => usersApi.forcePasswordChange(u.id) },
    { key: 'logout_all', label: 'Force logout all', tone: 'danger', done: 'logged out', icon: <LogOut size={14} />, primary: true,
      eligible: (u) => canManageSessions(u) && u.id !== me?.id,
      run: (u) => sessionsApi.terminateAll(u.id) },
    { key: 'delete', label: 'Delete', tone: 'danger', done: 'deleted', icon: <Trash2 size={14} />,
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
    setSelected(new Set());
    reload();
    const parts = [`${ok} ${bulk.done}`];
    if (skipped) parts.push(`${skipped} skipped`);
    if (fail) parts.push(`${fail} failed`);
    (fail ? toast.error : toast.success)(parts.join(' · '));
  }

  useEffect(() => {
    accessApi.listRoles().then((d) => setRoles(d.roles)).catch(() => {});
  }, []);

  // Debounced search -> ?search= (email/name/phone).
  const [searchInput, setSearchInput] = useState(query.search || '');
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery((q) => ({ ...q, search: searchInput || undefined, page: 1 }));
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput, setQuery]);

  function setStatus(v) {
    const next = { ...query, page: 1 };
    delete next.is_active;
    delete next.locked;
    if (v === 'deleted') next.is_deleted = 'true';
    else if (v === 'active') { next.is_active = 'true'; next.is_deleted = 'false'; }
    else if (v === 'inactive') { next.is_active = 'false'; next.is_deleted = 'false'; }
    else if (v === 'locked') { next.locked = 'true'; next.is_deleted = 'false'; }
    else next.is_deleted = 'false';   // cleared -> non-deleted
    setQuery(next);
  }

  async function runConfirm() {
    if (!confirm) return;
    const { user: u, kind } = confirm;
    setConfirmBusy(true);
    setConfirmErr('');
    try {
      if (kind === 'deactivate') { await usersApi.deactivate(u.id); toast.success('User deactivated'); }
      else if (kind === 'activate') { await usersApi.activate(u.id); toast.success('User activated'); }
      else if (kind === 'unlock') { await usersApi.unlock(u.id); toast.success('Account unlocked'); }
      else if (kind === 'forcepw') { await usersApi.forcePasswordChange(u.id); toast.success('Password change required at next login'); }
      else if (kind === 'resetmfa') { await usersApi.disableMfa(u.id); toast.success('MFA reset - user must re-enrol'); }
      else if (kind === 'delete') { await usersApi.remove(u.id); toast.success('User deleted'); }
      else if (kind === 'transfer') {
        await usersApi.transferSuperAdmin(u.id);
        toast.success('Super admin transferred. You are now an Admin.');
        setConfirm(null);
        // The caller just demoted themselves - reload so their new context applies.
        window.location.assign('/users');
        return;
      }
      setConfirm(null);
      reload();
    } catch (e) {
      // Surface the backend 403/400 inline in the dialog - never a silent fail.
      setConfirmErr(apiErr(e, 'Unable to complete the requested action. Please try again.'));
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
        label: u.is_active ? 'Deactivate' : 'Activate',
        icon: u.is_active ? <UserX size={15} /> : <UserCheck size={15} />,
        danger: u.is_active,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: u.is_active ? 'deactivate' : 'activate' }); },
      },
      !isSelf && manage && !u.is_deleted && {
        key: 'resetpw',
        label: 'Reset password',
        icon: <KeyRound size={15} />,
        onClick: () => setPwUser(u),
      },
      !isSelf && manage && !u.is_deleted && !u.must_change_password && {
        key: 'forcepw',
        label: 'Force password change',
        icon: <KeySquare size={15} />,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: 'forcepw' }); },
      },
      !isSelf && manage && !u.is_deleted && {
        key: 'resetmfa',
        label: 'Reset MFA',
        icon: <ShieldOff size={15} />,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: 'resetmfa' }); },
      },
      manage && u.is_locked && {
        key: 'unlock',
        label: 'Unlock account',
        icon: <Unlock size={15} />,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: 'unlock' }); },
      },
      // Owner-only: hand the single super-admin to an eligible active staff user.
      canTransferSuperAdmin(me, u) && {
        key: 'transfer',
        label: 'Make super admin',
        icon: <ShieldCheck size={15} />,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: 'transfer' }); },
      },
      // Delete is only for accounts that never signed in - once a user has
      // logged in, keep them for history and use Deactivate instead.
      !isSelf && manage && !u.is_deleted && !u.last_login && {
        key: 'delete',
        label: 'Delete user',
        icon: <Trash2 size={15} />,
        danger: true,
        onClick: () => { setConfirmErr(''); setConfirm({ user: u, kind: 'delete' }); },
      },
    ];
  }

  const cfg = confirm ? CONFIRM[confirm.kind] : null;

  return (
    <>
      <Toolbar
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        searchPlaceholder="Name, email, phone…"
        filters={[
          { value: query.role,
            options: roles.filter((r) => r.is_system).map((r) => ({ value: r.slug, label: r.name })),
            placeholder: 'All roles',
            onChange: (v) => setQuery({ ...query, role: v, page: 1 }) },
          { value: statusValueFromQuery(query), options: STATUS_OPTIONS,
            placeholder: 'Status', onChange: setStatus },
          { value: query.mfa_enabled, options: MFA_OPTIONS,
            placeholder: 'MFA', onChange: (v) => setQuery({ ...query, mfa_enabled: v, page: 1 }) },
        ]}
        right={hasPerm('users.add') && <button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus size={15} /> New user</button>}
      />

      {selected.size > 0 && (
        <div className="fade-in" style={{
          marginBottom: 12, padding: '10px 14px', borderRadius: 10,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          background: 'rgba(124,58,237,0.06)',
          border: '1px solid var(--color-primary-200, rgba(124,58,237,0.25))',
          boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13,
            color: 'var(--color-primary-700, #6d28d9)',
          }}>
            <CheckSquare size={16} />{selected.size} selected
          </span>
          <span style={{ width: 1, height: 20, background: 'var(--color-border)', margin: '0 4px' }} />
          {BULK_ACTIONS.filter((a) => a.primary).map((a) => {
            const danger = a.tone === 'danger';
            return (
              <button
                key={a.key}
                type="button"
                title={a.label}
                onClick={() => setBulk(a)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 12.5, fontWeight: 600, padding: '6px 11px', borderRadius: 8,
                  cursor: 'pointer', lineHeight: 1.2,
                  border: `1px solid ${danger ? 'rgba(220,38,38,0.35)' : 'var(--color-border)'}`,
                  background: danger ? 'rgba(220,38,38,0.05)' : '#fff',
                  color: danger ? '#b91c1c' : 'var(--color-text, #1f2937)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = danger ? 'rgba(220,38,38,0.12)' : 'var(--color-surface-2, #f3f4f6)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = danger ? 'rgba(220,38,38,0.05)' : '#fff'; }}
              >
                {a.icon}{a.label}
              </button>
            );
          })}
          <RowMenu
            triggerLabel="More actions"
            items={BULK_ACTIONS.filter((a) => !a.primary).map((a) => ({
              key: a.key, label: a.label, icon: a.icon, danger: a.tone === 'danger',
              onClick: () => setBulk(a),
            }))}
          />
          <button type="button" className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => setSelected(new Set())}><X size={14} /> Clear</button>
        </div>
      )}

      {error ? (
        <ErrorState message="Unable to load the users. Please try again." onRetry={reload} />
      ) : (
      <DataTable
        loading={loading}
        rows={rows}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        emptyTitle="No users found"
        emptyHint="Try adjusting your search or filters."
        columns={[
          { key: '_select', width: 36,
            header: <input type="checkbox" checked={allPageSelected}
                           onChange={toggleAllPage} aria-label="Select all on page" />,
            render: (u) => <input type="checkbox" checked={selected.has(u.id)}
                                  onChange={() => toggleRow(u.id)} aria-label={`Select ${u.email}`} /> },
          { key: 'name', header: 'Name', render: (u) => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{u.full_name}</span>
              {u.is_super_admin && <StatusBadge tone="info" label="Owner" />}
            </span>
          ) },
          { key: 'email', header: 'Email', truncate: true, width: 240,
            render: (u) => <span className="muted">{u.email}</span> },
          { key: 'role', header: 'Role',
            render: (u) => <StatusBadge tone="info" label={u.role_name || roleLabel(u.role)} /> },
          { key: 'status', header: 'Status', render: (u) => <StatusCell u={u} /> },
          { key: 'access', header: 'Login Access', render: (u) => <AccessCell u={u} /> },
          { key: 'mfa', header: 'MFA', render: (u) => <MfaCell u={u} /> },
          { key: 'last_login', header: 'Last Login', nowrap: true,
            render: (u) => <span className="muted">{fmtDateTime(u.last_login)}</span> },
          { key: 'actions', header: '', align: 'right', render: (u) => (
            <div className="table-actions" style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              {!u.is_deleted && (
                <button className="icon-btn" title="Edit user" onClick={() => setEditUser(u)}><Pencil size={15} /></button>
              )}
              <button className="icon-btn" title="View details" onClick={() => setViewUser(u)}><Eye size={15} /></button>
              <RowMenu items={rowMenuItems(u)} />
            </div>
          ) },
        ]}
      />
      )}

      <UserFormModal open={createOpen} roles={roles} onClose={() => setCreateOpen(false)}
        onSaved={() => { setCreateOpen(false); toast.success('User created'); reload(); }} />
      <UserFormModal open={Boolean(editUser)} user={editUser} roles={roles} onClose={() => setEditUser(null)}
        onSaved={() => { setEditUser(null); toast.success('User updated'); reload(); }}
        onMfaChanged={reload} />
      <SetPasswordModal user={pwUser} onClose={() => setPwUser(null)}
        onSaved={() => { setPwUser(null); toast.success('Password updated'); reload(); }} />
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
                <div style={{ marginTop: 8, color: '#dc2626', fontSize: 13 }}>None of the selected users are eligible for this action.</div>
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
            <div style={{ marginBottom: 12 }}><StatusBadge tone="info" label="Owner" /></div>
          )}
          <DLRow label="Status"><StatusCell u={u} /></DLRow>
          <DLRow label="Admin Web Portal login">
            <StatusBadge tone={u.web_login_enabled ? 'success' : 'muted'}
                         label={u.web_login_enabled ? 'Enabled' : 'Disabled'} />
          </DLRow>
          <DLRow label="Mobile App login">
            <StatusBadge tone={u.mobile_login_enabled ? 'success' : 'muted'}
                         label={u.mobile_login_enabled ? 'Enabled' : 'Disabled'} />
          </DLRow>
          <DLRow label="User type / role">{u.role_name || roleLabel(u.role)}</DLRow>
          <DLRow label="Phone">{u.phone || '-'}</DLRow>
          <DLRow label="Assigned clubs">{(u.assigned_site_names || []).join(', ') || '-'}</DLRow>
          <DLRow label="MFA enrolled">{u.mfa_enabled ? 'Yes' : 'No'}</DLRow>
          <DLRow label="MFA required (role)">{u.mfa_required ? 'Yes' : 'No'}</DLRow>
          <DLRow label="MFA enforced (admin)">{u.mfa_enforced ? 'Yes' : 'No'}</DLRow>
          <DLRow label="Must change password">{u.must_change_password ? 'Yes' : 'No'}</DLRow>
          <DLRow label="Failed login attempts">{u.failed_login_attempts ?? 0}</DLRow>
          <DLRow label="Locked">{u.is_locked ? `Yes - until ${fmtDateTime(u.locked_until)}` : 'No'}</DLRow>
          <DLRow label="Active sessions">{liveCount}</DLRow>
          <DLRow label="Last login">{fmtDateTime(u.last_login)}</DLRow>
          <DLRow label="Last login IP">{u.last_login_ip || '-'}</DLRow>
          <DLRow label="Last activity">{fmtDateTime(u.last_activity_at)}</DLRow>
          <DLRow label="Password changed">{fmtDateTime(u.last_password_change_at)}</DLRow>
          <DLRow label="Created">{fmtDateTime(u.created_at)}</DLRow>

          {/* Sessions: only when the actor may manage them (owner/other-admin
              hidden per senior guard; the backend would 403 anyway). */}
          {canManageSessions && (
            <>
              <div className="divider" />
              <SessionsPanel userId={u.id} title="Sessions" onCount={setSessionCount}
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
function SessionsPanel({ userId = null, title = 'Active sessions', terminateWarning, onCount, onTerminatedSelf }) {
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
        toast.success('Session revoked');
      } else {
        await sessionsApi.terminateAll(userId);
        setConfirm(null);
        // Terminating ALL of your OWN sessions revokes THIS one too - sign out
        // cleanly + redirect instead of a follow-up load() that would 401.
        if (onTerminatedSelf || isSelf) {
          if (onTerminatedSelf) { await onTerminatedSelf(); }
          else {
            toast.success('All sessions terminated - signing you out');
            try { await logout(); } finally { window.location.assign('/login'); }
          }
          return;
        }
        await load();
        toast.success('All sessions terminated');
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
          {title}{rows ? ` (${rows.length})` : ''}
        </div>
        {rows && rows.length > 0 && (
          <button className="btn btn-ghost" style={{ fontSize: 13 }}
            onClick={() => { setActErr(''); setConfirm({ kind: 'all' }); }}>
            <LogOut size={14} /> Terminate all
          </button>
        )}
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>No active sessions.</p>
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
              <button className="icon-btn" title="Revoke session"
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
        title={confirm?.kind === 'all' ? 'Terminate all sessions?' : 'Revoke session?'}
        confirmLabel={confirm?.kind === 'all' ? 'Terminate all' : 'Revoke'}
        message={confirm ? (
          <>
            {confirm.kind === 'all'
              ? <>Sign out of all active sessions? {terminateWarning}</>
              : <>Revoke this session? That device is signed out on its next request.</>}
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
      if (kind === 'terminate') { await sessionsApi.revoke(row.id); toast.success('Session terminated'); }
      else { await sessionsApi.terminateAll(row.user_id); toast.success('All sessions terminated for user'); }
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
      { key: 'details', label: 'View session details', icon: <Eye size={15} />, onClick: () => setDetail(r) },
      { key: 'profile', label: 'View user profile', icon: <UserIcon size={15} />, onClick: () => viewProfile(r) },
      { key: 'audit', label: 'View audit logs', icon: <FileText size={15} />,
        onClick: () => navigate(`/auditlogs?search=${encodeURIComponent(r.email || '')}`) },
      r.can_manage && { key: 'terminate', label: 'Terminate session', icon: <Trash2 size={15} />, danger: true,
        onClick: () => { setConfirmErr(''); setConfirm({ kind: 'terminate', row: r }); } },
      r.can_manage && { key: 'all', label: 'Force logout all (this user)', icon: <LogOut size={15} />, danger: true,
        onClick: () => { setConfirmErr(''); setConfirm({ kind: 'all', row: r }); } },
    ];
  }

  const columns = [
    { key: 'user', header: 'User', render: (r) => (
      <span><div style={{ fontWeight: 600 }}>{r.full_name}</div>
        <div className="muted" style={{ fontSize: 12 }}>{r.email}</div></span>
    ) },
    { key: 'role', header: 'Role', render: (r) => <StatusBadge tone="info" label={r.role_name || r.role} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge tone={SESSION_TONE[r.status] || 'muted'} label={r.status} /> },
    { key: 'device', header: 'Device', render: (r) => (
      <span style={{ fontSize: 12.5 }}>
        {[r.browser, r.operating_system, r.device_type].filter(Boolean).join(' · ') || '-'}
      </span>
    ) },
    { key: 'ip', header: 'IP', nowrap: true, render: (r) => <span className="muted">{r.ip_address || '-'}</span> },
    { key: 'login', header: 'Login', nowrap: true, render: (r) => <span className="muted">{fmtDateTime(r.login_at)}</span> },
    { key: 'last', header: 'Last activity', nowrap: true, render: (r) => <span className="muted">{fmtDateTime(r.last_activity_at)}</span> },
    { key: 'mfa', header: 'MFA', render: (r) => (r.mfa_verified ? <StatusBadge tone="success" label="Verified" /> : <span className="muted">-</span>) },
    { key: 'actions', header: '', align: 'right', render: (r) => (
      <div className="table-actions" style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
        <button className="icon-btn" title="Session details" onClick={() => setDetail(r)}><Eye size={15} /></button>
        <RowMenu items={rowMenu(r)} />
      </div>
    ) },
  ];

  return (
    <>
      <Toolbar
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Name, email, session ID, IP…"
        filters={[]}
        right={<button className="btn btn-secondary" onClick={load}><RefreshCw size={15} /> Refresh</button>}
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
          emptyTitle="No active sessions"
          emptyHint="Active sessions appear here when users sign in."
          columns={columns}
        />
      )}

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)}
        title={detail ? `Session · ${detail.full_name}` : ''} size="md"
        footer={<button className="btn btn-secondary" onClick={() => setDetail(null)}>Close</button>}>
        {detail && (
          <div>
            <DLRow label="Session ID">{detail.session_id} <span className="muted">({detail.jti})</span></DLRow>
            <DLRow label="User">{detail.full_name} - {detail.email}</DLRow>
            <DLRow label="Role">{detail.role_name || detail.role}</DLRow>
            <DLRow label="Club(es)">{(detail.site_names || []).join(', ') || '-'}</DLRow>
            <DLRow label="Status">{detail.status}</DLRow>
            <DLRow label="MFA verified">{detail.mfa_verified ? 'Yes' : 'No'}</DLRow>
            <DLRow label="IP address">{detail.ip_address || '-'}</DLRow>
            <DLRow label="Device type">{detail.device_type || '-'}</DLRow>
            <DLRow label="Browser">{detail.browser || '-'}</DLRow>
            <DLRow label="Operating system">{detail.operating_system || '-'}</DLRow>
            <DLRow label="Login time">{fmtDateTime(detail.login_at)}</DLRow>
            <DLRow label="Last activity">{fmtDateTime(detail.last_activity_at)}</DLRow>
            <DLRow label="Session duration">{fmtDuration(detail.login_at)}</DLRow>
            <DLRow label="Expires">{fmtDateTime(detail.expires_at)}</DLRow>
          </div>
        )}
      </Modal>

      <ViewUserDrawer user={viewUser} canManageSessions={false} onClose={() => setViewUser(null)} />

      <ConfirmDialog
        open={Boolean(confirm)}
        busy={busy}
        tone="danger"
        title={confirm?.kind === 'all' ? 'Force logout all sessions?' : 'Terminate session?'}
        confirmLabel={confirm?.kind === 'all' ? 'Force logout all' : 'Terminate'}
        message={confirm ? (
          <>
            {confirm.kind === 'all'
              ? <>End <strong>all</strong> active sessions for <strong>{confirm.row.email}</strong>? They'll be signed out on every device.</>
              : <>Terminate this session for <strong>{confirm.row.email}</strong>? That device is signed out on its next request.</>}
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
const POLICY_BADGE = {
  enforced: { tone: 'warning', label: 'Enforced' },
  disabled: { tone: 'danger', label: 'Disabled' },
  optional: { tone: 'info', label: 'Enabled (optional)' },
};
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
        toast.success('MFA reset - user must re-enrol');
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

  const badge = POLICY_BADGE[policy] || POLICY_BADGE.optional;
  const status = (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      <StatusBadge tone={enabled ? 'success' : 'muted'} label={enabled ? 'Enrolled' : 'Not enrolled'} />
      <StatusBadge tone={badge.tone} label={badge.label} />
      {roleRequired && <StatusBadge tone="info" label="Required by role" />}
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
        <p className="muted" style={{ fontSize: 12 }}>Only a super admin can manage this account’s MFA.</p>
      </div>
    );
  }

  return (
    <div>
      {status}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {policy === 'disabled' && (
          <button type="button" className="btn btn-primary" onClick={() => ask('enable')}>
            <ShieldCheck size={15} /> Enable MFA
          </button>
        )}
        {policy === 'optional' && (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => ask('disable')}>
              <ShieldOff size={15} /> Disable MFA
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => ask('enforce')}>
              <Shield size={15} /> Enforce MFA
            </button>
          </>
        )}
        {policy !== 'disabled' && (
          <button type="button" className="btn btn-secondary" onClick={() => setSettingsOpen((o) => !o)}>
            <Settings size={15} /> User MFA settings
          </button>
        )}
      </div>

      {policy === 'disabled' && (
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          MFA is turned off for this user. Enabling makes it available for them to set up on their own device.
        </p>
      )}
      {policy === 'enforced' && !settingsOpen && (
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          MFA is enforced. To turn it off, open <strong>User MFA settings</strong> and remove enforcement first.
        </p>
      )}

      {settingsOpen && policy !== 'disabled' && (
        <div style={{ marginTop: 10, padding: 12, border: '1px solid var(--color-border-soft, #eef0f3)', borderRadius: 8 }}>
          <MfaSettingRow title="Enforcement" desc="Require this user to keep MFA enrolled.">
            {roleRequired ? (
              <StatusBadge tone="info" label="Required by role" />
            ) : policy === 'enforced' ? (
              <button type="button" className="btn btn-ghost" onClick={() => ask('unenforce')}>Remove</button>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={() => ask('enforce')}>Enforce</button>
            )}
          </MfaSettingRow>
          <MfaSettingRow top title="Reset MFA" desc="Remove the current authenticator; the user must set it up again.">
            <button type="button" className="btn btn-ghost" disabled={!enabled} onClick={() => ask('reset')}>Reset</button>
          </MfaSettingRow>
          <MfaSettingRow top title="Disable MFA" desc="Turn MFA off for this user (they can’t use it).">
            <button type="button" className="btn btn-ghost" disabled={roleRequired || isOwner} onClick={() => ask('disable')}>Disable</button>
          </MfaSettingRow>
          {(roleRequired || isOwner) && (
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {roleRequired ? 'This user’s role requires MFA - it can’t be removed or disabled.'
                : 'The owner account can’t have MFA disabled.'}
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
            {confirm.kind === 'enable' && <>Make MFA available for this user? They can set it up from their own profile (optional - not enforced).</>}
            {confirm.kind === 'disable' && <>Turn MFA off for <strong>this user</strong>? Any existing authenticator is removed and they can’t use MFA until it’s re-enabled.</>}
            {confirm.kind === 'enforce' && <>Require this user to keep MFA enrolled? If they aren’t enrolled, they’ll be gated to set it up at next login.</>}
            {confirm.kind === 'unenforce' && <>Remove the enforcement? MFA becomes optional - the user may keep or turn off their own MFA.</>}
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
  const roleOptions = assignableRoleOptions(roles, me);

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
    setSiteIds(new Set(user?.assigned_sites || []));
    setBayIds(new Set(user?.assigned_bays || []));
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
    payload.assigned_sites = showSites ? [...siteIds] : [];
    payload.assigned_bays = showSites ? [...bayIds].filter((id) => baysForSites.some((b) => b.id === id)) : [];

    try {
      if (isEdit) await usersApi.update(user.id, payload);
      else await usersApi.create(payload);
      onSaved();
    } catch (e) {
      setFormError(apiErr(e, isEdit ? 'Unable to update the user. Please try again.' : 'Unable to create the user. Please try again.'));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${user.email}` : 'New user'} size="lg"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
          {isEdit ? 'Save changes' : 'Create user'}
        </button>
      </>}>
      {formError && (
        <div style={{
          marginBottom: 14, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: 'rgba(220,38,38,0.08)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.25)',
        }}>{formError}</div>
      )}
      <div className="row">
        <div className="col"><FormField label="First name" error={errors.first_name?.message}>
          <input className="form-input" {...register('first_name', { required: 'Required' })} /></FormField></div>
        <div className="col"><FormField label="Last name" error={errors.last_name?.message}>
          <input className="form-input" {...register('last_name', { required: 'Required' })} /></FormField></div>
      </div>
      <div className="row">
        <div className="col"><FormField label="Email" hint="Used as the login identifier." error={errors.email?.message}>
          <input className="form-input" type="email" {...register('email', { required: 'Required' })} /></FormField></div>
        <div className="col"><FormField label="Phone">
          <input className="form-input" {...register('phone')} /></FormField></div>
      </div>
      <div className="row">
        <div className="col"><FormField label="Role"
          hint={roleDisabled ? 'You cannot change your own role.' : undefined}>
          <Controller name="role" control={control} render={({ field }) => (
            <Select2
              options={roleOptions}
              value={field.value} onChange={field.onChange} placeholder="Select role…"
              disabled={roleDisabled}
            />
          )} /></FormField></div>
        <div className="col">
          {!statusHidden && (
            <FormField label="Status"
              hint={statusDisabled ? 'You cannot change your own status.' : 'Inactive users cannot log in.'}>
              <Toggle label="Active" disabled={statusDisabled} {...register('is_active')} />
            </FormField>
          )}
        </div>
      </div>

      {/* Per-channel login access - an additional control on top of the role.
          Independent: a user may be allowed on one channel and blocked on the other. */}
      <div className="row">
        <div className="col">
          <FormField label="Admin Web Portal login access"
            hint={webAccessLocked
              ? 'You cannot change this for your own or the owner account.'
              : 'When disabled, this user cannot sign in to the admin panel.'}>
            <Toggle label="Enabled" disabled={webAccessLocked} {...register('web_login_enabled')} />
          </FormField>
        </div>
        <div className="col">
          <FormField label="Mobile App login access"
            hint="When disabled, this user cannot sign in from the mobile app.">
            <Toggle label="Enabled" {...register('mobile_login_enabled')} />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col"><FormField
          label={isEdit ? 'New password' : 'Password'}
          hint={isEdit ? 'Leave blank to keep current.' : 'Min 10 chars; upper, lower, digit, symbol.'}
          error={errors.password?.message}>
          <input className="form-input" type="text" autoComplete="new-password"
            {...register('password', {
              required: isEdit ? false : 'Required',
              minLength: { value: 10, message: 'Min 10 characters' },
            })} />
        </FormField></div>
        <div className="col"><FormField label="Confirm password" error={errors.confirm_password?.message}>
          <input className="form-input" type="text" autoComplete="new-password"
            {...register('confirm_password', {
              validate: (val) => (!pwValue && !val) || val === pwValue || 'Passwords do not match',
            })} />
        </FormField></div>
      </div>

      {/* --- Multi-factor authentication --- */}
      <FormField label="Multi-factor authentication">
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
              Enforce MFA - require this user to enrol before using the app
            </label>
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              New users set up MFA themselves on their device; enforcing requires them to enrol at first login.
            </p>
          </>
        )}
      </FormField>

      {baseRole === 'super_admin' && (
        <p className="muted" style={{ fontSize: 13 }}>Super admins have full, unrestricted access.</p>
      )}

      {/* --- Clubs & facilities --- */}
      {showSites && (
        <>
          <div className="divider" />
          <FormField label="Assigned clubs" hint="This user only sees data for these clubs.">
            <Select2
              multiple
              options={clubs.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }))}
              value={[...siteIds]}
              onChange={(arr) => setSiteIds(new Set(arr))}
              placeholder="Select clubs…"
              emptyText="No clubs configured yet."
            />
          </FormField>
          <FormField label="Assigned facilities" hint="Facilities within the selected clubs.">
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
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || pw.length < 10}>Set password</button>
      </>}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        The user must set a new password at their next login.
      </p>
      <FormField label="New password" hint="Min 10 chars with upper, lower, digit, and a symbol."
        error={err || undefined}>
        <input className="form-input" type="text" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      </FormField>
    </Modal>
  );
}
