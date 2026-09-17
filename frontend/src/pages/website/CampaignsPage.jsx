import { useCallback, useMemo, useState } from 'react';
import { Eye, EyeOff, Pencil, Plus, Archive, BarChart3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { formatDateTime } from '../../services/timeformat.jsx';
import {
  websiteApi, campaignTypes, campaignPlacements,
} from '../../services/websiteService.js';
import { apiErrorMessage } from '../../utils/apiError.js';
import { CampaignFormModal } from './CampaignFormModal.jsx';

/**
 * Website campaigns: the promotional cards shown on the customer site.
 *
 * A listing like any other, on the shared table framework. The only thing worth
 * noting is the status column: it is derived from the dates and the enabled and
 * published flags, so it can never contradict them. Nothing here decides when a
 * campaign shows; the backend does, and this reports its answer.
 */

const TONE = {
  active: 'success',
  scheduled: 'info',
  draft: 'muted',
  expired: 'muted',
  disabled: 'warning',
};

export default function CampaignsPage() {
  const { t } = useTranslation('website');
  const { hasPerm } = useAuth();
  const canEdit = hasPerm('website.edit');
  const canPublish = hasPerm('website.publish');

  const [editRow, setEditRow] = useState(null);      // record, or {} for a new one
  const [archiveRow, setArchiveRow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const fetcher = useCallback((params) => websiteApi.campaigns.list(params), []);

  async function togglePublish(row) {
    try {
      await websiteApi.campaigns.setPublished(row.id, !row.is_published);
      toast.success(row.is_published ? t('unpublished') : t('publishedLiveClub'));
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUpdatePublishStatePlease')));
    }
  }

  /**
   * Archiving rather than deleting. A campaign that has run holds the only
   * record of how it performed, and a promotion nobody can look back on is
   * worth less than the space it saves.
   */
  async function archive() {
    if (!archiveRow) return;
    setBusy(true);
    try {
      await websiteApi.campaigns.update(archiveRow.id, { is_archived: true });
      toast.success(t('campaigns.archived'));
      setArchiveRow(null);
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('campaigns.archiveFailed')));
    } finally { setBusy(false); }
  }

  const columns = useMemo(() => [
    {
      key: 'name',
      header: t('campaigns.campaign'),
      sortable: true,
      render: (r) => (
        <div>
          <strong>{r.name}</strong>
          {r.title && <div className="muted" style={{ fontSize: 12 }}>{r.title}</div>}
        </div>
      ),
    },
    { key: 'type_display', header: t('campaigns.type'), render: (r) => r.type_display },
    { key: 'scope_label', header: t('campaigns.scope'), priority: 'medium',
      render: (r) => r.scope_label },
    { key: 'placement_display', header: t('campaigns.placement.label'), priority: 'medium',
      render: (r) => r.placement_display },
    { key: 'starts_at', header: t('campaigns.starts'), sortable: true,
      render: (r) => formatDateTime(r.starts_at) },
    { key: 'ends_at', header: t('campaigns.ends'), sortable: true,
      render: (r) => formatDateTime(r.ends_at) },
    {
      key: 'status',
      header: t('common:labels.status'),
      render: (r) => (
        <StatusBadge tone={TONE[r.status] || 'muted'}
          label={t(`campaigns.status.${r.status}`, r.status)} />
      ),
    },
    { key: 'priority', header: t('campaigns.priority.label'), sortable: true, priority: 'low',
      render: (r) => r.priority },
    { key: 'frequency_display', header: t('campaigns.frequency.label'), priority: 'low',
      render: (r) => r.frequency_display },
    {
      key: 'promo_code_label',
      header: t('campaigns.linkedOffer'),
      priority: 'low',
      render: (r) => r.promo_code_label || r.holiday_label || '-',
    },
    {
      key: 'engagement',
      header: t('campaigns.engagement'),
      priority: 'low',
      render: (r) => (
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          <BarChart3 size={12} /> {r.impressions} / {r.cta_clicks}
        </span>
      ),
    },
  ], [t]);

  const filters = useMemo(() => [
    { key: 'campaign_type', label: t('campaigns.type'), type: 'select',
      options: campaignTypes(t) },
    { key: 'placement', label: t('campaigns.placement.label'), type: 'select',
      options: campaignPlacements(t) },
    { key: 'is_enabled', label: t('common:state.enabled'), type: 'select',
      options: [{ value: 'true', label: t('common:state.enabled') },
        { value: 'false', label: t('common:state.disabled') }] },
    { key: 'is_published', label: t('common:labels.status'), type: 'select',
      options: [{ value: 'true', label: t('published') },
        { value: 'false', label: t('common:state.draft') }] },
    { key: 'is_archived', label: t('campaigns.archivedFilter'), type: 'select',
      options: [{ value: 'true', label: t('campaigns.archivedOnly') }] },
  ], [t]);

  const rowActions = useCallback((row) => [
    canPublish && {
      key: 'publish',
      label: row.is_published ? t('unpublish') : t('publish'),
      icon: row.is_published ? <EyeOff size={14} /> : <Eye size={14} />,
      onClick: () => togglePublish(row),
    },
    canEdit && {
      key: 'edit', label: t('common:actions.edit'), icon: <Pencil size={14} />,
      onClick: () => setEditRow(row),
    },
    canEdit && !row.is_archived && {
      key: 'archive', label: t('campaigns.archive'), icon: <Archive size={14} />,
      danger: true, onClick: () => setArchiveRow(row),
    },
  ].filter(Boolean), [canEdit, canPublish, t]);   // eslint-disable-line

  return (
    <ListPage
      title={t('campaigns.title')}
      subtitle={t('campaigns.subtitle')}
      actions={canEdit && (
        <button className="btn btn-primary" onClick={() => setEditRow({})}>
          <Plus size={15} /> {t('campaigns.newCampaign')}
        </button>
      )}
    >
      <ListView
        tableKey="website-campaigns"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="-starts_at"
        searchPlaceholder={t('campaigns.searchPlaceholder')}
        emptyTitle={t('campaigns.emptyTitle')}
        emptyHint={t('campaigns.emptyHint')}
        columns={columns}
        filters={filters}
        groupOptions={[
          { key: 'campaign_type', label: t('campaigns.type') },
          { key: 'placement', label: t('campaigns.placement.label') },
        ]}
        rowActions={canEdit || canPublish ? rowActions : undefined}
        onRowClick={canEdit ? setEditRow : undefined}
      />

      <CampaignFormModal
        open={Boolean(editRow)}
        record={editRow}
        onClose={() => setEditRow(null)}
        onSaved={() => { setEditRow(null); refresh(); }}
      />

      <ConfirmDialog
        open={Boolean(archiveRow)}
        tone="danger"
        busy={busy}
        title={t('campaigns.archiveTitle')}
        confirmLabel={t('campaigns.archive')}
        cancelLabel={t('common:actions.cancel')}
        message={archiveRow ? t('campaigns.archiveBody', { name: archiveRow.name }) : null}
        onConfirm={archive}
        onClose={() => setArchiveRow(null)}
      />
    </ListPage>
  );
}
