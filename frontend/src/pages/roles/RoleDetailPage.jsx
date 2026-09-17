import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { PermissionMatrix } from '../../components/PermissionMatrix.jsx';
import { accessApi } from '../../services/usersService.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { apiErrorMessage } from '../../utils/apiError';

export default function RoleDetailPage() {
  const { t } = useTranslation('roles');
  const { slug } = useParams();
  const navigate = useNavigate();
  const { refreshUser, hasPerm } = useAuth();
  const [sections, setSections] = useState([]);
  const [basicColumns, setBasicColumns] = useState([]);
  const [dataAdminColumns, setDataAdminColumns] = useState([]);
  const [role, setRole] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([accessApi.permissionsCatalog(), accessApi.listRoles()])
      .then(([cat, r]) => {
        setSections(cat.sections || []);
        setBasicColumns(cat.basic_columns || []);
        setDataAdminColumns(cat.data_admin_columns || []);
        const found = r.roles.find((x) => x.slug === slug);
        setRole(found || null);
        setSelected(new Set(found?.permissions || []));
      })
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadRolePleaseTry'))))
      .finally(() => setLoading(false));
  }, [slug, t]);
  useEffect(load, [load]);

  // Editable only when the role allows it AND the user holds roles.edit.
  const readOnly = !role?.editable || !hasPerm('roles.edit');

  async function save() {
    setSaving(true);
    try {
      await accessApi.updateRole(slug, { permissions: [...selected] });
      toast.success(t('permissionsSaved'));
      // Reflect the change live for the current user (e.g. their own role) - no
      // manual page refresh needed.
      await refreshUser?.();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableSaveRolePleaseTry')));
    } finally { setSaving(false); }
  }

  if (loading) {
    return <div className="card"><div className="card-body center" style={{ padding: 64 }}><span className="muted">Loading…</span></div></div>;
  }
  if (!role) {
    return (
      <>
        <button className="btn btn-ghost" onClick={() => navigate('/roles')} style={{ marginBottom: 12 }}>
          <ArrowLeft size={15} /> {t('backRoles')}
        </button>
        <div className="card"><div className="empty"><h3>{t('roleNotFound')}</h3></div></div>
      </>
    );
  }

  return (
    <>
      <button className="btn btn-ghost" onClick={() => navigate('/roles')} style={{ marginBottom: 12 }}>
        <ArrowLeft size={15} /> {t('backRoles')}
      </button>

      <PageHeader
        title={role.name}
        subtitle={role.is_system ? 'System role' : `Custom role · behaves like ${role.base_role}`}
        actions={
          !readOnly && (
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              <Save size={15} /> {saving ? t('common:state.saving') : t('savePermissions')}
            </button>
          )
        }
      />

      <PermissionMatrix
        sections={sections}
        basicColumns={basicColumns}
        dataAdminColumns={dataAdminColumns}
        value={selected}
        onChange={setSelected}
        readOnly={readOnly}
      />

      <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
        <StatusBadge tone="info" label={t('tip')} /> Per-user exceptions (grant/revoke beyond this
        role) are set when creating or editing a user.
      </p>
    </>
  );
}
