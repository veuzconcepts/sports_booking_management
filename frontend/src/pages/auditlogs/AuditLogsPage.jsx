import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toolbar } from '../../components/Toolbar.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { formatDateTime } from '../../services/timeformat.jsx';

import { AUDIT_METHODS, auditApi } from '../../services/auditService.js';

const methodTone = (m) => ({ POST: 'success', PATCH: 'info', PUT: 'info', DELETE: 'danger' }[m] || 'muted');

export default function AuditLogsPage() {
  const [searchParams] = useSearchParams();
  const fetcher = useCallback((q) => auditApi.list(q), []);
  // Seed the search from ?search= so deep links (e.g. "View audit logs" from the
  // Active Sessions screen) land pre-filtered to that user.
  const initial = searchParams.get('search') ? { search: searchParams.get('search') } : undefined;
  const { rows, loading, count, query, setQuery } = useApiList(fetcher, initial);

  return (
    <>
      <PageHeader
        title="Audit Logs"
        subtitle="Immutable trail of every mutating request and sensitive domain event."
      />

      <Toolbar
        searchValue={query.search}
        onSearchChange={(v) => setQuery({ ...query, search: v || undefined, page: 1 })}
        searchPlaceholder="Path, actor email…"
        filters={[
          { value: query.method, options: AUDIT_METHODS, placeholder: 'All methods',
            onChange: (v) => setQuery({ ...query, method: v, page: 1 }) },
        ]}
      />

      <DataTable
        loading={loading}
        rows={rows}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        emptyTitle="No audit entries"
        emptyHint="Mutating API requests are recorded here automatically."
        columns={[
          { key: 'when', header: 'When', render: (r) => formatDateTime(r.created_at) },
          { key: 'actor', header: 'Actor', render: (r) => (
            <div>{r.actor_name || 'Anonymous'}<div className="muted" style={{ fontSize: 12 }}>{r.actor_email || '-'}</div></div>
          ) },
          { key: 'method', header: 'Method', render: (r) => <StatusBadge tone={methodTone(r.method)} label={r.method} /> },
          { key: 'path', header: 'Path', render: (r) => <code style={{ fontSize: 12 }}>{r.path}</code> },
          { key: 'event', header: 'Event', render: (r) => r.event || <span className="muted">-</span> },
          { key: 'status', header: 'Status', render: (r) => (
            <StatusBadge tone={r.status_code < 400 ? 'success' : 'danger'} label={String(r.status_code)} />
          ) },
        ]}
      />
    </>
  );
}
