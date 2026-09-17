import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ListTable } from './ListTable.jsx';
import { ListToolbar } from './ListToolbar.jsx';
import { PAGE_SIZE_OPTIONS } from './Pagination.jsx';
import { toApiParams, useListQuery } from './useListQuery.js';
import { useTablePrefs } from './useTablePrefs.js';
import './listview.css';

/**
 * The standard listing page: toolbar, table, paging, selection and bulk
 * actions, over one backend query contract.
 *
 * A page supplies WHAT to list; this supplies how a list behaves. Everything a
 * listing needs in common - search, filtering, sorting, grouping, column
 * layout, selection, empty and error states - lives here once, so a new listing
 * is a configuration rather than another table.
 *
 *   <ListView
 *     tableKey="bookings"                        persistence + URL namespace
 *     fetcher={(params) => bookingsApi.list(params)}
 *     columns={[...]}                            see ListTable for the shape
 *     filters={[{key, label, type, options}]}
 *     groupOptions={[{key, label}]}
 *     defaultOrdering="-created_at"
 *     onRowClick={(row) => ...}
 *     rowActions={(row) => [{key, label, icon, onClick, danger, disabled}]}
 *     bulkActions={[{key, label, icon, danger, run(ids, rows)}]}
 *   />
 *
 * Permissions stay the page's business: it decides which actions to hand over,
 * and the backend enforces them regardless. Nothing here grants access.
 */
