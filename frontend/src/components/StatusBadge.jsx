const TONES = {
  success: 'badge badge-success',
  warning: 'badge badge-warning',
  danger:  'badge badge-danger',
  info:    'badge badge-info',
  muted:   'badge badge-muted',
};

// Map common domain statuses to tones so consumers can just pass status.
const STATUS_TONE = {
  active:        'success',
  completed:     'success',
  closed:        'success',
  paid:          'success',
  covered:             'success',
  no_payment_required: 'muted',
  in_progress:   'info',
  confirmed:     'info',
  assigned:      'info',
  booked:        'info',
  ready_for_delivery: 'info',
  complete_sign: 'success',
  draft:         'muted',
  pending:       'warning',
  quality_check: 'warning',
  overdue:       'warning',
  cancelled:     'danger',
  failed:        'danger',
  no_show:       'warning',
  inactive:      'muted',
  draft:         'muted',
};

export function StatusBadge({ status, tone, label }) {
  const resolvedTone = tone || STATUS_TONE[status] || 'muted';
  const text = label || (status || '').replace(/_/g, ' ');
  return <span className={TONES[resolvedTone]}>{text}</span>;
}
