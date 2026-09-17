import { useTranslation } from 'react-i18next';

import { StatusBadge } from '../../components/StatusBadge.jsx';
import { formatMoney } from '../../services/currency.jsx';
import { formatDateTime } from '../../services/timeformat.jsx';

import './splitPanel.css';

/**
 * Who actually paid, when a booking was settled by several people.
 *
 * Read-only on purpose. A split is arranged and managed by the customer through
 * their own secure links; staff need to SEE the breakdown (for a refund, a
 * dispute, or a question at the counter) but there is no reason for an admin to
 * reach into somebody's arrangement, and every way of doing so would be another
 * path to money moving without the customer's knowledge.
 *
 * It also answers the question a refund raises: a booking paid by four people
 * may need four refunds, and this is where the operator sees which payment
 * belongs to whom before raising a credit note.
 */
const SPLIT_TONE = {
  completed: 'success',
  active: 'info',
  expired: 'muted',
  cancelled: 'muted',
};

const SHARE_TONE = {
  paid: 'success',
  pending: 'warning',
  failed: 'danger',
  expired: 'muted',
  cancelled: 'muted',
};

export function SplitPaymentPanel({ splits, currency }) {
  const { t } = useTranslation('bookings');
  if (!splits || splits.length === 0) return null;

  return (
    <div className="split-panel">
      {splits.map((split) => (
        <section key={split.id} className="split-panel__block">
          <header className="split-panel__head">
            <h4 className="split-panel__title">{t('split.title')}</h4>
            <StatusBadge
              tone={SPLIT_TONE[split.status] || 'muted'}
              label={t(`split.status.${split.status}`, split.status)}
            />
          </header>

          <div className="split-panel__totals">
            <div>
              <span>{t('split.allocated')}</span>
              <strong>{formatMoney(split.allocated, split.currency || currency)}</strong>
            </div>
            <div>
              <span>{t('split.collected')}</span>
              <strong>{formatMoney(split.paid, split.currency || currency)}</strong>
            </div>
            {split.status === 'active' && split.expires_at && (
              <div>
                <span>{t('split.expires')}</span>
                <strong>{formatDateTime(split.expires_at)}</strong>
              </div>
            )}
          </div>

          <table className="split-panel__table" aria-label={t('split.tableCaption')}>
            <thead>
              <tr>
                <th scope="col">{t('split.participant')}</th>
                <th scope="col">{t('split.amount')}</th>
                <th scope="col">{t('split.state')}</th>
                <th scope="col">{t('split.payment')}</th>
              </tr>
            </thead>
            <tbody>
              {split.shares.map((share) => (
                <tr key={share.id}>
                  <td>
                    {share.is_organizer ? t('split.organizer') : (share.name || t('split.guest'))}
                  </td>
                  <td>{formatMoney(share.amount, split.currency || currency)}</td>
                  <td>
                    <StatusBadge
                      tone={SHARE_TONE[share.status] || 'muted'}
                      label={t(`split.shareStatus.${share.status}`, share.status)}
                    />
                  </td>
                  <td>
                    {share.payment
                      ? <code className="split-panel__ref">{share.payment}</code>
                      : <span className="muted">-</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

export default SplitPaymentPanel;
