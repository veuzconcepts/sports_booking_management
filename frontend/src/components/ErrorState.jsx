import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * Inline error state for a failed list/data request - distinct from the empty
 * state (which means "no records"). Reuses the shared `.card` / `.empty` shell
 * so spacing matches DataTable's loading/empty states.
 *
 * Props: title?, message?, onRetry?
 */
export function ErrorState({
  title = 'Couldn’t load this list',
  message = 'We were unable to load this data. Please try again.',
  onRetry,
}) {
  return (
    <div className="card">
      <div className="empty">
        <div
          style={{
            margin: '0 auto 12px', width: 40, height: 40, borderRadius: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--color-danger-50)', color: 'var(--color-danger-600)',
          }}
        >
          <AlertTriangle size={20} />
        </div>
        <h3>{title}</h3>
        <p>{message}</p>
        {onRetry && (
          <button className="btn btn-secondary btn-sm" type="button" onClick={onRetry}
                  style={{ marginTop: 4 }}>
            <RotateCcw size={14} /> Retry
          </button>
        )}
      </div>
    </div>
  );
}
