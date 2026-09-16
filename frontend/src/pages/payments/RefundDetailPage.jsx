import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Check, X, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { Money } from '../../services/currency.jsx';
import { formatDateTime } from '../../services/timeformat.jsx';
import { creditNotesApi, CREDIT_NOTE_STATUS_TONE, CREDIT_NOTE_STATUS_LABELS } from '../../services/paymentsService.js';
import { apiErrorMessage } from '../../utils/apiError';

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '5px 0', fontSize: 14 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 500, textAlign: 'right' }}>{children}</span>
    </div>
  );
}
const dt = (x) => (x ? formatDateTime(x) : '-');

// A refund's own page: full credit-note detail + approve / reject (reason mandatory).
// Deep-linked from the approval notification so an approver lands straight here.
export default function RefundDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const canApprove = hasPerm('invoicing.credit_approve');
  const canEditReason = hasPerm('invoicing.credit');

  const [cn, setCn] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState(null);   // { mode:'approve'|'reject' }
  const [remarks, setRemarks] = useState('');
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setCn(await creditNotesApi.get(id)); }
    catch (e) { toast.error(apiErrorMessage(e, 'Unable to load the refund. Please try again.')); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function download() {
    try {
      const blob = await creditNotesApi.download(id);
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
        await creditNotesApi.approve(cn.id);
        toast.success('Refund approved - money returned');
      } else {
        await creditNotesApi.reject(cn.id, remarks.trim());
        toast.success('Refund rejected');
      }
      setConfirm(null); setRemarks(''); load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to update the refund. Please try again.'));
    } finally { setBusy(false); }
  }

  async function saveReason() {
    setBusy(true);
    try {
      await creditNotesApi.updateReason(cn.id, reasonText.trim());
      toast.success('Reason updated');
      setReasonOpen(false); load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to update the reason. Please try again.'));
    } finally { setBusy(false); }
  }

  if (loading) {
    return <div className="card"><div className="card-body center" style={{ padding: 64 }}><span className="muted">Loading refund…</span></div></div>;
  }
  if (!cn) return null;
  const pending = cn.status === 'pending_approval';

  return (
    <>
      <button className="btn btn-ghost" onClick={() => navigate('/credit-notes')} style={{ marginBottom: 12 }}>
        <ArrowLeft size={15} /> Back to refunds
      </button>

      <PageHeader
        title={cn.number}
        subtitle="Credit note (refund document)"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={download}><Download size={15} /> Invoice PDF</button>
            {canEditReason && (
              <button className="btn btn-secondary" onClick={() => { setReasonText(cn.reason || ''); setReasonOpen(true); }}>
                <Pencil size={15} /> Edit reason
              </button>
            )}
            {canApprove && pending && (
              <>
                <button className="btn btn-primary" onClick={() => { setRemarks(''); setConfirm({ mode: 'approve' }); }}>
                  <Check size={15} /> Approve
                </button>
                <button className="btn btn-secondary" style={{ color: 'var(--color-danger,#dc2626)' }}
                  onClick={() => { setRemarks(''); setConfirm({ mode: 'reject' }); }}>
                  <X size={15} /> Reject
                </button>
              </>
            )}
          </div>
        }
      />

      {pending && (
        <div className="alert alert-warning" style={{ marginBottom: 12 }} role="alert">
          <strong>Awaiting approval.</strong> No money has moved yet - approve to return it, or reject with a reason.
        </div>
      )}

      <div className="row">
        <div className="col" style={{ flex: '1 1 320px' }}>
          <div className="card"><div className="card-body">
            <h3 className="card-title" style={{ marginBottom: 8 }}>Refund</h3>
            <Row label="Status"><StatusBadge tone={CREDIT_NOTE_STATUS_TONE[cn.status] || 'muted'}
              label={cn.status_display || CREDIT_NOTE_STATUS_LABELS[cn.status] || cn.status} /></Row>
            <Row label="Amount returned"><Money amount={cn.total} code={cn.currency} /></Row>
            <Row label="Subtotal"><Money amount={cn.subtotal} code={cn.currency} /></Row>
            <Row label="VAT / Tax"><Money amount={cn.tax_amount} code={cn.currency} /></Row>
            <Row label="Method">{cn.method || '-'}</Row>
            <Row label="Reason">{cn.reason || '-'}</Row>
          </div></div>
        </div>
        <div className="col" style={{ flex: '1 1 320px' }}>
          <div className="card"><div className="card-body">
            <h3 className="card-title" style={{ marginBottom: 8 }}>Against invoice</h3>
            <Row label="Invoice">
              {cn.invoice ? (
                <button className="link-btn" onClick={() => navigate(`/invoices/${cn.invoice}`)}>
                  {cn.invoice_number}
                </button>
              ) : (cn.invoice_number || '-')}
            </Row>
            <Row label="Payment / receipt">
              {cn.payment ? (
                <button className="link-btn" onClick={() => navigate(`/payments/${cn.payment}`)}>
                  {cn.payment_reference || 'View payment'}
                </button>
              ) : '-'}
            </Row>
            <Row label="Booking">
              {cn.booking ? (
                <button className="link-btn" onClick={() => navigate(`/bookings/${cn.booking}`)}>
                  {cn.booking_reference || 'View booking'}
                </button>
              ) : '-'}
            </Row>
            <Row label="Customer">{cn.customer_name || cn.bill_to || '-'}</Row>
          </div></div>
          <div style={{ height: 16 }} />
          <div className="card"><div className="card-body">
            <h3 className="card-title" style={{ marginBottom: 8 }}>Approval trail</h3>
            <Row label="Requested by">{cn.requested_by_name || '-'}</Row>
            <Row label="Requested at">{dt(cn.requested_at)}</Row>
            {cn.status === 'issued' && <Row label="Approved by">{cn.approved_by_name || '-'}</Row>}
            {cn.status === 'issued' && <Row label="Issued at">{dt(cn.issued_at)}</Row>}
            {cn.status === 'rejected' && <Row label="Rejected by">{cn.rejected_by_name || '-'}</Row>}
            {cn.status === 'rejected' && <Row label="Rejected at">{dt(cn.rejected_at)}</Row>}
            {cn.status === 'rejected' && <Row label="Rejection reason">{cn.remarks || '-'}</Row>}
          </div></div>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirm)} busy={busy}
        tone={confirm?.mode === 'reject' ? 'danger' : 'primary'}
        title={confirm?.mode === 'reject' ? 'Reject refund?' : 'Approve refund?'}
        confirmLabel={confirm?.mode === 'reject' ? 'Reject' : 'Approve & return money'}
        message={confirm ? (
          <>
            {confirm.mode === 'reject'
              ? <>Reject refund <strong>{cn.number}</strong>? No money moves. A reason is required.</>
              : <>Approve refund <strong>{cn.number}</strong> for <Money amount={cn.total} code={cn.currency} />? The money is returned now.</>}
            {confirm.mode === 'reject' && (
              <textarea className="form-input" style={{ marginTop: 10, minHeight: 70 }} placeholder="Reason (required)"
                value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            )}
          </>
        ) : null}
        onConfirm={runConfirm}
        onClose={() => { if (!busy) { setConfirm(null); setRemarks(''); } }}
      />

      <ConfirmDialog
        open={reasonOpen} busy={busy} title="Edit refund reason" confirmLabel="Save reason"
        message={(
          <>
            Update the reason on <strong>{cn.number}</strong>. The credit note itself is unchanged.
            <textarea className="form-input" style={{ marginTop: 10, minHeight: 70 }} placeholder="Reason"
              value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
          </>
        )}
        onConfirm={saveReason}
        onClose={() => { if (!busy) setReasonOpen(false); }}
      />
    </>
  );
}
