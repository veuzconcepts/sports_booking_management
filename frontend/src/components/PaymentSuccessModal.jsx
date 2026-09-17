import { Modal } from './Modal.jsx';
import { useTranslation } from 'react-i18next';
import { InvoiceCard } from './InvoiceCard.jsx';

/**
 * One-time confirmation shown immediately after a payment succeeds. Reuses the
 * InvoiceCard summary (no refund/cancel actions) - purely a payment confirmation
 * with download links. It is action-triggered, never rendered on booking load.
 */
export function PaymentSuccessModal({ open, invoice, onClose, onDownloadInvoice, onDownloadReceipt }) {
  const { t } = useTranslation('payments');
  if (!invoice) return null;
  return (
    <Modal
      open={open} onClose={onClose} title={t('paymentConfirmed')} size="md"
      footer={<button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.close')}</button>}
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
