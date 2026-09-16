import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, RotateCcw, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { RefundModal } from '../../components/RefundModal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { Money } from '../../services/currency.jsx';
import { formatDateTime } from '../../services/timeformat.jsx';
import {
  invoicesApi, creditNotesApi,
  INVOICE_STATUS_TONE, CREDIT_NOTE_STATUS_TONE, CREDIT_NOTE_STATUS_LABELS,
} from '../../services/paymentsService.js';
import { apiErrorMessage } from '../../utils/apiError';

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '5px 0', fontSize: 14 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 500, textAlign: 'right' }}>{children}</span>
    </div>
  );
}

export default function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const canRefund = hasPerm('invoicing.credit');
  const canApprove = hasPerm('invoicing.credit_approve');

  const [inv, setInv] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refundOpen, setRefundOpen] = useState(false);
  const [toReject, setToReject] = useState(null);
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setInv(await invoicesApi.get(id)); }
    catch (e) { toast.error(apiErrorMessage(e, 'Unable to load the invoice. Please try again.')); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function dl(blobPromise, filename) {
    try {
      const blob = await blobPromise;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error(apiErrorMessage(e, 'Unable to download the PDF. Please try again.')); }
  }

  async function submitRefund({ amount, reason, method }) {
    setBusy(true);
    try {
      const cn = await invoicesApi.requestRefund(id, { amount, reason, method });
      toast.success(cn.status === 'pending_approval'
        ? `Refund ${cn.number} submitted for approval`
        : `Refund processed - credit note ${cn.number}`);
      setRefundOpen(false); load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to request the refund. Please try again.'));
    } finally { setBusy(false); }
  }

  async function approve(cn) {
    setBusy(true);
    try { await creditNotesApi.approve(cn.id); toast.success(`Refund ${cn.number} approved`); load(); }
    catch (e) { toast.error(apiErrorMessage(e, 'Unable to approve the refund. Please try again.')); }
    finally { setBusy(false); }
  }

  async function runReject() {
    if (!remarks.trim()) {
      toast.error('A reason is required to reject a refund.');
      return;
    }
    setBusy(true);
    try {
      await creditNotesApi.reject(toReject.id, remarks.trim());
      toast.success(`Refund ${toReject.number} rejected`);
      setToReject(null); setRemarks(''); load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to reject the refund. Please try again.'));
    } finally { setBusy(false); }
  }

  if (loading || !inv) {
    return <div className="muted" style={{ padding: 24 }}>Loading…</div>;
  }

  const cns = inv.credit_notes || [];
  const refundable = ['paid', 'partially_refunded'].includes(inv.status)
    && Number(inv.refundable_amount) > 0;

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 8 }} onClick={() => navigate('/invoices')}>
        <ArrowLeft size={15} /> Invoices
      </button>
      <PageHeader
        title={`Invoice ${inv.number}`}
        subtitle="Original invoice, its credit notes (refunds), and the refundable balance."
        actions={canRefund && refundable && (
          <button className="btn btn-primary" onClick={() => setRefundOpen(true)}>
            <RotateCcw size={15} /> Request refund
          </button>
        )}
      />

      {/* Original invoice */}
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Original Invoice</h3>
          <StatusBadge tone={INVOICE_STATUS_TONE[inv.status] || 'muted'} label={inv.status_display || inv.status} />
          <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }}
            onClick={() => dl(invoicesApi.download(inv.id), `${inv.number}.pdf`)}>
            <Download size={14} /> Invoice PDF
          </button>
        </div>
        <Row label="Invoice number">{inv.number}</Row>
        <Row label="Billed to">{inv.bill_to || '-'}</Row>
        <Row label="Booking">
          {inv.booking ? (
            <button className="link-btn" onClick={() => navigate(`/bookings/${inv.booking}`)}>
              {inv.booking_reference || 'View booking'}
            </button>
          ) : (inv.booking_reference || '-')}
        </Row>
        <Row label="Payment / receipt">
          {inv.payment ? (
            <button className="link-btn" onClick={() => navigate(`/payments/${inv.payment}`)}>
              {inv.receipt?.number || 'View payment'}
            </button>
          ) : '-'}
        </Row>
        <Row label="Issued">{formatDateTime(inv.issued_at)}</Row>
        <div style={{ borderTop: '1px solid var(--color-border)', margin: '6px 0' }} />
        <Row label="Subtotal"><Money amount={inv.subtotal} code={inv.currency} /></Row>
        <Row label={`VAT / Tax${Number(inv.tax_rate) ? ` (${(Number(inv.tax_rate) * 100).toFixed(0)}%)` : ''}`}>
          <Money amount={inv.tax_amount} code={inv.currency} /></Row>
        <Row label="Invoice total"><strong><Money amount={inv.total} code={inv.currency} /></strong></Row>
        <Row label="Paid"><Money amount={inv.amount_paid} code={inv.currency} /></Row>
        {Number(inv.outstanding) > 0 && (
          <Row label="Outstanding"><Money amount={inv.outstanding} code={inv.currency} /></Row>
        )}
        {Number(inv.refunded_total) > 0 && (
          <Row label="Refunded"><Money amount={inv.refunded_total} code={inv.currency} /></Row>
        )}
      </div>

      {/* Service, add-ons, subscription coverage & promo from the booking */}
      {inv.booking_detail && (
        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Booking &amp; coverage</h3>
          <Row label="Facility">{inv.booking_detail.facility || '-'}</Row>
          {(inv.booking_detail.add_ons || []).length > 0 && (
            <Row label="Add-ons">{inv.booking_detail.add_ons.join(', ')}</Row>
          )}
          {inv.booking_detail.club && <Row label="Club">{inv.booking_detail.club}</Row>}
          {inv.booking_detail.coverage && (
            <Row label="Subscription">
              {inv.booking_detail.coverage.membership_number} - {inv.booking_detail.coverage.plan_name}
              {inv.booking_detail.coverage.covered_amount != null && (
                <> · covered <Money amount={inv.booking_detail.coverage.covered_amount} code={inv.currency} /></>
              )}
            </Row>
          )}
          {inv.booking_detail.promo_code && (
            <Row label="Promo">
              {inv.booking_detail.promo_code}
              {Number(inv.booking_detail.promo_discount) > 0 && (
                <> · − <Money amount={inv.booking_detail.promo_discount} code={inv.currency} /></>
              )}
            </Row>
          )}
        </div>
      )}

      {/* Credit notes (refund documents) */}
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Credit Notes</h3>
        {cns.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>No refunds yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)' }}>
                <th style={{ padding: '6px 8px' }}>Credit Note</th>
                <th style={{ padding: '6px 8px' }}>Date</th>
                <th style={{ padding: '6px 8px' }}>Amount</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px' }}>Reason</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {cns.map((cn) => (
                <tr key={cn.id} style={{ borderTop: '1px solid var(--color-border,#e5e7eb)' }}>
                  <td style={{ padding: '8px', fontWeight: 600 }}>
                    <button className="link-btn" style={{ fontWeight: 600 }}
                      onClick={() => navigate(`/credit-notes/${cn.id}`)}>{cn.number}</button>
                  </td>
                  <td style={{ padding: '8px' }}>{formatDateTime(cn.requested_at)}</td>
                  <td style={{ padding: '8px' }}><Money amount={cn.total} code={cn.currency} /></td>
                  <td style={{ padding: '8px' }}>
                    <StatusBadge tone={CREDIT_NOTE_STATUS_TONE[cn.status] || 'muted'}
                      label={CREDIT_NOTE_STATUS_LABELS[cn.status] || cn.status} />
                  </td>
                  <td style={{ padding: '8px', color: 'var(--color-text-muted)' }}>{cn.reason || '-'}</td>
                  <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {cn.status === 'issued' && (
                      <button className="btn btn-ghost btn-sm"
                        onClick={() => dl(creditNotesApi.download(cn.id), `${cn.number}.pdf`)}>
                        <Download size={13} /> PDF
                      </button>
                    )}
                    {cn.status === 'pending_approval' && canApprove && (
                      <>
                        <button className="btn btn-ghost btn-sm" disabled={busy}
                          style={{ color: 'var(--color-success,#059669)' }} onClick={() => approve(cn)}>
                          <Check size={13} /> Approve
                        </button>
                        <button className="btn btn-ghost btn-sm" disabled={busy}
                          style={{ color: 'var(--color-danger,#dc2626)' }}
                          onClick={() => { setToReject(cn); setRemarks(''); }}>
                          <X size={13} /> Reject
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Summary */}
      <div className="card" style={{ padding: 16, maxWidth: 360 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Summary</h3>
        <Row label="Total refunded"><Money amount={inv.refunded_total} code={inv.currency} /></Row>
        <Row label="Remaining refundable balance"><Money amount={inv.refundable_amount} code={inv.currency} /></Row>
      </div>

      <RefundModal
        open={refundOpen} invoice={inv} busy={busy}
        onConfirm={submitRefund}
        onClose={() => { if (!busy) setRefundOpen(false); }}
      />

      <ConfirmDialog
        open={Boolean(toReject)} busy={busy} tone="danger" title="Reject refund?" confirmLabel="Reject"
        message={toReject ? (
          <>
            Reject refund <strong>{toReject.number}</strong>? No money will be returned. A reason is required.
            <input className="form-input" style={{ marginTop: 10 }} placeholder="Reason (required)"
              value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </>
        ) : null}
        onConfirm={runReject}
        onClose={() => { if (!busy) { setToReject(null); setRemarks(''); } }}
      />
    </>
  );
}
