import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Layers } from 'lucide-react';

import { StatusBadge } from '../../components/StatusBadge.jsx';
import { statusLabel } from './bookingStatus.js';
import { Money } from '../../services/currency.jsx';

/**
 * The other slots bought in the same checkout.
 *
 * A multi-slot booking is several ordinary bookings, which is what keeps
 * availability, the calendar, staff assignment and per-slot refunds working
 * unchanged. The price of that decision is that one booking, on its own, gives
 * no hint that it was part of a larger purchase. This panel is where that is
 * put right, so staff cancelling one slot can see what else the customer
 * bought before they do it.
 */
export function OrderPanel({ order, orderId }) {
  const { t } = useTranslation('bookings');

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Layers size={16} />
        <h3 className="card-title" style={{ margin: 0 }}>{t('partOfOrder')}</h3>
      </div>
      <div className="card-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          {t('orderExplains', { reference: order.reference, count: order.slot_count })}
        </p>

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {order.slots.map((slot) => {
            return (
              <li key={slot.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 10, flexWrap: 'wrap', padding: '8px 10px', borderRadius: 8,
                background: slot.is_this_one
                  ? 'var(--color-primary-50, var(--color-surface-2))'
                  : 'var(--color-surface-2, transparent)',
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  {slot.is_this_one ? (
                    <strong>{slot.scheduled_date} · {slot.scheduled_time}</strong>
                  ) : (
                    <Link to={`/bookings/${slot.id}`}>
                      {slot.scheduled_date} · {slot.scheduled_time}
                    </Link>
                  )}
                  <StatusBadge status={slot.status} label={statusLabel(slot.status)} />
                </span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  <Money amount={slot.total_amount} code={order.currency} />
                </span>
              </li>
            );
          })}
        </ul>

        <div style={{
          display: 'flex', justifyContent: 'space-between', marginTop: 10,
          paddingTop: 10, borderTop: '1px solid var(--color-border)', fontSize: 13,
        }}>
          <span>{t('orderTotal')}</span>
          <strong><Money amount={order.total_amount} code={order.currency} /></strong>
        </div>

        {/* The whole checkout on one screen: every slot with its own money and
            status, the payers, and what is still owed. This panel answers
            "what else did they book"; that page answers "what happened to the
            order". */}
        {orderId && (
          <p style={{ margin: '12px 0 0', fontSize: 13 }}>
            <Link to={`/orders/${orderId}`}>{t('viewFullOrder')}</Link>
          </p>
        )}
      </div>
    </div>
  );
}

export default OrderPanel;
