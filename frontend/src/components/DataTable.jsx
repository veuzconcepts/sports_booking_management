import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

/**
 * Shared enterprise listing table - the single table used across the admin.
 *
 * Props:
 *   columns: [{ key, header, render?, width?, align?, truncate?, nowrap?, sortKey?, sticky? }]
 *      - align:    'left' | 'center' | 'right'
 *      - truncate: clamp long text to one line with an ellipsis (respects width)
 *      - nowrap:   keep on one line without truncating
 *      - sortKey:  backend ordering field; makes the header a clickable sort toggle
 *      - sticky:   'right' | 'left' - freeze the column while the table scrolls horizontally
 *   rows:    array of objects
 *   loading: bool
 *   emptyTitle, emptyHint: strings shown when rows is empty
 *   onRowClick: fn(row)
 *
 *   Sorting (optional): pass `ordering` (e.g. "-created_at") and `onSort(nextOrdering)`.
 *
 *   Pagination (optional - pass all four to enable the footer):
 *   page:        current 1-based page
 *   pageSize:    rows per page (default 20, matches the API)
 *   count:       total record count
 *   onPageChange(nextPage)
 */
export function DataTable({
  columns,
  rows = [],
  loading = false,
  emptyTitle = 'Nothing here yet',
  emptyHint = 'Records will appear here once they are created.',
  onRowClick,
  ordering,
  onSort,
  page,
  pageSize = 20,
  count,
  onPageChange,
}) {
  if (loading) {
    return (
      <div className="card">
        <div className="table-state center"><span className="muted">Loading…</span></div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="card">
        <div className="empty">
          <h3>{emptyTitle}</h3>
          <p>{emptyHint}</p>
        </div>
      </div>
    );
  }

  const cellAlign = (a) => (a && a !== 'left' ? { textAlign: a } : undefined);
  const cellClass = (c) =>
    [c.truncate ? 'cell-truncate' : '', c.nowrap ? 'cell-nowrap' : '',
      c.sticky === 'right' ? 'col-sticky-right' : '', c.sticky === 'left' ? 'col-sticky-left' : '']
      .filter(Boolean).join(' ') || undefined;

  const sortDir = (key) => (ordering === key ? 'asc' : ordering === `-${key}` ? 'desc' : null);
  const toggleSort = (key) => {
    if (!onSort) return;
    onSort(sortDir(key) === 'asc' ? `-${key}` : key);
  };

  return (
    <div className="card">
      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => {
                const sortable = c.sortKey && onSort;
                const dir = sortable ? sortDir(c.sortKey) : null;
                return (
                  <th
                    key={c.key}
                    className={cellClass(c)}
                    style={{ ...(c.width ? { width: c.width } : {}), ...cellAlign(c.align),
                      ...(sortable ? { cursor: 'pointer', userSelect: 'none' } : {}) }}
                    onClick={sortable ? () => toggleSort(c.sortKey) : undefined}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {c.header}
                      {sortable && (dir === 'asc' ? <ChevronUp size={13} />
                        : dir === 'desc' ? <ChevronDown size={13} />
                        : <ChevronsUpDown size={13} style={{ opacity: 0.4 }} />)}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr
                key={row.id ?? idx}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? 'is-clickable' : undefined}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cellClass(c)}
                    style={{ ...(c.width ? { maxWidth: c.width } : {}), ...cellAlign(c.align) }}
                  >
                    {c.render ? c.render(row) : row[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageSize={pageSize} count={count} onPageChange={onPageChange} rowsShown={rows.length} />
    </div>
  );
}

/** The table's own pager, exported so non-table views (the booking card
  * grid) page with exactly the same control rather than a lookalike. */
export function Pagination({ page, pageSize = 20, count, onPageChange, rowsShown }) {
  if (count == null || !onPageChange) return null;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const current = Math.min(Math.max(1, page || 1), totalPages);
  const start = count === 0 ? 0 : (current - 1) * pageSize + 1;
  const end = Math.min(current * pageSize, count) || rowsShown;

  return (
    <div className="table-foot">
      <span className="table-foot-info">
        <strong>{start}-{end}</strong> of {count}
      </span>
      {totalPages > 1 && (
        <div className="pagination">
          <button
            type="button" className="page-btn"
            disabled={current <= 1} onClick={() => onPageChange(current - 1)} aria-label="Previous page"
          >
            <ChevronLeft size={16} />
          </button>
          {pageWindow(current, totalPages).map((p, i) =>
            p === '…' ? (
              <span key={`gap-${i}`} className="page-gap">…</span>
            ) : (
              <button
                key={p} type="button"
                className={`page-btn${p === current ? ' is-current' : ''}`}
                onClick={() => onPageChange(p)}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button" className="page-btn"
            disabled={current >= totalPages} onClick={() => onPageChange(current + 1)} aria-label="Next page"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Build a compact page list with ellipses, e.g. [1, '…', 4, 5, 6, '…', 12]. */
function pageWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}
