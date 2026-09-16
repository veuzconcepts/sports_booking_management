import { FileText, Ban, RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { StatusBadge } from './StatusBadge.jsx';
import { Money } from '../services/currency.jsx';
import { formatDateTime } from '../services/timeformat.jsx';
import { INVOICE_STATUS_TONE } from '../services/paymentsService.js';

const METHOD_LABELS = {
  card: 'Card', cash: 'Cash', wallet: 'Wallet', membership: 'Membership',
  online: 'Online', bank_transfer: 'Bank transfer',
};
const methodLabel = (m) => METHOD_LABELS[m] || (m ? m.replace(/_/g, ' ') : '-');
const PAY_TONE = { paid: 'success', pending: 'info', failed: 'danger', refunded: 'muted', partially_refunded: 'warning' };
const REFUND_TONE = { completed: 'success', pending: 'info', failed: 'danger' };
const CN_TONE = { issued: 'success', pending_approval: 'info', rejected: 'danger' };
const dt = (x) => (x ? formatDateTime(x) : '-');

const cell = { padding: '6px 8px', fontSize: 13, whiteSpace: 'nowrap' };
const head = { ...cell, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-muted,#6b7280)', textAlign: 'left' };
const SectionLabel = ({ children }) => (
  <div className="muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em', margin: '14px 0 6px', fontWeight: 700 }}>{children}</div>
);

/**
 * Audit-friendly booking finance: the Invoice → Payment → Refund trail on one
 * screen. `finance` = { invoices[], payments[] (with nested refunds[]) }.
 */
export function BookingFinancePanel({
  finance, canReverse = false, canInvoice = false, canCancel = false, busy = false,
  canViewInvoices = true, canViewPayments = true,
  outstanding = 0, onRefund, onCancel, onGenerate, onCollect,
  onDownloadInvoice, onDownloadReceipt, onDownloadCreditNote,
}) {
  const navigate = useNavigate();
  const invoices = finance?.invoices || [];
  const payments = finance?.payments || [];
  const refunds = payments.flatMap((p) => p.refunds || []);
  const liveInvoice = invoices.find((i) => !['cancelled', 'refunded'].includes(i.status));
  const currency = invoices[0]?.currency || payments[0]?.currency;

  return (
    <div>
      {/* ---- Invoices + Returns (requires invoice-view permission) ---- */}
      {canViewInvoices && invoices.length === 0 && <p className="muted" style={{ fontSize: 13 }}>No invoice yet.</p>}
      {canViewInvoices && invoices.map((inv) => (
        <div key={inv.id} style={{ border: '1px solid var(--color-border,#e5e7eb)', borderRadius: 10, padding: 12, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <button className="link-btn" style={{ fontWeight: 700 }} onClick={() => navigate(`/invoices/${inv.id}`)}>{inv.number}</button>
            <StatusBadge tone={INVOICE_STATUS_TONE[inv.status] || 'muted'} label={inv.status_display || inv.status} />
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {canCancel && inv.status === 'issued' && (
                <button className="btn btn-ghost btn-sm" disabled={busy} style={{ color: 'var(--color-danger,#dc2626)' }}
                  onClick={() => onCancel?.(inv)}><Ban size={13} /> Cancel</button>
              )}
              {canReverse && ['paid', 'partially_refunded'].includes(inv.status) && (
                <button className="btn btn-ghost btn-sm" disabled={busy} style={{ color: 'var(--color-warning,#d97706)' }}
                  onClick={() => onRefund?.(inv)}><RotateCcw size={13} /> Refund</button>
              )}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 16px', fontSize: 13 }}>
            <span className="muted">Invoice date</span><span style={{ textAlign: 'right' }}>{dt(inv.issued_at)}</span>
            <span className="muted">Amount</span><span style={{ textAlign: 'right' }}><Money amount={inv.total} code={inv.currency} /></span>
            <span className="muted">Outstanding</span><span style={{ textAlign: 'right' }}><Money amount={inv.outstanding} code={inv.currency} /></span>
            {Number(inv.refunded_total) > 0 && (<><span className="muted">Refunded</span><span style={{ textAlign: 'right' }}><Money amount={inv.refunded_total} code={inv.currency} /></span></>)}
            <span className="muted">Billed to</span><span style={{ textAlign: 'right' }}>{inv.bill_to || '-'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => onDownloadInvoice?.(inv)}><FileText size={13} /> Invoice PDF</button>
            {inv.receipt && <button className="btn btn-secondary btn-sm" onClick={() => onDownloadReceipt?.(inv)}><FileText size={13} /> Receipt PDF</button>}
          </div>
          {/* Returns (credit notes) raised against THIS invoice - the refunded
              amount shown against the invoice it reverses. */}
          {(inv.credit_notes || []).length > 0 && (
            <div style={{ marginTop: 10, borderTop: '1px dashed var(--color-border,#e5e7eb)', paddingTop: 8 }}>
              <div className="muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 700, marginBottom: 4 }}>Returns</div>
              {inv.credit_notes.map((cn) => (
                <div key={cn.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 0' }}>
                  <button className="link-btn" style={{ fontWeight: 600 }} onClick={() => navigate(`/credit-notes/${cn.id}`)}>{cn.number}</button>
                  <StatusBadge tone={CN_TONE[cn.status] || 'muted'} label={cn.status_display || cn.status} />
                  <span className="muted">{dt(cn.issued_at || cn.requested_at)}</span>
                  <span style={{ marginLeft: 'auto' }}>Returned <strong><Money amount={cn.total} code={cn.currency || inv.currency} /></strong></span>
                  <button className="btn btn-ghost btn-sm" title="Credit note PDF" onClick={() => onDownloadCreditNote?.(cn)}>
                    <FileText size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {canViewInvoices && onGenerate && !liveInvoice && (
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onGenerate}>
          <FileText size={15} /> {invoices.length ? 'Reissue invoice' : 'Generate invoice'}
        </button>
      )}
      {/* Add-ons added after the first invoice → collect just the outstanding delta. */}
      {canViewInvoices && onCollect && liveInvoice && outstanding > 0 && (
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onCollect}>
          <FileText size={15} /> Collect additional payment (<Money amount={outstanding} code={currency} />)
        </button>
      )}

      {/* ---- Payments (requires payment-view permission) ---- */}
      {canViewPayments && payments.length > 0 && (
        <>
          <SectionLabel>Payments</SectionLabel>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={head}>Date &amp; time</th><th style={head}>Method</th><th style={head}>Reference</th>
                <th style={{ ...head, textAlign: 'right' }}>Amount</th><th style={head}>Status</th><th style={head}>Created by</th>
                <th style={head} aria-label="actions" />
              </tr></thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} style={{ borderTop: '1px solid var(--color-border,#eee)' }}>
                    <td style={cell}>{dt(p.paid_at || p.created_at)}</td>
                    <td style={cell}>{methodLabel(p.method)}</td>
                    <td style={cell}><button className="link-btn" onClick={() => navigate(`/payments/${p.id}`)}>{p.reference}</button></td>
                    <td style={{ ...cell, textAlign: 'right' }}><Money amount={p.amount} code={p.currency} /></td>
                    <td style={cell}><StatusBadge tone={PAY_TONE[p.status] || 'muted'} label={p.status_display || p.status} /></td>
                    <td style={cell}>{p.created_by_name || '-'}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>
                      {(() => {
                        const target = invoices.find((i) => i.payment === p.id);
                        const refundable = canReverse && target && ['paid', 'partially_refunded'].includes(target.status);
                        return refundable ? (
                          <button className="btn btn-ghost btn-sm" disabled={busy}
                            style={{ color: 'var(--color-warning,#d97706)' }}
                            onClick={() => onRefund?.(target)}><RotateCcw size={13} /> Refund</button>
                        ) : null;
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---- Refunds / returns ledger (invoice-side; requires invoice-view) ---- */}
      {canViewInvoices && refunds.length > 0 && (
        <>
          <SectionLabel>Refunds</SectionLabel>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={head}>Date</th><th style={head}>Reference</th><th style={head}>Orig. payment</th>
                <th style={{ ...head, textAlign: 'right' }}>Amount</th><th style={head}>Method</th>
                <th style={head}>Status</th><th style={head}>Reason</th><th style={head}>Processed by</th>
              </tr></thead>
              <tbody>
                {refunds.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--color-border,#eee)' }}>
                    <td style={cell}>{dt(r.created_at)}</td>
                    <td style={cell}>
                      {r.reference}
                      {r.credit_note_number && (
                        <> · {r.credit_note_id
                          ? <button className="link-btn" onClick={() => navigate(`/credit-notes/${r.credit_note_id}`)}>{r.credit_note_number}</button>
                          : r.credit_note_number}</>
                      )}
                    </td>
                    <td style={cell}>
                      {canViewPayments && r.payment
                        ? <button className="link-btn" onClick={() => navigate(`/payments/${r.payment}`)}>{r.payment_reference}</button>
                        : (r.payment_reference || '-')}
                    </td>
                    <td style={{ ...cell, textAlign: 'right' }}><Money amount={r.amount} /></td>
                    <td style={cell}>{methodLabel(r.method)}</td>
                    <td style={cell}><StatusBadge tone={REFUND_TONE[r.status] || 'muted'} label={r.status_display || r.status} /></td>
                    <td style={{ ...cell, whiteSpace: 'normal' }}>{r.reason || '-'}</td>
                    <td style={cell}>{r.created_by_name || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