export function ListView({
  tableKey,
  fetcher,
  columns: columnDefs,

  filters = [],
  groupOptions = [],
  defaultOrdering = null,
  defaultFilters = {},
  // Parameters sent on every request regardless of the user's filters: a
  // listing's baseline scope, e.g. hiding soft-deleted rows.
  baseParams = {},
  defaultPageSize = 25,
  syncUrl = true,

  searchPlaceholder,
  emptyTitle,
  emptyHint,
  emptyAction,

  onRowClick,
  rowActions,
  bulkActions = [],
  rowKey = (row) => row.id,

  toolbarRight,
  reloadKey = 0,

  /**
   * Render something other than the table from the SAME toolbar, query and
   * fetch: a card grid, a calendar. Alternative views of one list share its
   * search and filters rather than growing a second copy of them.
   * Receives { rows, loading, error, count, page, pageSize, query, reload }.
   */
  renderBody,
}) {
  const { t } = useTranslation('table');
  const prefs = useTablePrefs(tableKey, columnDefs, { defaultPageSize });
  const query = useListQuery({ tableKey, filters, defaultOrdering, defaultFilters, syncUrl });

  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [retry, setRetry] = useState(0);

  // Grouping: headers first, then a group's rows only when it is expanded.
  const [groups, setGroups] = useState(null);
  const [expanded, setExpanded] = useState([]);
  const [groupRows, setGroupRows] = useState({});

  const params = useMemo(
    () => toApiParams(query, { pageSize: prefs.pageSize, filters, always: baseParams }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.search, query.ordering, query.page, JSON.stringify(query.filters),
      prefs.pageSize, JSON.stringify(baseParams)],
  );

  // One in-flight request wins: a slow early response must not overwrite the
  // results of a newer, narrower query.
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    const request = query.groupBy
      ? fetcher({ ...params, page: undefined, group_by: query.groupBy })
      : fetcher(params);

    request
      .then((data) => {
        if (id !== requestId.current) return;
        if (query.groupBy) {
          setGroups({ list: data.groups || [], filterParam: data.filter_param });
          setRows([]);
          setCount((data.groups || []).reduce((sum, g) => sum + g.count, 0));
        } else {
          setGroups(null);
          setRows(Array.isArray(data) ? data : data.results || []);
          setCount(Array.isArray(data) ? data.length : data.count || 0);
        }
      })
      .catch((e) => {
        if (id !== requestId.current) return;
        setError(e?.response?.data?.detail || e?.message || true);
        setRows([]);
        setGroups(null);
      })
      .finally(() => { if (id === requestId.current) setLoading(false); });
  }, [params, query.groupBy, fetcher, retry, reloadKey]);   // eslint-disable-line

  // Changing what is listed invalidates any selection made against the old set.
  useEffect(() => { setSelectedIds([]); }, [params, query.groupBy]);
  useEffect(() => { setExpanded([]); setGroupRows({}); }, [query.groupBy]);

  const toggleGroup = useCallback((key) => {
    setExpanded((prev) => (prev.includes(key)
      ? prev.filter((k) => k !== key)
      : [...prev, key]));

    if (groupRows[key] || !groups) return;
    setGroupRows((prev) => ({ ...prev, [key]: { loading: true, rows: [] } }));
    fetcher({
      ...params,
      page: 1,
      page_size: 100,                       // one group's rows, still bounded
      [groups.filterParam]: key,
    })
      .then((data) => setGroupRows((prev) => ({
        ...prev, [key]: { loading: false, rows: data.results || data || [] },
      })))
      .catch(() => setGroupRows((prev) => ({
        ...prev, [key]: { loading: false, rows: [] },
      })));
  }, [groups, groupRows, params, fetcher]);

  const groupsForTable = useMemo(() => (groups ? groups.list.map((g) => ({
    ...g,
    rows: groupRows[String(g.key)]?.rows || [],
    loading: groupRows[String(g.key)]?.loading || false,
  })) : null), [groups, groupRows]);

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.includes(rowKey(r))),
    [rows, selectedIds, rowKey],
  );

  const resetView = () => { query.reset(); prefs.reset(); };

  return (
    // The flex column that lets the table claim the height a workspace leaves
    // it. Outside a ListPage it is an ordinary block and changes nothing.
    <div className="lv">
      <ListToolbar
        searchPlaceholder={searchPlaceholder || t('search')}
        searchValue={query.searchDraft}
        onSearchChange={query.setSearchDraft}
        filters={filters}
        activeFilters={query.filters}
        onFilterChange={query.setFilter}
        onClearFilters={query.clearFilters}
        groupOptions={groupOptions}
        groupBy={query.groupBy}
        onGroupBy={query.setGroupBy}
        allColumns={prefs.allColumns}
        hiddenColumns={prefs.hidden}
        onToggleColumn={prefs.toggleColumn}
        onResetView={resetView}
        canResetView={query.hasActiveView || prefs.isCustomised}
        right={toolbarRight}
      />

      {bulkActions.length > 0 && selectedIds.length > 0 && (
        <div className="lv-bulk">
          <span className="lv-bulk__count">
            {t('selected', { count: selectedIds.length })}
          </span>
          {bulkActions.map((action) => (
            <button
              key={action.key}
              type="button"
              className={`btn ${action.danger ? 'btn-danger' : 'btn-secondary'} lv-bulk__btn`}
              disabled={action.disabled?.(selectedRows)}
              onClick={() => action.run(selectedIds, selectedRows)}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
          <button
            type="button" className="lv-bulk__clear"
            onClick={() => setSelectedIds([])}
          >
            <X size={13} /> {t('clearSelection')}
          </button>
        </div>
      )}

      {renderBody ? renderBody({
        rows,
        loading,
        error,
        count,
        page: query.page,
        pageSize: prefs.pageSize,
        setPage: query.setPage,
        setPageSize: prefs.setPageSize,
        query,
        reload: () => setRetry((n) => n + 1),
      }) : (
      <ListTable
        columns={prefs.columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={() => setRetry((n) => n + 1)}
        sortDirection={query.sortDirection}
        onToggleSort={query.toggleSort}
        selectable={bulkActions.length > 0}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        onRowClick={onRowClick}
        rowActions={rowActions}
        rowKey={rowKey}
        groups={groupsForTable}
        expandedGroups={expanded}
        onToggleGroup={toggleGroup}
        onColumnResize={prefs.setWidth}
        onColumnReorder={prefs.setOrder}
        emptyTitle={emptyTitle}
        emptyHint={emptyHint}
        emptyAction={emptyAction}
        isFiltered={Boolean(query.search || query.activeFilterCount)}
        page={query.page}
        pageSize={prefs.pageSize}
        count={count}
        onPageChange={query.setPage}
        onPageSizeChange={prefs.setPageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
      />
      )}
    </div>
  );
}
