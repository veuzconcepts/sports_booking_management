import { useStatusLabel } from '../i18n/statusLabels.js';

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
  pending:       'warning',
  quality_check: 'warning',
  overdue:       'warning',
  cancelled:     'danger',
  failed:        'danger',
  no_show:       'warning',
  inactive:      'muted',
  draft:         'muted',
  // A reservation that became a booking did its job; one that was let go or
  // ran out is simply history, and reads like the other spent states.
  converted:     'success',
  released:      'muted',
  expired:       'muted',
};

/**
 * A status pill. The colour comes from the status CODE; the words come from the
 * translation layer, so `confirmed` stays `confirmed` everywhere it matters and
 * only what the reader sees changes with the language.
 *
 * An explicit `label` still wins, for the callers that pass domain text the
 * status map does not know about.
 */
export function StatusBadge({ status, tone, label }) {
  const statusLabel = useStatusLabel();
  const resolvedTone = tone || STATUS_TONE[status] || 'muted';
  return <span className={TONES[resolvedTone]}>{statusLabel(status, label)}</span>;
}
