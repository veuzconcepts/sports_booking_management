import { Crown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { StatusBadge } from '../../components/StatusBadge.jsx';
import { formatMoney } from '../../services/currency.jsx';
import { formatDateTime } from '../../services/timeformat.jsx';

import './splitPanel.css';

/**
 * Who actually paid, when a booking was settled by several people.
 *
 * Read-only apart from issuing a payment link. A split is arranged and managed
 * by the customer through their own secure links; staff need to SEE the
 * breakdown (for a refund, a dispute, or a question at the counter), and there
 * is no reason for an admin to reach into somebody's arrangement beyond that,
 * because every other way of doing so would be another path to money moving
 * without the customer's knowledge.
 *
 * Issuing a link is the exception because the customer can lose theirs and
 * nobody, including us, can look it up: only digests are stored. Minting a
 * fresh one is the honest recovery, and it invalidates the old link, which the
 * caller has to say out loud before doing it.
 *
 * It also answers the question a refund raises: a booking paid by four people
 * may need four refunds, and this is where the operator sees which payment
 * belongs to whom before raising a credit note.
 *
 * On a multi-slot order the arrangement belongs to the ORDER, so every slot of
 * that order shows the same breakdown. Staff open a slot, not an order, and
 * the slot used to say nothing at all about who was paying for it.
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

/** Shares a fresh link can still be issued for. A paid one is finished. */
const OPEN_SHARE_STATUSES = new Set(['pending', 'failed']);

export function SplitPaymentPanel({ splits, currency, onIssueLink, issuingShare }) {
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
                {onIssueLink && <th scope="col">{t('split.link')}</th>}
              </tr>
            </thead>
            <tbody>
              {split.shares.map((share) => (
                <tr key={share.id}>
                  <td>
                    {/* The NAME, always. Printing "Organizer" in place of it
                        told staff nothing and read like a second, anonymous
                        participant sitting above the real people. Who arranged
                        the split is a mark on their name, not a replacement
                        for it. */}
                    <span className="split-panel__who">
                      {share.name || t('split.guest')}
                      {share.is_organizer && (
                        <span className="split-panel__org" role="img"
                          title={t('split.organizerHint')}
                          aria-label={t('split.organizerHint')}>
                          <Crown size={11} aria-hidden="true" />
                        </span>
                      )}
                    </span>
                    {/* Only present when the reader holds
                        `payments.view_payer_contacts`. The backend omits the
                        keys entirely rather than blanking them, so an absent
                        permission never looks like a payer who gave no
                        details. */}
                    {(share.email || share.phone) && (
                      <div className="split-panel__contact">
                        {share.email || share.phone}
                      </div>
                    )}
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
                  {/* Issuing a link, not revealing one. Raw tokens are never
                      stored, so the link the customer was given cannot be
                      looked up; a fresh one is the only recovery, and it stops
                      the previous link working. */}
                  {onIssueLink && (
                    <td>
                      {split.status === 'active'
                        && OPEN_SHARE_STATUSES.has(share.status) ? (
                          <button type="button" className="btn btn-secondary btn-sm"
                            disabled={issuingShare === share.id}
                            onClick={() => onIssueLink(split, share)}>
                            {issuingShare === share.id
                              ? t('split.issuing')
                              : t('split.issueLink')}
                          </button>
                        ) : <span className="muted">-</span>}
                    </td>
                  )}
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
