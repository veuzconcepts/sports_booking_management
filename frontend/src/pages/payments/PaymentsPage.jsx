import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Download, Wallet as WalletIcon } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toolbar } from '../../components/Toolbar.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { PaymentSuccessModal } from '../../components/PaymentSuccessModal.jsx';

import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
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

export default function PaymentsPage() {
  return (
    <>
      <PageHeader title="Payments" subtitle="Charges, refunds, and wallet top-ups." />
      <PaymentsTab />
    </>
  );
}

/* ----------------------------- Payments tab ----------------------------- */
function PaymentsTab() {
  const navigate = useNavigate();
  const [chargeOpen, setChargeOpen] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [successInvoice, setSuccessInvoice] = useState(null);
  const fetcher = useCallback((q) => paymentsApi.list(q), []);
  const { rows, loading, count, query, setQuery, reload } = useApiList(fetcher);
  const { hasPerm } = useAuth();
  const canCharge = hasPerm('payments.add');
  const canInvoice = hasPerm('invoicing.add');

  async function onCharged(payment) {
    setChargeOpen(false);
    reload();
    if (payment?.status !== 'paid') {
      toast.error('Payment was not captured.');
      return;
    }
    toast.success('Payment captured');
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
      toast.success(`Invoice ${inv.number} downloaded`);
    } catch (e) { toast.error(apiErrorMessage(e, 'Unable to generate the invoice. Please try again.')); }
  }

  return (
    <>
      <Toolbar
        searchValue={query.search}
        onSearchChange={(v) => setQuery({ ...query, search: v || undefined, page: 1 })}
        searchPlaceholder="Reference, customer, booking…"
        filters={[
          { value: query.status, options: PAYMENT_STATUSES, placeholder: 'All statuses',
            onChange: (v) => setQuery({ ...query, status: v, page: 1 }) },
          { value: query.method, options: PAYMENT_METHODS.filter((m) => m.value !== 'membership'),
            placeholder: 'All methods', onChange: (v) => setQuery({ ...query, method: v, page: 1 }) },
        ]}
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            {canCharge && <button className="btn btn-secondary" onClick={() => setTopUpOpen(true)}><WalletIcon size={15} /> Top up wallet</button>}
            {canCharge && <button className="btn btn-primary" onClick={() => setChargeOpen(true)}><Plus size={15} /> Charge booking</button>}
          </div>
        }
      />

      <DataTable
        loading={loading}
        rows={rows}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        onRowClick={(r) => navigate(`/payments/${r.id}`)}
        emptyTitle="No payments yet"
        emptyHint="Charge a completed booking to record a payment."
        columns={[
          { key: 'ref', header: 'Reference', render: (r) => (
            <div>
              <button className="link-btn" style={{ fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}
                onClick={(e) => { e.stopPropagation(); navigate(`/payments/${r.id}`); }}>{r.reference}</button>
              <div className="muted" style={{ fontSize: 12 }}>{r.booking_reference || '-'}</div></div>
          ) },
          { key: 'customer', header: 'Customer', render: (r) => r.customer_name },
          { key: 'method', header: 'Method', render: (r) => <StatusBadge tone="info" label={r.method} /> },
          { key: 'amount', header: 'Amount', render: (r) => (
            <div><Money amount={r.amount} code={r.currency} />
              {Number(r.refunded_amount) > 0 && <div className="muted" style={{ fontSize: 12 }}>- <Money amount={r.refunded_amount} code={r.currency} /> refunded</div>}</div>
          ) },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 'actions', header: '', sticky: 'right', render: (r) => (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              {canInvoice && (
                <button className="icon-btn" title="Invoice PDF" onClick={(e) => { e.stopPropagation(); downloadInvoice(r); }}><Download size={15} /></button>
              )}
            </div>
          ) },
        ]}
      />

      <ChargeModal open={chargeOpen} onClose={() => setChargeOpen(false)} onDone={onCharged} />
      <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)}
        onDone={() => { setTopUpOpen(false); toast.success('Wallet topped up'); }} />

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
    <Modal open={open} onClose={onClose} title="Charge a booking" size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={!bookingId || busy}>{busy ? 'Charging…' : 'Charge'}</button>
      </>}>
      <FormField label="Booking">
        <Select2
          options={bookings.map((b) => ({ value: b.id, label: `${b.reference} - ${b.customer_name} (${fmtMoney(b.total_amount, b.currency)})` }))}
          value={bookingId} onChange={setBookingId} placeholder="Choose a completed booking…"
        />
      </FormField>
      <FormField label="Method">
        <Select2
          options={PAYMENT_METHODS.filter((m) => m.value !== 'membership')}
          value={method} onChange={setMethod}
        />
      </FormField>
    </Modal>
  );
}

function TopUpModal({ open, onClose, onDone }) {
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
    catch (e) { toast.error(apiErrorMessage(e, 'Unable to process the top-up. Please try again.')); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Top up wallet" size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={!customerId || !amount || busy}>Top up</button>
      </>}>
      <FormField label="Customer">
        <Select2
          options={customers.map((c) => ({ value: c.id, label: `${c.full_name} (${c.email})` }))}
          value={customerId} onChange={setCustomerId} placeholder="Choose a customer…"
        />
      </FormField>
      <FormField label="Amount">
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
