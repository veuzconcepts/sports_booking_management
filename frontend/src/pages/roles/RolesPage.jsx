import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2, ShieldCheck, Copy } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { CUSTOM_BASE_ROLES, accessApi } from '../../services/usersService.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { usePrompt } from '../../components/PromptDialog.jsx';
import { assignableBaseRoles } from '../../utils/rbac.js';
import { apiErrorMessage } from '../../utils/apiError';

const baseLabel = (v) => CUSTOM_BASE_ROLES.find((b) => b.value === v)?.label?.split(' (')[0] || v;

export default function RolesPage() {
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const prompt = usePrompt();
  const canCreate = hasPerm('roles.add');
  const canEdit = hasPerm('roles.edit');
  const canDelete = hasPerm('roles.delete');
  const canDuplicate = hasPerm('roles.duplicate');
  // With roles.duplicate you can duplicate any role except super_admin.
  const canDup = (r) => canDuplicate && r.base_role !== 'super_admin';
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    accessApi.listRoles()
      .then((d) => setRoles(d.roles))
      .catch((e) => toast.error(apiErrorMessage(e, 'Unable to load the roles. Please try again.')))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  async function doDelete() {
    setBusy(true);
    try {
      await accessApi.deleteRole(toDelete.slug);
      toast.success('Role deleted');
      setToDelete(null);
      load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to delete the role. Please try again.'));
    } finally { setBusy(false); }
  }

  async function doDuplicate(r) {
    const name = await prompt({ title: 'Duplicate role', label: 'New role name',
      defaultValue: `${r.name} (copy)` });
    if (!name) return;
    try {
      const created = await accessApi.duplicateRole(r.slug, { name });
      toast.success('Role duplicated');
      navigate(`/roles/${created.slug}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to duplicate the role. Please try again.'));
    }
  }

  return (
    <>
      <PageHeader
        title="Roles & Permissions"
        subtitle="Define roles and what each can do. Assign them to users on the Users page."
        actions={
          canCreate && (
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> New role
            </button>
          )
        }
      />

      <DataTable
        loading={loading}
        rows={roles}
        onRowClick={(r) => r.editable && navigate(`/roles/${r.slug}`)}
        emptyTitle="No roles"
        emptyHint="Create a role to get started."
        columns={[
          { key: 'name', header: 'Role', render: (r) => (
            <div>
              {r.editable ? (
                <button className="link-btn" style={{ fontWeight: 600 }}
                  onClick={(e) => { e.stopPropagation(); navigate(`/roles/${r.slug}`); }}>{r.name}</button>
              ) : (
                <div style={{ fontWeight: 600 }}>{r.name}</div>
              )}
              <div className="muted" style={{ fontSize: 12 }}><code>{r.slug}</code></div>
            </div>
          ) },
          { key: 'type', header: 'Type', render: (r) => (
            <StatusBadge tone={r.is_system ? 'muted' : 'info'} label={r.is_system ? 'System' : 'Custom'} />
          ) },
          { key: 'base', header: 'Behaviour', render: (r) => (r.is_system ? '-' : baseLabel(r.base_role)) },
          { key: 'perms', header: 'Permissions', render: (r) => (
            r.editable ? `${r.permissions.length} permission(s)` : <span className="muted">Full access</span>
          ) },
          { key: 'users', header: 'Users', render: (r) => r.user_count },
          { key: 'actions', header: '', sticky: 'right', render: (r) => (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              {r.editable ? (
                <button className="icon-btn" title="Edit permissions" onClick={(e) => { e.stopPropagation(); navigate(`/roles/${r.slug}`); }}>
                  <Pencil size={15} />
                </button>
              ) : (
                <ShieldCheck size={15} color="var(--color-text-muted)" title="Full access" />
              )}
              {canDup(r) && (
                <button className="icon-btn" title="Duplicate role" onClick={(e) => { e.stopPropagation(); doDuplicate(r); }}>
                  <Copy size={15} />
                </button>
              )}
              {canDelete && r.deletable && (
                <button className="icon-btn" title="Delete role" onClick={(e) => { e.stopPropagation(); setToDelete(r); }}>
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ) },
        ]}
      />

      <NewRoleModal open={createOpen} onClose={() => setCreateOpen(false)}
        onCreated={(slug) => { setCreateOpen(false); toast.success('Role created'); navigate(`/roles/${slug}`); }} />

      <ConfirmDialog
        open={Boolean(toDelete)}
        busy={busy}
        tone="danger"
        title="Delete role?"
        confirmLabel="Delete"
        message={<>Delete the role <strong>{toDelete?.name}</strong>? This cannot be undone.</>}
        onConfirm={doDelete}
        onClose={() => !busy && setToDelete(null)}
      />
    </>
  );
}

function NewRoleModal({ open, onClose, onCreated }) {
  const { role } = useAuth();
  const [name, setName] = useState('');
  const [base, setBase] = useState('facility_staff');
  const [busy, setBusy] = useState(false);

  // The admin (senior) base is super-admin-only; the backend enforces this too.
  const baseOptions = assignableBaseRoles({ role });

  useEffect(() => { if (open) { setName(''); setBase('facility_staff'); } }, [open]);

  async function submit() {
    if (!name.trim()) { toast.error('Role name is required.'); return; }
    setBusy(true);
    try {
      // Start a custom role from its base tier's default permissions.
      const role = await accessApi.createRole({ name: name.trim(), base_role: base });
      onCreated?.(role.slug);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to create the role. Please try again.'));
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="New role" size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>Create & edit</button>
      </>}>
      <FormField label="Role name" hint="e.g. Club Supervisor, Cashier.">
        <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </FormField>
      <FormField label="Behaviour tier" hint="Controls data scoping & staff behaviour; you'll fine-tune permissions next.">
        <Select2 options={baseOptions} value={base} onChange={setBase} />
      </FormField>
    </Modal>
  );
}
