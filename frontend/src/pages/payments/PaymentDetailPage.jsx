import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { Money } from '../../services/currency.jsx';
import { formatDateTime } from '../../services/timeformat.jsx';
import { paymentsApi, receiptsApi } from '../../services/paymentsService.js';
import { apiErrorMessage } from '../../utils/apiError';

const PAY_TONE = { paid: 'success', pending: 'info', failed: 'danger', refunded: 'muted', partially_refunded: 'warning' };
const REFUND_TONE = { completed: 'success', pending: 'info', failed: 'danger' };
const dt = (x) => (x ? formatDateTime(x) : '-');

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '5px 0', fontSize: 14 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 500, textAlign: 'right' }}>{children}</span>
    </div>
  );
}

// A payment's own page: amount, date, mode + gateway details (card/bank), the
// invoice or refund it relates to, and the booking it belongs to.
export default function PaymentDetailPage() {
  const { t } = useTranslation('payments');
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const [p, setP] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setP(await paymentsApi.get(id)); }
    catch (e) { toast.error(apiErrorMessage(e, t('unableLoadPaymentPleaseTry'))); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function downloadReceipt() {
    try {
      const blob = await receiptsApi.download(p.receipt_id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${p.receipt_number || 'receipt'}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error(apiErrorMessage(e, t('unableDownloadReceiptPleaseTry'))); }
  }

  if (loading) {
    return <div className="card"><div className="card-body center" style={{ padding: 64 }}><span className="muted">Loading payment…</span></div></div>;
  }
  if (!p) return null;
  const refunds = p.refunds || [];
  const gatewayShown = p.method === 'card' || p.method === 'bank_transfer';

  return (
    <>
      <button className="btn btn-ghost" onClick={() => navigate('/payments')} style={{ marginBottom: 12 }}>
        <ArrowLeft size={15} /> {t('backPayments')}
      </button>

      <PageHeader title={p.reference} subtitle={t('payment')}
        actions={p.receipt_id ? (
          <button className="btn btn-secondary" onClick={downloadReceipt}>
            <Download size={15} /> {t('receiptPdf')}
          </button>
        ) : null}
      />


      <div className="row">
        <div className="col" style={{ flex: '1 1 320px' }}>
          <div className="card"><div className="card-body">
            <h3 className="card-title" style={{ marginBottom: 8 }}>{t('payment')}</h3>
            <Row label={t('paymentNumber')}>{p.reference}</Row>
            <Row label={t('common:labels.amount')}><Money amount={p.amount} code={p.currency} /></Row>
            {Number(p.refunded_amount) > 0 && (
              <Row label={t('refunded')}><Money amount={p.refunded_amount} code={p.currency} /></Row>
            )}
            <Row label={t('common:labels.status')}><StatusBadge tone={PAY_TONE[p.status] || 'muted'} label={p.status_display || p.status} /></Row>
            <Row label={t('mode')}>{p.method_display || p.method}</Row>
            <Row label={t('common:labels.date')}>{dt(p.paid_at || p.created_at)}</Row>
            <Row label={t('taken')}>{p.created_by_name || '-'}</Row>
            {/* Only set when somebody other than the booking's own customer
                handed the money over, which is a split share. The refund goes
                back to this person, so it belongs on the payment they made. */}
            {p.payer && <Row label={t('paidBy')}>{p.payer}</Row>}
          </div></div>
        </div>

        <div className="col" style={{ flex: '1 1 320px' }}>
          <div className="card"><div className="card-body">
            <h3 className="card-title" style={{ marginBottom: 8 }}>{t('relatedDocuments')}</h3>
            <Row label={t('booking')}>
              {p.booking ? (
                <button className="link-btn" onClick={() => navigate(`/bookings/${p.booking}`)}>{p.booking_reference}</button>
              ) : '-'}
            </Row>
            <Row label={t('invoice')}>
              {p.invoice_id && hasPerm('invoicing.view') ? (
                <button className="link-btn" onClick={() => navigate(`/invoices/${p.invoice_id}`)}>{p.invoice_number}</button>
              ) : (p.invoice_number || '-')}
            </Row>
            {refunds.map((r) => (
              <Row key={r.id} label={t('refundCreditNote')}>
                {r.credit_note_id && hasPerm('invoicing.view') ? (
                  <button className="link-btn" onClick={() => navigate(`/credit-notes/${r.credit_note_id}`)}>
                    {r.credit_note_number || r.reference}
                  </button>
                ) : (r.credit_note_number || r.reference)}
              </Row>
            ))}
          </div></div>

          {gatewayShown && (
            <>
              <div style={{ height: 16 }} />
              <div className="card"><div className="card-body">
                <h3 className="card-title" style={{ marginBottom: 8 }}>
                  {p.method === 'card' ? t('cardGatewayDetails') : t('bankTransferDetails')}
                </h3>
                <Row label={t('gateway')}>{p.gateway || '-'}</Row>
                <Row label={t('gatewayReference')}>{p.gateway_reference || '-'}</Row>
                {p.failure_reason && <Row label={t('failureReason')}>{p.failure_reason}</Row>}
              </div></div>
            </>
          )}
        </div>
      </div>

      {refunds.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}><div className="card-body">
          <h3 className="card-title" style={{ marginBottom: 8 }}>{t('refundsPayment')}</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ textAlign: 'left', padding: 6, fontSize: 12 }}>{t('common:labels.date')}</th>
                <th style={{ textAlign: 'left', padding: 6, fontSize: 12 }}>{t('creditNote2')}</th>
                <th style={{ textAlign: 'right', padding: 6, fontSize: 12 }}>{t('common:labels.amount')}</th>
                <th style={{ textAlign: 'left', padding: 6, fontSize: 12 }}>{t('common:labels.status')}</th>
                <th style={{ textAlign: 'left', padding: 6, fontSize: 12 }}>{t('common:labels.reason')}</th>
              </tr></thead>
              <tbody>
                {refunds.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--color-border,#eee)' }}>
                    <td style={{ padding: 6, fontSize: 13 }}>{dt(r.created_at)}</td>
                    <td style={{ padding: 6, fontSize: 13 }}>{r.credit_note_number || '-'}</td>
                    <td style={{ padding: 6, fontSize: 13, textAlign: 'right' }}><Money amount={r.amount} code={p.currency} /></td>
                    <td style={{ padding: 6, fontSize: 13 }}><StatusBadge tone={REFUND_TONE[r.status] || 'muted'} label={r.status_display || r.status} /></td>
                    <td style={{ padding: 6, fontSize: 13 }}>{r.reason || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div></div>
      )}
    </>
  );
}
