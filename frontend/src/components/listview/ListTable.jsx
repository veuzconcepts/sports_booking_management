import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle, ChevronDown, ChevronRight, ChevronsUpDown, ChevronUp, MoreVertical,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePopover } from '../usePopover.js';

import { Pagination } from './Pagination.jsx';

/**
 * The rendering core of every list in the admin: header, rows, selection,
 * column resize and reorder, grouping, and the loading / empty / error states.
 *
 * It renders what it is given and reports what the user did. It holds no query
 * state and fetches nothing, so the same component serves a full listing page
 * (through `ListView`) and a small embedded table (through `DataTable`) without
 * either growing its own copy of this behaviour.
 *
 * Columns:
 *   key, header, render(row), width, minWidth, align, truncate, nowrap,
 *   sortKey, sticky, resizable, hideable, alwaysVisible, priority
 *
 * `priority` drives the responsive rules: 'low' columns drop out on tablet and
 * below, so a narrow screen shows the columns that identify a record rather
 * than a squeezed version of all of them.
 */
const MIN_WIDTH = 64;
const MAX_WIDTH = 720;

function sortIcon(direction) {
  if (direction === 'asc') return <ChevronUp size={13} />;
  if (direction === 'desc') return <ChevronDown size={13} />;
  return <ChevronsUpDown size={13} className="lt-sort-idle" />;
}

