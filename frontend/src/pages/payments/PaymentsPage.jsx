import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Download, Eye, Wallet as WalletIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { formatDateTime } from '../../services/timeformat.jsx';
import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { PaymentSuccessModal } from '../../components/PaymentSuccessModal.jsx';

import {
  paymentMethods,
  paymentStatuses,
  invoicesApi,
  receiptsApi,
  paymentsApi,
  walletsApi,
} from '../../services/paymentsService.js';
import { bookingsApi } from '../../services/bookingsService.js';
import { customersApi } from '../../services/customersService.js';
import { apiErrorMessage } from '../../utils/apiError';

import { formatMoney as fmtMoney, Money } from '../../services/currency.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';

const GROUP_KEYS = [
  ['status', 'groups.status'],
  ['method', 'groups.method'],
  ['customer', 'groups.customer'],
];

export default function PaymentsPage() {
  const { t } = useTranslation('payments');
  return (
    <ListPage title={t('title')} subtitle={t('subtitle')}>
      <PaymentsTab />
    </ListPage>
  );
}

/* ----------------------------- Payments tab ----------------------------- */
function PaymentsTab() {
  const navigate = useNavigate();
  const [chargeOpen, setChargeOpen] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [successInvoice, setSuccessInvoice] = useState(null);
  const fetcher = useCallback((q) => paymentsApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const { hasPerm } = useAuth();
  const canCharge = hasPerm('payments.add');
  const canInvoice = hasPerm('invoicing.add');
  const { t } = useTranslation('payments');
  const { t: tc } = useTranslation('common');

  async function onCharged(payment) {
    setChargeOpen(false);
    reload();
    if (payment?.status !== 'paid') {
      toast.error(t('notCaptured'));
      return;
    }
    toast.success(t('paymentCaptured'));
    // Surface the one-time confirmation (invoice + receipt) for the charge.
    try {
      const inv = await paymentsApi.generateInvoice(payment.id);
      setSuccessInvoice(inv);
    } catch { /* invoice fetch is best-effort; payment already captured */ }
  }

  async function downloadInvoice(p) {
    try {
      const inv = await paymentsApi.generateInvoice(p.id);
      const blob = await invoicesApi.download(inv.id);
      triggerDownload(blob, `${inv.number}.pdf`);
      toast.success(t('invoiceDownloaded', { number: inv.number }));
    } catch (e) { toast.error(apiErrorMessage(e, t('invoiceFailed'))); }
  }

  const columns = useMemo(() => [
    { key: 'ref', header: t('columns.reference'), sortKey: 'reference', minWidth: 160,
      alwaysVisible: true,
      render: (r) => (
        <div>
          <span className="link-btn" style={{ fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>
            {r.reference}
          </span>
          <div className="muted" style={{ fontSize: 12 }}>{r.booking_reference || '-'}</div>
        </div>
      ) },
    { key: 'customer', header: t('columns.customer'), minWidth: 170, truncate: true,
      render: (r) => r.customer_name },
    { key: 'method', header: t('columns.method'), sortKey: 'method', minWidth: 110,
      priority: 'medium',
      render: (r) => <StatusBadge tone="info" label={r.method} /> },
    { key: 'amount', header: t('columns.amount'), sortKey: 'amount', align: 'right',
      minWidth: 130, nowrap: true,
      render: (r) => (
        <div>
          <Money amount={r.amount} code={r.currency} />
          {Number(r.refunded_amount) > 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              - <Money amount={r.refunded_amount} code={r.currency} />{' '}
              {t('columns.refundedSuffix')}
            </div>
          )}
        </div>
      ) },
    { key: 'status', header: t('columns.status'), sortKey: 'status', minWidth: 110,
      render: (r) => <StatusBadge status={r.status} /> },
    { key: 'created', header: t('columns.taken'), sortKey: 'created_at', minWidth: 150,
      nowrap: true, priority: 'low',
      render: (r) => formatDateTime(r.created_at) },
  ], [t]);

  const groupOptions = useMemo(
    () => GROUP_KEYS.map(([key, k]) => ({ key, label: t(k) })), [t]);

  const filters = useMemo(() => [
    { key: 'status', label: t('filters.status'), type: 'select', options: paymentStatuses(t) },
    { key: 'method', label: t('filters.method'), type: 'select',
      options: paymentMethods(t).filter((m) => m.value !== 'membership') },
  ], [t]);

  const rowActions = useCallback((row) => [
    { key: 'view', label: tc('actions.view'), icon: <Eye size={14} />,
      onClick: () => navigate(`/payments/${row.id}`) },
    canInvoice && { key: 'invoice', label: t('invoicePdf'), icon: <Download size={14} />,
      onClick: () => downloadInvoice(row) },
  ].filter(Boolean), [canInvoice, navigate]);

  return (
    <>
      <ListView
        tableKey="payments"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="-created_at"
        searchPlaceholder={t('searchPlaceholder')}
        emptyTitle={t('emptyTitle')}
        emptyHint={t('emptyHint')}
        onRowClick={(r) => navigate(`/payments/${r.id}`)}
        columns={columns}
        filters={filters}
        groupOptions={groupOptions}
        rowActions={rowActions}
        toolbarRight={
          <div style={{ display: 'flex', gap: 8 }}>
            {canCharge && <button className="btn btn-secondary" onClick={() => setTopUpOpen(true)}><WalletIcon size={15} /> {t('topUpWallet')}</button>}
            {canCharge && <button className="btn btn-primary" onClick={() => setChargeOpen(true)}><Plus size={15} /> {t('chargeBooking')}</button>}
          </div>
        }
      />

      <ChargeModal open={chargeOpen} onClose={() => setChargeOpen(false)} onDone={onCharged} />
      <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)}
        onDone={() => { setTopUpOpen(false); toast.success(t('walletToppedUp')); }} />

      <PaymentSuccessModal
        open={Boolean(successInvoice)}
        invoice={successInvoice}
        onClose={() => setSuccessInvoice(null)}
        onDownloadInvoice={() => successInvoice && invoicesApi.download(successInvoice.id).then((b) => triggerDownload(b, `${successInvoice.number}.pdf`))}
        onDownloadReceipt={() => successInvoice?.receipt && receiptsApi.download(successInvoice.receipt.id).then((b) => triggerDownload(b, `${successInvoice.receipt.number}.pdf`))}
      />
    </>
  );
}

