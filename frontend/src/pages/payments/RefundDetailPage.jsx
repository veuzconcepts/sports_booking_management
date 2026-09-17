import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Check, X, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { Money } from '../../services/currency.jsx';
import { formatDateTime } from '../../services/timeformat.jsx';
import { creditNotesApi, CREDIT_NOTE_STATUS_TONE, creditNoteStatusLabels } from '../../services/paymentsService.js';
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
  const { t } = useTranslation('payments');
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
    catch (e) { toast.error(apiErrorMessage(e, t('unableLoadRefundPleaseTry'))); }
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
    } catch (e) { toast.error(apiErrorMessage(e, t('unableDownloadCreditNotePlease'))); }
  }

  async function runConfirm() {
    if (confirm.mode === 'reject' && !remarks.trim()) {
      toast.error(t('reasonRequiredRejectRefund'));
      return;
    }
    setBusy(true);
    try {
      if (confirm.mode === 'approve') {
        await creditNotesApi.approve(cn.id);
        toast.success(t('refundApprovedMoneyReturned'));
      } else {
        await creditNotesApi.reject(cn.id, remarks.trim());
        toast.success(t('refundRejected'));
      }
      setConfirm(null); setRemarks(''); load();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUpdateRefundPleaseTry')));
    } finally { setBusy(false); }
  }

  async function saveReason() {
    setBusy(true);
    try {
      await creditNotesApi.updateReason(cn.id, reasonText.trim());
      toast.success(t('reasonUpdated'));
      setReasonOpen(false); load();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUpdateReasonPleaseTry')));
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
        <ArrowLeft size={15} /> {t('backRefunds')}
      </button>

      <PageHeader
        title={cn.number}
        subtitle={t('creditNoteRefundDocument')}
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={download}><Download size={15} /> {t('invoicePdf')}</button>
            {canEditReason && (
              <button className="btn btn-secondary" onClick={() => { setReasonText(cn.reason || ''); setReasonOpen(true); }}>
                <Pencil size={15} /> {t('editReason')}
              </button>
            )}
            {canApprove && pending && (
              <>
                <button className="btn btn-primary" onClick={() => { setRemarks(''); setConfirm({ mode: 'approve' }); }}>
                  <Check size={15} /> {t('common:actions.approve')}
                </button>
                <button className="btn btn-secondary" style={{ color: 'var(--color-danger,#dc2626)' }}
                  onClick={() => { setRemarks(''); setConfirm({ mode: 'reject' }); }}>
                  <X size={15} /> {t('common:actions.reject')}
                </button>
              </>
            )}
          </div>
        }
      />

      {pending && (
        <div className="alert alert-warning" style={{ marginBottom: 12 }} role="alert">
          <strong>{t('awaitingApproval')}</strong> {t('noMoneyHasMovedYet')}
        </div>
      )}

      <div className="row">
        <div className="col" style={{ flex: '1 1 320px' }}>
          <div className="card"><div className="card-body">
            <h3 className="card-title" style={{ marginBottom: 8 }}>{t('refund')}</h3>
            <Row label={t('common:labels.status')}><StatusBadge tone={CREDIT_NOTE_STATUS_TONE[cn.status] || 'muted'}
              label={cn.status_display || creditNoteStatusLabels(t)[cn.status] || cn.status} /></Row>
            <Row label={t('amountReturned')}><Money amount={cn.total} code={cn.currency} /></Row>
            <Row label={t('subtotal')}><Money amount={cn.subtotal} code={cn.currency} /></Row>
            <Row label={t('vatTax')}><Money amount={cn.tax_amount} code={cn.currency} /></Row>
            <Row label={t('method')}>{cn.method || '-'}</Row>
            <Row label={t('common:labels.reason')}>{cn.reason || '-'}</Row>
          </div></div>
        </div>
        <div className="col" style={{ flex: '1 1 320px' }}>
          <div className="card"><div className="card-body">
            <h3 className="card-title" style={{ marginBottom: 8 }}>{t('againstInvoice')}</h3>
            <Row label={t('invoice')}>
              {cn.invoice ? (
                <button className="link-btn" onClick={() => navigate(`/invoices/${cn.invoice}`)}>
                  {cn.invoice_number}
                </button>
              ) : (cn.invoice_number || '-')}
            </Row>
            <Row label={t('paymentReceipt')}>
              {cn.payment ? (
                <button className="link-btn" onClick={() => navigate(`/payments/${cn.payment}`)}>
                  {cn.payment_reference || 'View payment'}
                </button>
              ) : '-'}
            </Row>
            <Row label={t('booking')}>
              {cn.booking ? (
                <button className="link-btn" onClick={() => navigate(`/bookings/${cn.booking}`)}>
                  {cn.booking_reference || 'View booking'}
                </button>
              ) : '-'}
            </Row>
            <Row label={t('common:labels.customer')}>{cn.customer_name || cn.bill_to || '-'}</Row>
          </div></div>
          <div style={{ height: 16 }} />
          <div className="card"><div className="card-body">
            <h3 className="card-title" style={{ marginBottom: 8 }}>{t('approvalTrail')}</h3>
            <Row label={t('requested')}>{cn.requested_by_name || '-'}</Row>
            <Row label={t('requested2')}>{dt(cn.requested_at)}</Row>
            {cn.status === 'issued' && <Row label={t('approved')}>{cn.approved_by_name || '-'}</Row>}
            {cn.status === 'issued' && <Row label={t('issued')}>{dt(cn.issued_at)}</Row>}
            {cn.status === 'rejected' && <Row label={t('rejected')}>{cn.rejected_by_name || '-'}</Row>}
            {cn.status === 'rejected' && <Row label={t('rejected2')}>{dt(cn.rejected_at)}</Row>}
            {cn.status === 'rejected' && <Row label={t('rejectionReason')}>{cn.remarks || '-'}</Row>}
          </div></div>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirm)} busy={busy}
        tone={confirm?.mode === 'reject' ? 'danger' : 'primary'}
        title={confirm?.mode === 'reject' ? t('rejectRefund2') : t('approveRefund2')}
        confirmLabel={confirm?.mode === 'reject' ? t('common:actions.reject') : t('approveReturnMoney')}
        message={confirm ? (
          <>
            {confirm.mode === 'reject'
              ? <>{t('rejectRefund')} <strong>{cn.number}</strong>? No money moves. A reason is required.</>
              : <>{t('approveRefund')} <strong>{cn.number}</strong> for <Money amount={cn.total} code={cn.currency} />? The money is returned now.</>}
            {confirm.mode === 'reject' && (
              <textarea className="form-input" style={{ marginTop: 10, minHeight: 70 }} placeholder={t('reasonRequired')}
                value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            )}
          </>
        ) : null}
        onConfirm={runConfirm}
        onClose={() => { if (!busy) { setConfirm(null); setRemarks(''); } }}
      />

      <ConfirmDialog
        open={reasonOpen} busy={busy} title={t('editRefundReason')} confirmLabel={t('saveReason')}
        message={(
          <>
            {t('updateReason')} <strong>{cn.number}</strong>. The credit note itself is unchanged.
            <textarea className="form-input" style={{ marginTop: 10, minHeight: 70 }} placeholder={t('common:labels.reason')}
              value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
          </>
        )}
        onConfirm={saveReason}
        onClose={() => { if (!busy) setReasonOpen(false); }}
      />
    </>
  );
}
