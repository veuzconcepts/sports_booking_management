import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Modal } from '../../components/Modal.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { formatDate, formatDateTime, formatTime, useTimeFormat } from '../../services/timeformat.jsx';
import { bookingSources } from '../../services/bookingsService.js';
import { HoldCountdown } from './HoldCountdown.jsx';

/**
 * One reservation, in full.
 *
 * The question this answers is "why can I not book that court?", so the courts
 * themselves are the body of the panel: a reservation can hold several slots
 * across several facilities, and the listing only has room for the first.
 *
 * It renders what the listing already fetched, so opening it costs no request.
 * Nothing here can edit a reservation. The only action is releasing it, which
 * gives the courts back before the deadline, and that is deliberately in the
 * footer where a destructive action belongs rather than beside the reference.
 */
function Field({ label, children }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13.5 }}>{children}</div>
    </div>
  );
}

export function ReservationPanel({ row, open, onClose, onRelease, releasing, canRelease }) {
  const { t } = useTranslation('bookings');
  const { t: tc } = useTranslation('common');
  const { format24 } = useTimeFormat();
  const navigate = useNavigate();

  if (!row) return null;

  const slots = row.slots || [];
  const live = Boolean(row.is_live);
  // The API sends the stable code; the words come from the same helper every
  // other booking screen reads them from, so there is one list of sources.
  const sourceLabel =
    bookingSources(t).find((s) => s.value === row.source)?.label || row.source || '-';

  const goToOutcome = () => {
    if (row.booking) navigate(`/bookings/${row.booking}`);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      side
      size="md"
      title={t('reservations.panelTitle', { reference: row.reference })}
      footer={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            {tc('actions.close')}
          </button>
          {/* Only a live reservation is holding anything, so only a live one
              has something to give back. */}
          {canRelease && live && (
            <button className="btn btn-danger" type="button" disabled={releasing}
              onClick={() => onRelease(row)}>
              {releasing ? t('reservations.releasing') : t('reservations.release')}
            </button>
          )}
        </>
      }
    >
      <div className="form-grid form-grid--2" style={{ marginBottom: 18 }}>
        <Field label={tc('labels.status')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StatusBadge status={row.status} tone={live ? 'success' : undefined} />
            <HoldCountdown
              secondsRemaining={row.seconds_remaining}
              receivedAt={row.received_at}
              live={live}
            />
          </span>
        </Field>
        <Field label={t('reservations.columns.expires')}>
          {live ? formatDateTime(row.expires_at) : (
            <span className="muted">
              {row.ended_at ? formatDateTime(row.ended_at) : formatDateTime(row.expires_at)}
            </span>
          )}
        </Field>
        <Field label={t('columns.customer')}>
          {row.customer_name || <span className="muted">{t('reservations.guest')}</span>}
        </Field>
        <Field label={tc('labels.club')}>{row.club_name || '-'}</Field>
        <Field label={t('columns.facilityType')}>
          {row.facility_type_name || <span className="muted">-</span>}
        </Field>
        <Field label={t('source')}>{sourceLabel}</Field>
        <Field label={t('reservations.columns.created')}>{formatDateTime(row.created_at)}</Field>
        <Field label={t('reservations.takenBy')}>
          {row.created_by_name || <span className="muted">{t('reservations.guest')}</span>}
        </Field>
      </div>

      <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>
        {t('reservations.heldCourts', { n: slots.length })}
      </h3>
      {slots.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>{t('reservations.noSlots')}</p>
      ) : (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>{tc('labels.facility')}</th>
                <th>{t('bookingDate')}</th>
                <th>{t('columns.startTime')}</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((slot) => (
                <tr key={slot.id}>
                  <td>{slot.facility_name || '-'}</td>
                  <td>{formatDate(slot.scheduled_date)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {formatTime(slot.scheduled_time, { format24 })}
                    {slot.end_time ? ` - ${formatTime(slot.end_time, { format24 })}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* What it turned into, when it turned into something. A converted
          reservation is the commonest reason a court looks held with no
          booking on the day view, so the booking it became is the answer. */}
      {(row.booking_reference || row.order_reference) && (
        <p style={{ fontSize: 13, marginTop: 16 }}>
          {t('reservations.becameBooking')}{' '}
          {row.booking ? (
            <button type="button" className="link-btn" onClick={goToOutcome}
              style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
              {row.booking_reference}
            </button>
          ) : (
            <strong style={{ fontFamily: 'var(--font-mono, monospace)' }}>
              {row.order_reference}
            </strong>
          )}
        </p>
      )}
    </Modal>
  );
}
