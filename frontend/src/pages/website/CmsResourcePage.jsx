import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Pencil, Trash2, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { apiErrorMessage } from '../../utils/apiError.js';
import { cmsResources } from './cmsConfig.jsx';
import { CmsFormModal } from './CmsFormModal.jsx';

export default function CmsResourcePage() {
  const { t } = useTranslation('website');
  const { resource: resourceKey } = useParams();
  // Rebuilt when the language changes so every label follows it.
  const resource = useMemo(() => cmsResources(t)[resourceKey], [t, resourceKey]);
  const { hasPerm } = useAuth();
  const canEdit = hasPerm('website.edit');
  const canPublish = hasPerm('website.publish');

  const fetcher = useCallback(
    (q) => (resource ? resource.api.list(q) : Promise.resolve({ results: [], count: 0 })),
    [resource],
  );
  const { rows, loading, count, query, setQuery, reload } = useApiList(fetcher, { ordering: 'display_order' });

  const [editRow, setEditRow] = useState(null);   // record being edited (or {} for new)
  const [deleteRow, setDeleteRow] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!resource) return <div className="muted" style={{ padding: 24 }}>{t('unknownWebsiteSection')}</div>;

  async function togglePublish(r) {
    try {
      await resource.api.setPublished(r.id, !r.is_published);
      toast.success(r.is_published ? t('unpublished') : t('publishedLiveClub'));
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUpdatePublishStatePlease')));
    }
  }

  async function doDelete() {
    if (!deleteRow) return;
    setBusy(true);
    try {
      await resource.api.remove(deleteRow.id);
      toast.success(t('cms.deleted', { item: resource.singular }));
      setDeleteRow(null);
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableDeletePleaseTryAgain')));
    } finally { setBusy(false); }
  }

  const columns = [
    ...resource.columns,
    ...(resource.hasPublish ? [
      { key: 'is_enabled', header: t('common:state.enabled'),
        render: (r) => <StatusBadge tone={r.is_enabled ? 'success' : 'muted'} label={r.is_enabled ? 'On' : 'Off'} /> },
      { key: 'is_published', header: t('common:labels.status'),
        render: (r) => <StatusBadge tone={r.is_published ? 'success' : 'warning'} label={r.is_published ? t('published') : t('common:state.draft')} /> },
      { key: 'display_order', header: t('order'), render: (r) => r.display_order },
    ] : []),
    {
      key: 'actions', header: '', sticky: 'right', render: (r) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          {resource.hasPublish && canPublish && (
            <button className="icon-btn" title={r.is_published ? t('unpublish') : t('publish')}
              onClick={(e) => { e.stopPropagation(); togglePublish(r); }}>
              {r.is_published ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          )}
          {canEdit && (
            <button className="icon-btn" title={t('common:actions.edit')} onClick={(e) => { e.stopPropagation(); setEditRow(r); }}>
              <Pencil size={15} />
            </button>
          )}
          {canEdit && (
            <button className="icon-btn" title={t('common:actions.delete')} style={{ color: 'var(--color-danger,#dc2626)' }}
              onClick={(e) => { e.stopPropagation(); setDeleteRow(r); }}>
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={resource.title}
        subtitle={t('manageContentShownCustomerWebsite')}
        actions={canEdit && (
          <button className="btn btn-primary" onClick={() => setEditRow({})}>
            <Plus size={15} /> {t('cms.newItem', { item: resource.singular.toLowerCase() })}
          </button>
        )}
      />

      <DataTable
        loading={loading}
        rows={rows}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        onRowClick={canEdit ? (r) => setEditRow(r) : undefined}
        emptyTitle={t('cms.emptyTitle', { items: resource.title.toLowerCase() })}
        emptyHint={canEdit
          ? t('cms.emptyHint', { item: resource.singular.toLowerCase() })
          : t('cms.emptyHintReadOnly')}
        columns={columns}
      />

      <CmsFormModal
        open={Boolean(editRow)}
        resource={resource}
        record={editRow && editRow.id ? editRow : null}
        onClose={() => setEditRow(null)}
        onSaved={() => { setEditRow(null); reload(); }}
      />

      <ConfirmDialog
        open={Boolean(deleteRow)}
        tone="danger"
        title={t('cms.deleteTitle', { item: resource.singular.toLowerCase() })}
        message={deleteRow ? 'This permanently removes the item from the website CMS.' : ''}
        confirmLabel={t('common:actions.delete')}
        busy={busy}
        onConfirm={doDelete}
        onClose={() => { if (!busy) setDeleteRow(null); }}
      />
    </>
  );
}
