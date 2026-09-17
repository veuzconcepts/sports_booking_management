import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download } from 'lucide-react';
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
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const [p, setP] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setP(await paymentsApi.get(id)); }
    catch (e) { toast.error(apiErrorMessage(e, 'Unable to load the payment. Please try again.')); }
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
    } catch (e) { toast.error(apiErrorMessage(e, 'Unable to download the receipt. Please try again.')); }
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
        <ArrowLeft size={15} /> Back to payments
      </button>

      <PageHeader title={p.reference} subtitle="Payment"
        actions={p.receipt_id ? (
          <button className="btn btn-secondary" onClick={downloadReceipt}>
            <Download size={15} /> Receipt PDF
          </button>
        ) : null}
      />


      <div className="row">
        <div className="col" style={{ flex: '1 1 320px' }}>
          <div className="card"><div className="card-body">
            <h3 className="card-title" style={{ marginBottom: 8 }}>Payment</h3>
            <Row label="Payment number">{p.reference}</Row>
            <Row label="Amount"><Money amount={p.amount} code={p.currency} /></Row>
            {Number(p.refunded_amount) > 0 && (
              <Row label="Refunded"><Money amount={p.refunded_amount} code={p.currency} /></Row>
            )}
            <Row label="Status"><StatusBadge tone={PAY_TONE[p.status] || 'muted'} label={p.status_display || p.status} /></Row>
            <Row label="Mode">{p.method_display || p.method}</Row>
            <Row label="Date">{dt(p.paid_at || p.created_at)}</Row>
            <Row label="Taken by">{p.created_by_name || '-'}</Row>
          </div></div>
        </div>

        <div className="col" style={{ flex: '1 1 320px' }}>
          <div className="card"><div className="card-body">
            <h3 className="card-title" style={{ marginBottom: 8 }}>Related documents</h3>
            <Row label="Booking">
              {p.booking ? (
                <button className="link-btn" onClick={() => navigate(`/bookings/${p.booking}`)}>{p.booking_reference}</button>
              ) : '-'}
            </Row>
            <Row label="Invoice">
              {p.invoice_id && hasPerm('invoicing.view') ? (
                <button className="link-btn" onClick={() => navigate(`/invoices/${p.invoice_id}`)}>{p.invoice_number}</button>
              ) : (p.invoice_number || '-')}
            </Row>
            {refunds.map((r) => (
              <Row key={r.id} label="Refund / credit note">
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
                  {p.method === 'card' ? 'Card / gateway details' : 'Bank transfer details'}
                </h3>
                <Row label="Gateway">{p.gateway || '-'}</Row>
                <Row label="Gateway reference">{p.gateway_reference || '-'}</Row>
                {p.failure_reason && <Row label="Failure reason">{p.failure_reason}</Row>}
              </div></div>
            </>
          )}
        </div>
      </div>

      {refunds.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}><div className="card-body">
          <h3 className="card-title" style={{ marginBottom: 8 }}>Refunds on this payment</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ textAlign: 'left', padding: 6, fontSize: 12 }}>Date</th>
                <th style={{ textAlign: 'left', padding: 6, fontSize: 12 }}>Credit note</th>
                <th style={{ textAlign: 'right', padding: 6, fontSize: 12 }}>Amount</th>
                <th style={{ textAlign: 'left', padding: 6, fontSize: 12 }}>Status</th>
                <th style={{ textAlign: 'left', padding: 6, fontSize: 12 }}>Reason</th>
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
