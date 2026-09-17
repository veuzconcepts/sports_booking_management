import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../services/timeformat.jsx';
import {
  FileText, CheckCircle2, Clock, Ban, RotateCcw, ChevronRight, ChevronDown,
} from 'lucide-react';

import { Money } from '../services/currency.jsx';

// Status -> headline + icon tint for the summary card.
const statusMeta = (t) => ({
  paid:                { title: t('invoicePaid'),       tone: 'green',  Icon: CheckCircle2 },
  issued:              { title: t('invoiceIssued'),     tone: 'amber',  Icon: Clock },
  partially_refunded:  { title: t('partiallyRefunded'), tone: 'amber',  Icon: RotateCcw },
  refunded:            { title: t('refunded'),           tone: 'rose',   Icon: RotateCcw },
  cancelled:           { title: t('invoiceCancelled'),  tone: 'rose',   Icon: Ban },
});
const TINTS = {
  green: { fg: '#059669', bg: '#d1fae5' },
  amber: { fg: '#d97706', bg: '#fef3c7' },
  rose:  { fg: '#e11d48', bg: '#ffe4e6' },
};

const METHOD_LABELS = {
  card: 'Card', cash: 'Cash', wallet: 'Wallet', membership: 'Membership',
  online: 'Online', bank_transfer: 'Bank transfer',
};
const methodLabel = (m) => METHOD_LABELS[m] || (m ? m.replace(/_/g, ' ') : '-');
const fmtDate = (d) => (d ? formatDate(d) : '-');

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: 14 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 500, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

/**
 * Payment + invoice summary, styled like a hosted-invoice receipt card.
 * Adapts to the invoice status (paid / issued / credited / cancelled).
 */
export function InvoiceCard({
  invoice, onDownloadInvoice, onDownloadReceipt, onDownloadCreditNote,
  onCancel, onCredit, canReverse = false, busy = false, showActions = true,
}) {
  const { t } = useTranslation('payments');
  const [open, setOpen] = useState(false);
  const inv = invoice;
  const receipt = inv.receipt;
  const paid = inv.status === 'paid' || Boolean(receipt);
  const meta = statusMeta(t)[inv.status] || { title: inv.status_display || inv.status, tone: 'amber', Icon: FileText };
  const palette = TINTS[meta.tone] || TINTS.amber;
  const creditNotes = inv.credit_notes || [];

  return (
    <div style={{
      border: '1px solid var(--color-border,#e5e7eb)', borderRadius: 14,
      padding: '22px 22px 18px', background: 'var(--color-surface,#fff)',
      maxWidth: 460, margin: '0 auto',
    }}>
      {/* Icon with status check */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
        <div style={{ position: 'relative' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 12, background: 'var(--color-bg-muted,#f3f4f6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted,#6b7280)',
          }}>
            <FileText size={26} />
          </div>
          <div style={{
            position: 'absolute', right: -6, bottom: -6, width: 24, height: 24, borderRadius: '50%',
            background: palette.bg, color: palette.fg, display: 'flex', alignItems: 'center',
            justifyContent: 'center', border: '2px solid var(--color-surface,#fff)',
          }}>
            <meta.Icon size={14} />
          </div>
        </div>
      </div>

      {/* Status + amount */}
      <div style={{ textAlign: 'center' }}>
        <div className="muted" style={{ fontSize: 14 }}>{meta.title}</div>
        <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-0.02em', margin: '2px 0 6px' }}>
          <Money amount={inv.total} code={inv.currency} />
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted,#6b7280)',
            fontSize: 13.5, display: 'inline-flex', alignItems: 'center', gap: 2, padding: 0,
          }}>
          View invoice and payment details {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>

      <div style={{ borderTop: '1px solid var(--color-border,#e5e7eb)', margin: '16px 0 8px' }} />

      {/* Meta */}
      <Row label={t('invoiceNumber')} value={inv.number} />
      <Row label={paid ? t('paymentDate') : t('issued2')} value={fmtDate(receipt?.issued_at || inv.issued_at)} />
      {paid && <Row label={t('paymentMethod')} value={methodLabel(receipt?.method)} />}
      <Row label={t('billed')} value={inv.bill_to || inv.customer_name || 'Walk-in customer'} />

      {open && (
        <>
          <div style={{ borderTop: '1px dashed var(--color-border,#e5e7eb)', margin: '8px 0' }} />
          <Row label={t('subtotal')} value={<Money amount={inv.subtotal} code={inv.currency} />} />
          <Row label={`VAT (${Math.round(Number(inv.tax_rate) * 100)}%)`} value={<Money amount={inv.tax_amount} code={inv.currency} />} />
          <Row label={t('common:labels.total')} value={<Money amount={inv.total} code={inv.currency} />} />
          {Number(inv.refunded_total) > 0 && (
            <Row label={t('refunded')} value={<Money amount={inv.refunded_total} code={inv.currency} />} />
          )}
          {creditNotes.map((cn) => (
            <div key={cn.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '3px 0' }}>
              <span className="muted">Credit note {cn.number}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => onDownloadCreditNote?.(cn)}>
                <FileText size={13} /> PDF
              </button>
            </div>
          ))}
        </>
      )}

      {/* Download buttons */}
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onDownloadInvoice}>
          <FileText size={15} /> {t('downloadInvoice')}
        </button>
        {receipt && (
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={onDownloadReceipt}>
            <FileText size={15} /> {t('downloadReceipt')}
          </button>
        )}
      </div>

      {/* Staff reversal actions */}
      {showActions && canReverse && (inv.status === 'issued' || ['paid', 'partially_refunded'].includes(inv.status)) && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 14, marginTop: 12 }}>
          {inv.status === 'issued' && (
            <button className="btn btn-ghost btn-sm" disabled={busy}
              style={{ color: 'var(--color-danger,#dc2626)' }} onClick={onCancel}>
              <Ban size={14} /> {t('common:actions.cancel')}
            </button>
          )}
          {['paid', 'partially_refunded'].includes(inv.status) && (
            <button className="btn btn-ghost btn-sm" disabled={busy}
              style={{ color: 'var(--color-warning,#d97706)' }} onClick={onCredit}>
              <RotateCcw size={14} /> {t('refund')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
