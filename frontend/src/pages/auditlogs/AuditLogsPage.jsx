import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { formatDateTime } from '../../services/timeformat.jsx';

import { auditMethods, auditApi } from '../../services/auditService.js';

const methodTone = (m) => ({ POST: 'success', PATCH: 'info', PUT: 'info', DELETE: 'danger' }[m] || 'muted');

const GROUP_KEYS = [
  ['method', 'groups.method'],
  ['status_code', 'groups.statusCode'],
  ['actor', 'groups.actor'],
];

export default function AuditLogsPage() {
  const [searchParams] = useSearchParams();
  const fetcher = useCallback((q) => auditApi.list(q), []);

  // Deep links such as "View audit logs" from Active Sessions arrive with
  // ?search=, which ListView reads straight from the URL.
  const deepLinked = Boolean(searchParams.get('search'));
  const { t } = useTranslation('auditlogs');


  const columns = useMemo(() => [
    { key: 'when', header: t('columns.when'), sortKey: 'created_at', nowrap: true,
      minWidth: 170, alwaysVisible: true,
      render: (r) => formatDateTime(r.created_at) },
    { key: 'actor', header: t('columns.actor'), sortKey: 'actor__email', minWidth: 180,
      truncate: true,
      render: (r) => (
        <div>
          {r.actor_name || t('anonymous')}
          <div className="muted" style={{ fontSize: 12 }}>{r.actor_email || '-'}</div>
        </div>
      ) },
    { key: 'method', header: t('columns.method'), sortKey: 'method', minWidth: 90,
      render: (r) => <StatusBadge tone={methodTone(r.method)} label={r.method} /> },
    { key: 'path', header: t('columns.path'), minWidth: 220, truncate: true,
      render: (r) => <code style={{ fontSize: 12 }}>{r.path}</code> },
    { key: 'event', header: t('columns.event'), minWidth: 150, truncate: true,
      render: (r) => r.event || <span className="muted">-</span> },
    { key: 'status', header: t('columns.status'), sortKey: 'status_code', minWidth: 90,
      priority: 'medium',
      render: (r) => (
        <StatusBadge tone={r.status_code < 400 ? 'success' : 'danger'}
          label={String(r.status_code)} />
      ) },
  ], [t]);

  const groupOptions = useMemo(
    () => GROUP_KEYS.map(([key, labelKey]) => ({ key, label: t(labelKey) })), [t]);

  const filters = useMemo(() => [
    { key: 'method', label: t('filters.method'), type: 'select', options: auditMethods(t) },
  ], [t]);

  return (
    <ListPage
      title={t('title')}
      subtitle={t('subtitle')}
    >
      <ListView
        tableKey="audit-logs"
        fetcher={fetcher}
        defaultOrdering="-created_at"
        searchPlaceholder={t('searchPlaceholder')}
        emptyTitle={deepLinked ? t('emptySearchTitle') : t('emptyTitle')}
        emptyHint={t('emptyHint')}
        columns={columns}
        filters={filters}
        groupOptions={groupOptions}
      />
    </ListPage>
  );
}
