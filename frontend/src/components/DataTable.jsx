import { ListTable } from './listview/ListTable.jsx';
import { useTranslation } from 'react-i18next';
import { Pagination } from './listview/Pagination.jsx';

/**
 * A simple table: columns and rows, with optional sorting and paging.
 *
 * This is a thin wrapper over `ListTable`, the one table implementation in the
 * admin. It stays for the small embedded tables that sit inside a detail page
 * and need no search, filters or grouping. A full listing PAGE should use
 * `ListView`, which adds the toolbar and query handling around the same core
 * rather than reimplementing any of it.
 *
 * Props:
 *   columns: [{ key, header, render?, width?, align?, truncate?, nowrap?,
 *               sortKey?, sticky? }]
 *   rows, loading, emptyTitle, emptyHint, onRowClick
 *   ordering + onSort(nextOrdering)      - two-state sort toggle
 *   page, pageSize, count, onPageChange  - pass all four to show the footer
 */
export function DataTable({
  columns,
  rows = [],
  loading = false,
  emptyTitle,
  emptyHint,
  onRowClick,
  ordering,
  onSort,
  page,
  pageSize = 20,
  count,
  onPageChange,
}) {
  const { t } = useTranslation('table');
  // ListTable asks for a direction per column plus a toggle; this maps the
  // older `ordering` string API onto it so existing callers are unaffected.
  const sortDirection = (key) => (
    ordering === key ? 'asc' : ordering === `-${key}` ? 'desc' : null
  );
  const toggleSort = onSort
    ? (key) => onSort(sortDirection(key) === 'asc' ? `-${key}` : key)
    : undefined;

  return (
    <ListTable
      columns={columns}
      rows={rows}
      loading={loading}
      emptyTitle={emptyTitle || t('table:emptyTitle')}
      emptyHint={emptyHint || t('table:emptyHint')}
      onRowClick={onRowClick}
      sortDirection={onSort ? sortDirection : undefined}
      onToggleSort={toggleSort}
      page={page}
      pageSize={pageSize}
      count={count}
      onPageChange={onPageChange}
    />
  );
}

export { Pagination };
