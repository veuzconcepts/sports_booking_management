import { Modal } from './Modal.jsx';
import { InvoiceCard } from './InvoiceCard.jsx';

/**
 * One-time confirmation shown immediately after a payment succeeds. Reuses the
 * InvoiceCard summary (no refund/cancel actions) - purely a payment confirmation
 * with download links. It is action-triggered, never rendered on booking load.
 */
export function PaymentSuccessModal({ open, invoice, onClose, onDownloadInvoice, onDownloadReceipt }) {
  if (!invoice) return null;
  return (
    <Modal
      open={open} onClose={onClose} title="Payment confirmed" size="md"
      footer={<button className="btn btn-secondary" type="button" onClick={onClose}>Close</button>}
    >
      <InvoiceCard
        invoice={invoice}
        showActions={false}
        onDownloadInvoice={onDownloadInvoice}
        onDownloadReceipt={onDownloadReceipt}
      />
    </Modal>
  );
}
