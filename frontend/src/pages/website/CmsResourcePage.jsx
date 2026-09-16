import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Pencil, Trash2, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { apiErrorMessage } from '../../utils/apiError.js';
import { CMS_RESOURCES } from './cmsConfig.jsx';
import { CmsFormModal } from './CmsFormModal.jsx';

export default function CmsResourcePage() {
  const { resource: resourceKey } = useParams();
  const resource = CMS_RESOURCES[resourceKey];
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

  if (!resource) return <div className="muted" style={{ padding: 24 }}>Unknown website section.</div>;

  async function togglePublish(r) {
    try {
      await resource.api.setPublished(r.id, !r.is_published);
      toast.success(r.is_published ? 'Unpublished' : 'Published - live on the club');
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to update the publish state. Please try again.'));
    }
  }

  async function doDelete() {
    if (!deleteRow) return;
    setBusy(true);
    try {
      await resource.api.remove(deleteRow.id);
      toast.success(`${resource.singular} deleted`);
      setDeleteRow(null);
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to delete. Please try again.'));
    } finally { setBusy(false); }
  }

  const columns = [
    ...resource.columns,
    ...(resource.hasPublish ? [
      { key: 'is_enabled', header: 'Enabled',
        render: (r) => <StatusBadge tone={r.is_enabled ? 'success' : 'muted'} label={r.is_enabled ? 'On' : 'Off'} /> },
      { key: 'is_published', header: 'Status',
        render: (r) => <StatusBadge tone={r.is_published ? 'success' : 'warning'} label={r.is_published ? 'Published' : 'Draft'} /> },
      { key: 'display_order', header: 'Order', render: (r) => r.display_order },
    ] : []),
    {
      key: 'actions', header: '', sticky: 'right', render: (r) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          {resource.hasPublish && canPublish && (
            <button className="icon-btn" title={r.is_published ? 'Unpublish' : 'Publish'}
              onClick={(e) => { e.stopPropagation(); togglePublish(r); }}>
              {r.is_published ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          )}
          {canEdit && (
            <button className="icon-btn" title="Edit" onClick={(e) => { e.stopPropagation(); setEditRow(r); }}>
              <Pencil size={15} />
            </button>
          )}
          {canEdit && (
            <button className="icon-btn" title="Delete" style={{ color: 'var(--color-danger,#dc2626)' }}
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
        subtitle="Manage the content shown on the customer website."
        actions={canEdit && (
          <button className="btn btn-primary" onClick={() => setEditRow({})}>
            <Plus size={15} /> New {resource.singular.toLowerCase()}
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
        emptyTitle={`No ${resource.title.toLowerCase()} yet`}
        emptyHint={canEdit ? `Add your first ${resource.singular.toLowerCase()}.` : 'Nothing to show.'}
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
        title={`Delete ${resource.singular.toLowerCase()}?`}
        message={deleteRow ? 'This permanently removes the item from the website CMS.' : ''}
        confirmLabel="Delete"
        busy={busy}
        onConfirm={doDelete}
        onClose={() => { if (!busy) setDeleteRow(null); }}
      />
    </>
  );
}