export function ListTable({
  columns,
  rows: rowsProp = [],
  loading = false,
  error = null,
  onRetry,

  // Sorting
  sortDirection,
  onToggleSort,

  // Selection
  selectable = false,
  selectedIds = [],
  onSelectionChange,

  // Row behaviour
  onRowClick,
  rowActions,
  rowKey = (row) => row.id,

  // Grouping
  groups = null,              // [{key, label, count, rows?, loading?}]
  expandedGroups = [],
  onToggleGroup,

  // Column layout
  onColumnResize,
  onColumnReorder,

  // States
  emptyTitle,
  emptyHint,
  emptyAction = null,
  isFiltered = false,

  // Pagination
  page,
  pageSize = 25,
  count,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions,
}) {
  // A caller may hand straight through an API payload; a non-list is an
  // empty table, never a crash.
  const rows = Array.isArray(rowsProp) ? rowsProp : [];
  const { t } = useTranslation('table');
  const selected = new Set(selectedIds);
  const visibleIds = rows.map(rowKey);
  const allOnPageSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someOnPageSelected = visibleIds.some((id) => selected.has(id));

  const toggleAllOnPage = () => {
    if (!onSelectionChange) return;
    onSelectionChange(allOnPageSelected
      ? selectedIds.filter((id) => !visibleIds.includes(id))
      : [...new Set([...selectedIds, ...visibleIds])]);
  };

  const toggleRow = (id) => {
    if (!onSelectionChange) return;
    onSelectionChange(selected.has(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id]);
  };

  // ------------------------------------------------------------- resizing --
  const resizing = useRef(null);
  const startResize = useCallback((event, column) => {
    event.preventDefault();
    event.stopPropagation();
    const th = event.currentTarget.closest('th');
    resizing.current = { key: column.key, startX: event.clientX, startWidth: th.offsetWidth };
    document.body.classList.add('lt-resizing');
  }, []);

  useEffect(() => {
    const onMove = (event) => {
      const state = resizing.current;
      if (!state) return;
      const next = Math.min(MAX_WIDTH,
        Math.max(MIN_WIDTH, state.startWidth + (event.clientX - state.startX)));
      const cells = document.querySelectorAll(`[data-col="${state.key}"]`);
      cells.forEach((cell) => { cell.style.width = `${next}px`; });
      state.width = next;
    };
    const onUp = () => {
      const state = resizing.current;
      resizing.current = null;
      document.body.classList.remove('lt-resizing');
      if (state?.width && onColumnResize) onColumnResize(state.key, state.width);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onColumnResize]);

  // ------------------------------------------------------------ reordering --
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);

  const dropColumn = (targetKey) => {
    if (!onColumnReorder || !dragKey || dragKey === targetKey) return;
    const keys = columns.map((c) => c.key);
    const from = keys.indexOf(dragKey);
    const to = keys.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    keys.splice(to, 0, keys.splice(from, 1)[0]);
    onColumnReorder(keys);
    setDragKey(null);
    setOverKey(null);
  };

  // ---------------------------------------------------------------- states --
  const colSpan = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  if (error) {
    return (
      <div className="lv-surface">
        <div className="lt-state">
          <AlertCircle size={22} className="lt-state__icon lt-state__icon--error" />
          <h3>{t('errorTitle')}</h3>
          <p>{typeof error === 'string' ? error : t('errorHint')}</p>
          {onRetry && (
            <button type="button" className="btn btn-secondary" onClick={onRetry}>
              {t('retry')}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (loading && !rows.length && !groups) {
    return (
      <div className="lv-surface">
        <table className="table lt" aria-busy="true">
          <thead><Header
            columns={columns} selectable={selectable} rowActions={rowActions}
            sortDirection={sortDirection} onToggleSort={onToggleSort}
          /></thead>
          <tbody>
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="lt-skeleton-row">
                {Array.from({ length: colSpan }).map((__, j) => (
                  <td key={j}><span className="lt-skeleton" /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const nothing = !groups && !rows.length;
  if (nothing) {
    return (
      <div className="lv-surface">
        <div className="lt-state">
          <h3>{isFiltered ? t('noResultsTitle') : (emptyTitle || t('emptyTitle'))}</h3>
          <p>{isFiltered ? t('noResultsHint') : (emptyHint || t('emptyHint'))}</p>
          {!isFiltered && emptyAction}
        </div>
      </div>
    );
  }

  const headerNode = (
    <Header
      columns={columns}
      selectable={selectable}
      rowActions={rowActions}
      sortDirection={sortDirection}
      onToggleSort={onToggleSort}
      allSelected={allOnPageSelected}
      someSelected={someOnPageSelected && !allOnPageSelected}
      onToggleAll={toggleAllOnPage}
      onStartResize={startResize}
      dragKey={dragKey}
      overKey={overKey}
      setDragKey={setDragKey}
      setOverKey={setOverKey}
      onDropColumn={dropColumn}
      reorderable={Boolean(onColumnReorder)}
    />
  );

  const renderRows = (list) => list.map((row) => {
    const id = rowKey(row);
    const isSelected = selected.has(id);
    return (
      <tr
        key={id}
        className={`${onRowClick ? 'is-clickable' : ''}${isSelected ? ' is-selected' : ''}`}
        onClick={onRowClick ? () => onRowClick(row) : undefined}
      >
        {selectable && (
          // `stopPropagation` so ticking a row never also opens it.
          <td className="lt-select" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox" checked={isSelected}
              aria-label={t('selectRow', { id })}
              onChange={() => toggleRow(id)}
            />
          </td>
        )}
        {columns.map((c) => (
          <td
            key={c.key}
            data-col={c.key}
            className={cellClass(c)}
            style={cellStyle(c)}
            title={c.truncate && typeof row[c.key] === 'string' ? row[c.key] : undefined}
          >
            {c.render ? c.render(row) : row[c.key]}
          </td>
        ))}
        {rowActions && (
          <td className="lt-actions col-sticky-right" onClick={(e) => e.stopPropagation()}>
            <RowMenu actions={rowActions(row)} />
          </td>
        )}
      </tr>
    );
  });

  return (
    <div className="lv-surface">
      <div className="table-wrapper lt-wrapper">
        <table className="table lt">
          <thead>{headerNode}</thead>

          {groups ? groups.map((group) => {
            const open = expandedGroups.includes(String(group.key));
            return (
              <tbody key={String(group.key)} className="lt-group">
                <tr className="lt-group__head" onClick={() => onToggleGroup(String(group.key))}>
                  <td colSpan={colSpan}>
                    <span className="lt-group__toggle">
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <strong>{group.label}</strong>
                      <span className="lt-group__count">({group.count})</span>
                    </span>
                  </td>
                </tr>
                {open && group.loading && (
                  <tr><td colSpan={colSpan} className="lt-group__loading">{t('loading')}</td></tr>
                )}
                {open && !group.loading && renderRows(group.rows || [])}
              </tbody>
            );
          }) : (
            <tbody>{renderRows(rows)}</tbody>
          )}
        </table>
      </div>

      {!groups && (
        <Pagination
          page={page} pageSize={pageSize} count={count}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          pageSizeOptions={pageSizeOptions}
          rowsShown={rows.length}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- header --- */
function Header({
  columns, selectable, rowActions, sortDirection, onToggleSort,
  allSelected, someSelected, onToggleAll, onStartResize,
  dragKey, overKey, setDragKey, setOverKey, onDropColumn, reorderable,
}) {
  const { t } = useTranslation('table');
  return (
    <tr>
      {selectable && (
        <th className="lt-select">
          <input
            type="checkbox"
            checked={Boolean(allSelected)}
            ref={(el) => { if (el) el.indeterminate = Boolean(someSelected); }}
            aria-label={t('selectAllOnPage')}
            // The skeleton header renders before there is anything to select,
            // so it is read-only rather than a control with no handler.
            readOnly={!onToggleAll}
            onChange={onToggleAll || undefined}
          />
        </th>
      )}

      {columns.map((c) => {
        const sortable = Boolean(c.sortKey && onToggleSort);
        const direction = sortable ? sortDirection?.(c.sortKey) : null;
        const canDrag = reorderable && c.reorderable !== false;
        return (
          <th
            key={c.key}
            data-col={c.key}
            className={`${cellClass(c)}${overKey === c.key ? ' lt-col-over' : ''}`
              + `${dragKey === c.key ? ' lt-col-dragging' : ''}`}
            style={cellStyle(c)}
            aria-sort={direction === 'asc' ? 'ascending'
              : direction === 'desc' ? 'descending' : 'none'}
            draggable={canDrag}
            onDragStart={canDrag ? () => setDragKey(c.key) : undefined}
            onDragEnd={canDrag ? () => { setDragKey(null); setOverKey(null); } : undefined}
            onDragOver={canDrag ? (e) => { e.preventDefault(); setOverKey(c.key); } : undefined}
            onDrop={canDrag ? () => onDropColumn(c.key) : undefined}
          >
            {sortable ? (
              <button
                type="button"
                className="lt-sort"
                onClick={() => onToggleSort(c.sortKey)}
                title={t('sortBy', { column: typeof c.header === 'string' ? c.header : c.key })}
              >
                {c.header}
                {sortIcon(direction)}
              </button>
            ) : (
              <span className="lt-head-label">{c.header}</span>
            )}

            {onStartResize && c.resizable !== false && (
              <span
                className="lt-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('resize', { column: typeof c.header === 'string' ? c.header : c.key })}
                onMouseDown={(e) => onStartResize(e, c)}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </th>
        );
      })}

      {rowActions && <th className="lt-actions col-sticky-right" aria-label={t('actionsColumn')} />}
    </tr>
  );
}

/* ------------------------------------------------------------ row menu ---- */
export function RowMenu({ actions }) {
  const { t } = useTranslation('table');
  const items = (actions || []).filter(Boolean);
  const { triggerRef, popRef, open, toggle, close, style } = usePopover({
    width: 176,
    estimatedHeight: items.length * 33 + 8,
  });

  if (!items.length) return null;

  return (
    <div className="lt-menu">
      <button
        ref={triggerRef}
        type="button" className="icon-btn"
        aria-label={t('rowActions')} aria-haspopup="menu" aria-expanded={open}
        onClick={toggle}
      >
        <MoreVertical size={15} />
      </button>
      {open && style && createPortal(
        <div
          ref={popRef}
          className="lt-menu__pop"
          role="menu"
          style={style}
          onClick={close}
        >
          {items.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              className={`lt-menu__item${action.danger ? ' lt-menu__item--danger' : ''}`}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ------------------------------------------------------------- helpers ---- */
function cellClass(c) {
  return [
    c.truncate ? 'cell-truncate' : '',
    c.nowrap ? 'cell-nowrap' : '',
    c.sticky === 'right' ? 'col-sticky-right' : '',
    c.sticky === 'left' ? 'col-sticky-left' : '',
    c.priority === 'low' ? 'lt-priority-low' : '',
    c.priority === 'medium' ? 'lt-priority-medium' : '',
  ].filter(Boolean).join(' ') || undefined;
}

function cellStyle(c) {
  const style = {};
  if (c.width) style.width = typeof c.width === 'number' ? `${c.width}px` : c.width;
  if (c.minWidth) style.minWidth = typeof c.minWidth === 'number' ? `${c.minWidth}px` : c.minWidth;
  if (c.align && c.align !== 'left') style.textAlign = c.align;
  return Object.keys(style).length ? style : undefined;
}
