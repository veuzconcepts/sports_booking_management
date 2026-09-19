import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Pencil, Trash2, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { apiErrorMessage } from '../../utils/apiError.js';
import { cmsResources } from './cmsConfig.jsx';
import { CmsFormModal } from './CmsFormModal.jsx';

/**
 * One CMS collection: banners, testimonials, FAQ and the rest.
 *
 * Built on the shared listing standard rather than the legacy DataTable, so
 * these pages get the same sorting, column sizing, visibility, saved
 * preferences, search and empty states as every other listing, and the
 * heading lines up with the columns beneath it.
 *
 * `tableKey` is namespaced per resource: banners and testimonials have
 * different columns, so one shared key would hand a visitor the wrong saved
 * layout the first time they opened the second page.
 */
export default function CmsResourcePage() {
  const { t } = useTranslation('website');
  const { t: tc } = useTranslation('common');
  const { resource: resourceKey } = useParams();
  // Rebuilt when the language changes so every label follows it.
  const resource = useMemo(() => cmsResources(t)[resourceKey], [t, resourceKey]);
  const { hasPerm } = useAuth();
  const canEdit = hasPerm('website.edit');
  const canPublish = hasPerm('website.publish');

  const [editRow, setEditRow] = useState(null);   // record being edited (or {} for new)
  const [deleteRow, setDeleteRow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const api = resource?.api;
  const fetcher = useCallback(
    (query) => (api ? api.list(query) : Promise.resolve({ results: [], count: 0 })),
    [api],
  );

  const togglePublish = useCallback(async (row) => {
    try {
      await api.setPublished(row.id, !row.is_published);
      toast.success(row.is_published ? t('unpublished') : t('publishedLiveClub'));
      reload();
    } catch (error) {
      toast.error(apiErrorMessage(error, t('unableUpdatePublishStatePlease')));
    }
  }, [api, reload, t]);

  const rowActions = useCallback((row) => [
    resource?.hasPublish && canPublish && {
      key: 'publish',
      label: row.is_published ? t('unpublish') : t('publish'),
      icon: row.is_published ? <EyeOff size={14} /> : <Eye size={14} />,
      onClick: () => togglePublish(row),
    },
    canEdit && {
      key: 'edit', label: tc('actions.edit'), icon: <Pencil size={14} />,
      onClick: () => setEditRow(row),
    },
    canEdit && {
      key: 'delete', label: tc('actions.delete'), icon: <Trash2 size={14} />,
      danger: true, onClick: () => setDeleteRow(row),
    },
  ].filter(Boolean), [resource, canPublish, canEdit, togglePublish, t, tc]);

  const columns = useMemo(() => {
    if (!resource) return [];
    return [
      ...resource.columns,
      ...(resource.hasPublish ? [
        {
          key: 'is_enabled', header: tc('state.enabled'), minWidth: 110,
          render: (row) => (
            <StatusBadge tone={row.is_enabled ? 'success' : 'muted'}
              label={row.is_enabled ? tc('state.on') : tc('state.off')} />
          ),
        },
        {
          key: 'is_published', header: tc('labels.status'), minWidth: 120,
          render: (row) => (
            <StatusBadge tone={row.is_published ? 'success' : 'warning'}
              label={row.is_published ? t('published') : tc('state.draft')} />
          ),
        },
        { key: 'display_order', header: t('order'), minWidth: 90, sortKey: 'display_order' },
      ] : []),
    ];
  }, [resource, t, tc]);

  async function doDelete() {
    if (!deleteRow) return;
    setBusy(true);
    try {
      await api.remove(deleteRow.id);
      toast.success(t('cms.deleted', { item: resource.singular }));
      setDeleteRow(null);
      reload();
    } catch (error) {
      toast.error(apiErrorMessage(error, t('unableDeletePleaseTryAgain')));
    } finally { setBusy(false); }
  }

  if (!resource) {
    return <div className="muted" style={{ padding: 24 }}>{t('unknownWebsiteSection')}</div>;
  }

  return (
    <ListPage
      title={resource.title}
      subtitle={t('manageContentShownCustomerWebsite')}
      actions={canEdit && (
        <button className="btn btn-primary" onClick={() => setEditRow({})}>
          <Plus size={15} /> {t('cms.newItem', { item: resource.singular.toLowerCase() })}
        </button>
      )}
    >
      <ListView
        tableKey={`cms:${resourceKey}`}
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="display_order"
        searchPlaceholder={t('cms.searchPlaceholder', { items: resource.title.toLowerCase() })}
        emptyTitle={t('cms.emptyTitle', { items: resource.title.toLowerCase() })}
        emptyHint={canEdit
          ? t('cms.emptyHint', { item: resource.singular.toLowerCase() })
          : t('cms.emptyHintReadOnly')}
        onRowClick={canEdit ? (row) => setEditRow(row) : undefined}
        columns={columns}
        rowActions={rowActions}
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
        message={deleteRow ? t('cms.deleteBody') : ''}
        confirmLabel={tc('actions.delete')}
        busy={busy}
        onConfirm={doDelete}
        onClose={() => { if (!busy) setDeleteRow(null); }}
      />
    </ListPage>
  );
}
