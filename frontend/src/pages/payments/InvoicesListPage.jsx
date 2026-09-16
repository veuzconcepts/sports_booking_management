import { useCallback, useState } from 'react';
import { formatDate } from '../../services/timeformat.jsx';
import { Download, Ban } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toolbar } from '../../components/Toolbar.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { Money } from '../../services/currency.jsx';
import { invoicesApi, INVOICE_STATUSES, INVOICE_STATUS_TONE } from '../../services/paymentsService.js';
import { apiErrorMessage } from '../../utils/apiError';

export default function InvoicesListPage() {
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const canCancel = hasPerm('invoicing.cancel_invoice');
  const fetcher = useCallback((q) => invoicesApi.list(q), []);
  const { rows, loading, count, query, setQuery, reload } = useApiList(fetcher);
  const [toCancel, setToCancel] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function download(inv) {
    try {
      const blob = await invoicesApi.download(inv.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${inv.number}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error(apiErrorMessage(e, 'Unable to download the invoice. Please try again.')); }
  }

  async function runCancel() {
    setBusy(true);
    try {
      await invoicesApi.cancel(toCancel.id, reason.trim());
      toast.success('Invoice cancelled');
      setToCancel(null); setReason(''); reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to cancel the invoice. Please try again.'));
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Invoices" subtitle="VAT invoices, receipts & credit notes from bookings & payments." />

      <Toolbar
        searchValue={query.search || ''}
        onSearchChange={(v) => setQuery({ ...query, search: v, page: 1 })}
        searchPlaceholder="Search invoice # / customer / booking…"
        filters={[
          {
            value: query.status || '', placeholder: 'All statuses',
            options: INVOICE_STATUSES,
            onChange: (v) => setQuery({ ...query, status: v, page: 1 }),
          },
        ]}
      />

      <DataTable
        loading={loading}
        rows={rows}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        onRowClick={(r) => navigate(`/invoices/${r.id}`)}
        emptyTitle="No invoices yet"
        emptyHint="Generate an invoice from a booking's detail page."
        columns={[
          { key: 'number', header: 'Invoice', render: (r) => (
            <button className="link-btn" style={{ fontWeight: 600 }}
              onClick={(e) => { e.stopPropagation(); navigate(`/invoices/${r.id}`); }}>{r.number}</button>
          ) },
          { key: 'customer', header: 'Customer', render: (r) => r.customer_name || r.bill_to || '-' },
          { key: 'booking', header: 'Booking', render: (r) => r.booking_reference || <span className="muted">-</span> },
          { key: 'total', header: 'Total', render: (r) => <Money amount={r.total} code={r.currency} /> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge tone={INVOICE_STATUS_TONE[r.status] || 'muted'} label={r.status_display || r.status} /> },
          { key: 'issued', header: 'Issued', render: (r) => formatDate(r.issued_at) },
          {
            key: 'actions', header: '', sticky: 'right', render: (r) => (
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button className="icon-btn" title="Download PDF"
                  onClick={(e) => { e.stopPropagation(); download(r); }}><Download size={15} /></button>
                {canCancel && r.status === 'issued' && (
                  <button className="icon-btn" title="Cancel (unpaid)" style={{ color: 'var(--color-danger,#dc2626)' }}
                    onClick={(e) => { e.stopPropagation(); setToCancel(r); setReason(''); }}><Ban size={15} /></button>
                )}
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={Boolean(toCancel)} busy={busy} tone="danger" title="Cancel invoice?" confirmLabel="Cancel invoice"
        message={toCancel ? (
          <>
            Cancel unpaid invoice <strong>{toCancel.number}</strong>? The record is kept for audit.
            <input className="form-input" style={{ marginTop: 10 }} placeholder="Reason (optional)"
              value={reason} onChange={(e) => setReason(e.target.value)} />
          </>
        ) : null}
        onConfirm={runCancel}
        onClose={() => { if (!busy) { setToCancel(null); setReason(''); } }}
      />
    </>
  );
}
