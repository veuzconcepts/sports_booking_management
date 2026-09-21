import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../components/PageHeader.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Money } from '../../services/currency.jsx';
import { formatDate, formatDateTime, formatTime, useTimeFormat } from '../../services/timeformat.jsx';
import { ordersApi, bookingSources } from '../../services/bookingsService.js';
import { apiErrorMessage } from '../../utils/apiError';

/**
 * One multi-slot checkout, on one screen.
 *
 * A multi-slot order stays N ordinary bookings, which is what keeps the
 * calendar, capacity, staff assignment, refunds and the `(facility, date,
 * time)` uniqueness guarantee working untouched. The price of that decision is
 * that the checkout itself was visible nowhere: staff saw three near-identical
 * rows sharing a reference and had to open each in turn to work out what had
 * been paid and what had not.
 *
 * Everything here is read from the bookings. The order holds no money and no
 * status of its own, so there is nothing to edit and nothing that can drift
 * from the slots it is summed from.
 */
function Field({ label, children }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13.5 }}>{children}</div>
    </div>
  );
}

export default function OrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation('bookings');
  const { format24 } = useTimeFormat();

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setOrder(await ordersApi.get(id));
    } catch (e) {
      setError(apiErrorMessage(e, t('order.loadFailed')));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="page">
        <p className="muted">{t('common:state.loading')}</p>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="page">
        <PageHeader title={t('order.title')} />
        <div className="card">
          <div className="card-body">
            <p role="alert">{error || t('order.loadFailed')}</p>
            <button className="btn btn-secondary" type="button" onClick={load}>
              {t('common:actions.retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const sourceLabel = bookingSources(t)
    .find((s) => s.value === order.source)?.label || order.source_display || '-';
  const settled = Number(order.outstanding) <= 0;

  return (
    <div className="page">
      <PageHeader
        title={order.reference}
        subtitle={t('order.subtitle', { count: order.slot_count })}
        actions={
          <button className="btn btn-secondary" type="button" onClick={() => navigate(-1)}>
            <ArrowLeft size={15} /> {t('common:actions.back')}
          </button>
        }
      />

      <div className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Layers size={16} />
          <h3 className="card-title" style={{ margin: 0 }}>{t('order.checkout')}</h3>
        </div>
        <div className="card-body">
          <div className="form-grid form-grid--3">
            <Field label={t('columns.customer')}>
              {order.customer
                ? <Link to={`/customers/${order.customer}`}>{order.customer_name}</Link>
                : (order.customer_name || '-')}
            </Field>
            <Field label={t('common:labels.email')}>{order.customer_email || '-'}</Field>
            <Field label={t('common:labels.phone')}>{order.customer_mobile || '-'}</Field>
            <Field label={t('common:labels.club')}>{order.club_name || '-'}</Field>
            <Field label={t('columns.facilityType')}>{order.facility_type_name || '-'}</Field>
            <Field label={t('source')}>{sourceLabel}</Field>
            <Field label={t('order.placed')}>{formatDateTime(order.created_at)}</Field>
            <Field label={t('order.takenBy')}>
              {order.created_by_name || <span className="muted">{t('order.customerOnline')}</span>}
            </Field>
            <Field label={t('order.totalTime')}>
              {t('order.minutes', { n: order.total_duration_minutes })}
            </Field>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">
          <h3 className="card-title">{t('order.slots', { n: order.slot_count })}</h3>
        </div>
        <div className="card-body">
          {/* A cancelled slot stays in this list even though it is out of the
              money below: it is usually the thing somebody opened this screen
              to ask about. */}
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('reference')}</th>
                  <th>{t('bookingDate')}</th>
                  <th>{t('columns.startTime')}</th>
                  <th>{t('common:labels.facility')}</th>
                  <th>{t('common:labels.status')}</th>
                  <th>{t('columns.payment')}</th>
                  <th style={{ textAlign: 'end' }}>{t('common:labels.total')}</th>
                  <th style={{ textAlign: 'end' }}>{t('order.outstanding')}</th>
                </tr>
              </thead>
              <tbody>
                {(order.slots || []).map((slot) => (
                  <tr key={slot.id}>
                    <td>
                      <Link to={`/bookings/${slot.id}`}
                        style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
                        {slot.reference}
                      </Link>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(slot.scheduled_date)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {formatTime(slot.scheduled_time, { format24 })}
                      {slot.end_time ? ` - ${formatTime(slot.end_time, { format24 })}` : ''}
                    </td>
                    <td>{slot.facility_name || <span className="muted">-</span>}</td>
                    <td><StatusBadge status={slot.status} /></td>
                    <td><StatusBadge status={slot.payment_status} /></td>
                    <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
                      <Money amount={slot.total_amount} code={order.currency} />
                    </td>
                    <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
                      {Number(slot.outstanding) > 0
                        ? <Money amount={slot.outstanding} code={order.currency} />
                        : <span className="muted">-</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="form-grid form-grid--3" style={{ marginTop: 16 }}>
            <Field label={t('orderTotal')}>
              <strong><Money amount={order.total_amount} code={order.currency} /></strong>
            </Field>
            <Field label={t('order.paid')}>
              <Money amount={order.amount_paid} code={order.currency} />
            </Field>
            <Field label={t('order.outstanding')}>
              {settled
                ? <StatusBadge status="paid" />
                : <strong><Money amount={order.outstanding} code={order.currency} /></strong>}
            </Field>
          </div>

          {/* Who is paying lives on each slot, because a split is an
              arrangement over the bookings rather than over the order record.
              Pointing at one slot beats showing the same panel twice. */}
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0, marginTop: 14 }}>
            {t('order.payersHint')}
          </p>
        </div>
      </div>
    </div>
  );
}
