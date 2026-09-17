import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate } from '../../services/timeformat.jsx';
import { Download, Check, X, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toolbar } from '../../components/Toolbar.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { Money } from '../../services/currency.jsx';
import {
  creditNotesApi, CREDIT_NOTE_STATUSES, CREDIT_NOTE_STATUS_TONE, CREDIT_NOTE_STATUS_LABELS,
} from '../../services/paymentsService.js';
import { apiErrorMessage } from '../../utils/apiError';

// Refunds = credit notes raised against invoices - the official refund documents,
// listed alongside Payments and Invoices in the Finance module.
export default function RefundsListPage() {
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const canApprove = hasPerm('invoicing.credit_approve');
  const canEditReason = hasPerm('invoicing.credit');
  const fetcher = useCallback((q) => creditNotesApi.list(q), []);
  const { rows, loading, count, query, setQuery, reload } = useApiList(fetcher);
  const [confirm, setConfirm] = useState(null);   // { mode:'approve'|'reject', cn }
  const [remarks, setRemarks] = useState('');
  const [reasonFor, setReasonFor] = useState(null);   // credit note whose reason is being edited
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);

  async function saveReason() {
    setBusy(true);
    try {
      await creditNotesApi.updateReason(reasonFor.id, reasonText.trim());
      toast.success('Reason updated');
      setReasonFor(null); setReasonText(''); reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to update the reason. Please try again.'));
    } finally { setBusy(false); }
  }

  async function download(cn) {
    try {
      const blob = await creditNotesApi.download(cn.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${cn.number}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error(apiErrorMessage(e, 'Unable to download the credit note. Please try again.')); }
  }

  async function runConfirm() {
    if (confirm.mode === 'reject' && !remarks.trim()) {
      toast.error('A reason is required to reject a refund.');
      return;
    }
    setBusy(true);
    try {
      if (confirm.mode === 'approve') {
        await creditNotesApi.approve(confirm.cn.id);
        toast.success('Refund approved - money returned');
      } else {
        await creditNotesApi.reject(confirm.cn.id, remarks.trim());
        toast.success('Refund rejected');
      }
      setConfirm(null); setRemarks(''); reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to update the refund. Please try again.'));
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Refunds" subtitle="Credit notes (refunds) raised against invoices." />

      <Toolbar
        searchValue={query.search || ''}
        onSearchChange={(v) => setQuery({ ...query, search: v, page: 1 })}
        searchPlaceholder="Search credit note # / invoice / customer…"
        filters={[{
          value: query.status || '', placeholder: 'All statuses',
          options: CREDIT_NOTE_STATUSES,
          onChange: (v) => setQuery({ ...query, status: v, page: 1 }),
        }]}
      />

      <DataTable
        loading={loading}
        rows={rows}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        onRowClick={(r) => navigate(`/credit-notes/${r.id}`)}
        emptyTitle="No refunds yet"
        emptyHint="Refund a paid invoice from its booking or invoice page to raise a credit note."
        columns={[
          { key: 'number', header: 'Credit note', render: (r) => (
            <button className="link-btn" style={{ fontWeight: 600 }}
              onClick={(e) => { e.stopPropagation(); navigate(`/credit-notes/${r.id}`); }}>{r.number}</button>
          ) },
          { key: 'invoice', header: 'Invoice', render: (r) => r.invoice_number || <span className="muted">-</span> },
          { key: 'customer', header: 'Customer', render: (r) => r.customer_name || r.bill_to || '-' },
          { key: 'total', header: 'Returned', render: (r) => <Money amount={r.total} code={r.currency} /> },
          { key: 'reason', header: 'Reason', render: (r) => <span className="muted" style={{ whiteSpace: 'normal' }}>{r.reason || '-'}</span> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge tone={CREDIT_NOTE_STATUS_TONE[r.status] || 'muted'} label={r.status_display || CREDIT_NOTE_STATUS_LABELS[r.status] || r.status} /> },
          { key: 'date', header: 'Date', render: (r) => formatDate(r.issued_at || r.requested_at) },
          {
            key: 'actions', header: '', sticky: 'right', render: (r) => (
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button className="icon-btn" title="Download PDF"
                  onClick={(e) => { e.stopPropagation(); download(r); }}><Download size={15} /></button>
                {canEditReason && (
                  <button className="icon-btn" title="Edit reason"
                    onClick={(e) => { e.stopPropagation(); setReasonText(r.reason || ''); setReasonFor(r); }}><Pencil size={15} /></button>
                )}
                {canApprove && r.status === 'pending_approval' && (
                  <>
                    <button className="icon-btn" title="Approve refund" style={{ color: 'var(--color-success,#10b981)' }}
                      onClick={(e) => { e.stopPropagation(); setRemarks(''); setConfirm({ mode: 'approve', cn: r }); }}><Check size={15} /></button>
                    <button className="icon-btn" title="Reject refund" style={{ color: 'var(--color-danger,#dc2626)' }}
                      onClick={(e) => { e.stopPropagation(); setRemarks(''); setConfirm({ mode: 'reject', cn: r }); }}><X size={15} /></button>
                  </>
                )}
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={Boolean(confirm)} busy={busy}
        tone={confirm?.mode === 'reject' ? 'danger' : 'primary'}
        title={confirm?.mode === 'reject' ? 'Reject refund?' : 'Approve refund?'}
        confirmLabel={confirm?.mode === 'reject' ? 'Reject' : 'Approve & return money'}
        message={confirm ? (
          <>
            {confirm.mode === 'reject'
              ? <>Reject refund <strong>{confirm.cn.number}</strong>? No money moves. A reason is required.</>
              : <>Approve refund <strong>{confirm.cn.number}</strong> for <Money amount={confirm.cn.total} code={confirm.cn.currency} />? The money is returned now.</>}
            {confirm.mode === 'reject' && (
              <input className="form-input" style={{ marginTop: 10 }} placeholder="Reason (required)"
                value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            )}
          </>
        ) : null}
        onConfirm={runConfirm}
        onClose={() => { if (!busy) { setConfirm(null); setRemarks(''); } }}
      />

      {/* Edit the reason note - allowed even after the credit note is posted. */}
      <ConfirmDialog
        open={Boolean(reasonFor)} busy={busy} title="Edit refund reason"
        confirmLabel="Save reason"
        message={reasonFor ? (
          <>
            Update the reason on <strong>{reasonFor.number}</strong>. The credit note itself is
            unchanged.
            <textarea className="form-input" style={{ marginTop: 10, minHeight: 70 }}
              placeholder="Reason" value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
          </>
        ) : null}
        onConfirm={saveReason}
        onClose={() => { if (!busy) { setReasonFor(null); setReasonText(''); } }}
      />
    </>
  );
}
