import { useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatTime, useTimeFormat } from '../../services/timeformat.jsx';
import { statusClass, statusLabel } from './bookingStatus.js';

/**
 * A quick look at one booking, from the calendar.
 *
 * Opening the full record loses your place in the week, and most of the time
 * the question is only "who is this and is it paid?". This answers that in
 * place, and still offers the two things that need the full page.
 *
 * It reads only what the list already returned, so it costs no request.
 */
export function BookingPeek({ row, onClose, onOpen, onReschedule }) {
  const { t } = useTranslation('bookings');
  const { format24 } = useTimeFormat();
  const panel = useRef(null);

  useEffect(() => {
    // Focus moves into the panel so a keyboard user is not left behind on the
    // grid, and Escape closes it the way every other overlay here does.
    panel.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!row) return null;

  const when = `${row.scheduled_date} · ${formatTime(row.scheduled_time, { format24 })}`;
  const paid = row.payment_status === 'paid';

  return (
    <div
      className="bk-peek"
      role="dialog"
      aria-label={t('card.aria', { reference: row.reference, status: statusLabel(row.status) })}
      tabIndex={-1}
      ref={panel}
      onClick={(e) => e.stopPropagation()}
    >
      <header className="bk-peek__head">
        <span className={`bk-peek__status ${statusClass(row.status)}`}>
          <Check size={13} aria-hidden="true" /> {statusLabel(row.status)}
        </span>
        <button type="button" className="icon-btn" aria-label={t('common:actions.close')}
          onClick={onClose}>
          <X size={15} />
        </button>
      </header>

      <div className="bk-peek__ref">{row.reference}</div>
      <h4 className="bk-peek__who">{row.customer_label}</h4>
      <p className="bk-peek__where">
        {[row.facility_name || row.facility_type_name, row.club_name].filter(Boolean).join(' · ')}
      </p>

      <dl className="bk-peek__facts">
        <div>
          <dt>{t('calendar.when')}</dt>
          <dd>{when}</dd>
        </div>
        <div>
          <dt>{t('calendar.payment')}</dt>
          <dd className={paid ? '' : 'bk-peek__unpaid'}>
            {row.payment_status_display
              || t(`paymentStatus.${row.payment_status || 'pending'}`, row.payment_status || '')}
          </dd>
        </div>
      </dl>

      <div className="bk-peek__actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpen(row)}>
          {t('calendar.openBooking')}
        </button>
        {onReschedule && row.can_modify && (
          <button type="button" className="btn btn-secondary btn-sm"
            onClick={() => onReschedule(row)}>
            {t('calendar.reschedule')}
          </button>
        )}
      </div>
    </div>
  );
}
