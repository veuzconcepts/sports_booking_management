import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2, ShieldCheck, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { customBaseRoles, accessApi } from '../../services/usersService.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { usePrompt } from '../../components/PromptDialog.jsx';
import { assignableBaseRoles } from '../../utils/rbac.js';
import { apiErrorMessage } from '../../utils/apiError';

const baseLabel = (t, v) => customBaseRoles(t).find((b) => b.value === v)?.label?.split(' (')[0] || v;

export default function RolesPage() {
  const { t } = useTranslation('roles');
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
      .then((d) => setRoles(d?.roles || []))
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadRolesPleaseTry'))))
      .finally(() => setLoading(false));
  }, [t]);
  useEffect(load, [load]);

  async function doDelete() {
    setBusy(true);
    try {
      await accessApi.deleteRole(toDelete.slug);
      toast.success(t('roleDeleted'));
      setToDelete(null);
      load();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableDeleteRolePleaseTry')));
    } finally { setBusy(false); }
  }

  async function doDuplicate(r) {
    const name = await prompt({ title: t('duplicateRole'), label: t('newRoleName'),
      defaultValue: `${r.name} (copy)` });
    if (!name) return;
    try {
      const created = await accessApi.duplicateRole(r.slug, { name });
      toast.success(t('roleDuplicated'));
      navigate(`/roles/${created.slug}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableDuplicateRolePleaseTry')));
    }
  }

  return (
    <>
      <PageHeader
        title={t('rolesPermissions')}
        subtitle={t('defineRolesWhatEachCan')}
        actions={
          canCreate && (
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> {t('newRole')}
            </button>
          )
        }
      />

      <DataTable
        loading={loading}
        rows={roles}
        onRowClick={(r) => r.editable && navigate(`/roles/${r.slug}`)}
        emptyTitle={t('noRoles')}
        emptyHint={t('createRoleGetStarted')}
        columns={[
          { key: 'name', header: t('role'), render: (r) => (
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
          { key: 'type', header: t('type'), render: (r) => (
            <StatusBadge tone={r.is_system ? 'muted' : 'info'} label={r.is_system ? t('system') : t('custom')} />
          ) },
          { key: 'base', header: t('behaviour'), render: (r) => (r.is_system ? '-' : baseLabel(t, r.base_role)) },
          { key: 'perms', header: t('permissions'), render: (r) => (
            r.editable ? `${r.permissions.length} permission(s)` : <span className="muted">{t('fullAccess')}</span>
          ) },
          { key: 'users', header: t('users'), render: (r) => r.user_count },
          { key: 'actions', header: '', sticky: 'right', render: (r) => (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              {r.editable ? (
                <button className="icon-btn" title={t('editPermissions')} onClick={(e) => { e.stopPropagation(); navigate(`/roles/${r.slug}`); }}>
                  <Pencil size={15} />
                </button>
              ) : (
                <ShieldCheck size={15} color="var(--color-text-muted)" title={t('fullAccess')} />
              )}
              {canDup(r) && (
                <button className="icon-btn" title={t('duplicateRole')} onClick={(e) => { e.stopPropagation(); doDuplicate(r); }}>
                  <Copy size={15} />
                </button>
              )}
              {canDelete && r.deletable && (
                <button className="icon-btn" title={t('deleteRole2')} onClick={(e) => { e.stopPropagation(); setToDelete(r); }}>
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ) },
        ]}
      />

      <NewRoleModal open={createOpen} onClose={() => setCreateOpen(false)}
        onCreated={(slug) => { setCreateOpen(false); toast.success(t('roleCreated')); navigate(`/roles/${slug}`); }} />

      <ConfirmDialog
        open={Boolean(toDelete)}
        busy={busy}
        tone="danger"
        title={t('deleteRole3')}
        confirmLabel={t('common:actions.delete')}
        message={<>{t('deleteRole')} <strong>{toDelete?.name}</strong>? This cannot be undone.</>}
        onConfirm={doDelete}
        onClose={() => !busy && setToDelete(null)}
      />
    </>
  );
}

function NewRoleModal({ open, onClose, onCreated }) {
  const { t } = useTranslation('roles');
  const { role } = useAuth();
  const [name, setName] = useState('');
  const [base, setBase] = useState('facility_staff');
  const [busy, setBusy] = useState(false);

  // The admin (senior) base is super-admin-only; the backend enforces this too.
  const baseOptions = assignableBaseRoles(t, { role });

  useEffect(() => { if (open) { setName(''); setBase('facility_staff'); } }, [open]);

  async function submit() {
    if (!name.trim()) { toast.error(t('roleNameRequired')); return; }
    setBusy(true);
    try {
      // Start a custom role from its base tier's default permissions.
      const role = await accessApi.createRole({ name: name.trim(), base_role: base });
      onCreated?.(role.slug);
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableCreateRolePleaseTry')));
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('newRole')} size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{t('createEdit')}</button>
      </>}>
      <FormField label={t('roleName')} hint={t('eGClubSupervisorCashier')}>
        <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </FormField>
      <FormField label={t('behaviourTier')} hint={t('behaviourTierHint')}>
        <Select2 options={baseOptions} value={base} onChange={setBase} />
      </FormField>
    </Modal>
  );
}