function ChargeModal({ open, onClose, onDone }) {
  const { t } = useTranslation('payments');
  const [bookings, setBookings] = useState([]);
  const [bookingId, setBookingId] = useState('');
  const [method, setMethod] = useState('card');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    bookingsApi.list({ status: 'completed', page_size: 100 })
      .then((d) => setBookings(d.results || d));
  }, [open]);

  async function submit() {
    if (!bookingId) return;
    setBusy(true);
    try {
      const payment = await paymentsApi.charge({ booking: Number(bookingId), method });
      onDone?.(payment);
    } catch (e) {
      toast.error(apiErrorMessage(e, e.response?.data?.failure_reason || 'Unable to process the charge. Please try again.'));
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('chargeBooking2')} size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={submit} disabled={!bookingId || busy}>{busy ? t('charging') : t('charge')}</button>
      </>}>
      <FormField label={t('booking')}>
        <Select2
          options={bookings.map((b) => ({ value: b.id, label: `${b.reference} - ${b.customer_name} (${fmtMoney(b.total_amount, b.currency)})` }))}
          value={bookingId} onChange={setBookingId} placeholder={t('chooseCompletedBooking')}
        />
      </FormField>
      <FormField label={t('method')}>
        <Select2
          options={paymentMethods(t).filter((m) => m.value !== 'membership')}
          value={method} onChange={setMethod}
        />
      </FormField>
    </Modal>
  );
}

function TopUpModal({ open, onClose, onDone }) {
  const { t } = useTranslation('payments');
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    customersApi.list({ page_size: 100 }).then((d) => setCustomers(d.results || d));
  }, [open]);

  async function submit() {
    if (!customerId || !amount) return;
    setBusy(true);
    try { await walletsApi.topUp(Number(customerId), amount, 'Manual top-up'); onDone?.(); }
    catch (e) { toast.error(apiErrorMessage(e, t('unableProcessTopUpPlease'))); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('topUpWallet')} size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={submit} disabled={!customerId || !amount || busy}>{t('topUp')}</button>
      </>}>
      <FormField label={t('common:labels.customer')}>
        <Select2
          options={customers.map((c) => ({ value: c.id, label: `${c.full_name} (${c.email})` }))}
          value={customerId} onChange={setCustomerId} placeholder={t('chooseCustomer')}
        />
      </FormField>
      <FormField label={t('common:labels.amount')}>
        <input className="form-input" type="number" min="0.01" step="0.01" value={amount}
               onChange={(e) => setAmount(e.target.value)} />
      </FormField>
    </Modal>
  );
}

function triggerDownload(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
