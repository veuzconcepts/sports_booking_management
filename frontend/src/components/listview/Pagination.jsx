import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const PAGE_SIZE_OPTIONS = [25, 50, 100];

/**
 * The one pager used everywhere: the table, the booking card grid, and any
 * future list view. Shows the record window ("1-25 of 428"), optional page-size
 * control, and a compact numbered pager.
 *
 * Renders nothing without `count` and `onPageChange`, so an embedded table that
 * shows a complete short list simply omits them.
 */
export function Pagination({
  page, pageSize = 25, count, onPageChange, onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS, rowsShown,
}) {
  const { t } = useTranslation('table');
  if (count == null || !onPageChange) return null;

  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const current = Math.min(Math.max(1, page || 1), totalPages);
  const start = count === 0 ? 0 : (current - 1) * pageSize + 1;
  const end = Math.min(current * pageSize, count) || rowsShown;

  return (
    <div className="table-foot">
      <span className="table-foot-info">
        <strong>{start}-{end}</strong> {t('ofTotal', { total: count })}
      </span>

      {onPageSizeChange && (
        <label className="table-foot-size">
          <span className="muted">{t('rowsPerPage')}</span>
          <select
            className="lt-size-select"
            value={pageSize}
            aria-label={t('rowsPerPageAria')}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
      )}

      {totalPages > 1 && (
        <div className="pagination">
          <button
            type="button" className="page-btn" disabled={current <= 1}
            onClick={() => onPageChange(current - 1)} aria-label={t('previousPage')}
          >
            <ChevronLeft size={16} />
          </button>
          {pageWindow(current, totalPages).map((p, i) => (
            p === '…' ? (
              <span key={`gap-${i}`} className="page-gap">…</span>
            ) : (
              <button
                key={p} type="button"
                className={`page-btn${p === current ? ' is-current' : ''}`}
                aria-current={p === current ? 'page' : undefined}
                onClick={() => onPageChange(p)}
              >
                {p}
              </button>
            )
          ))}
          <button
            type="button" className="page-btn" disabled={current >= totalPages}
            onClick={() => onPageChange(current + 1)} aria-label={t('nextPage')}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A compact page list with ellipses, e.g. [1, '…', 4, 5, 6, '…', 12]. */
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
