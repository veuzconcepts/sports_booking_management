import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate } from '../../services/timeformat.jsx';
import { Download, Check, X, Pencil, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { Money } from '../../services/currency.jsx';
import {
  creditNotesApi, creditNoteStatuses, CREDIT_NOTE_STATUS_TONE, creditNoteStatusLabels,
} from '../../services/paymentsService.js';
import { apiErrorMessage } from '../../utils/apiError';

// Refunds = credit notes raised against invoices - the official refund documents,
// listed alongside Payments and Invoices in the Finance module.
const GROUP_KEYS = [['status', 'creditNotes.groups.status']];

export default function RefundsListPage() {
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const canApprove = hasPerm('invoicing.credit_approve');
  const canEditReason = hasPerm('invoicing.credit');
  const { t } = useTranslation('payments');
  const { t: tc } = useTranslation('common');
  const fetcher = useCallback((q) => creditNotesApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const [confirm, setConfirm] = useState(null);   // { mode:'approve'|'reject', cn }
  const [remarks, setRemarks] = useState('');
  const [reasonFor, setReasonFor] = useState(null);   // credit note whose reason is being edited
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);

  async function saveReason() {
    setBusy(true);
    try {
      await creditNotesApi.updateReason(reasonFor.id, reasonText.trim());
      toast.success(t('reasonUpdated'));
      setReasonFor(null); setReasonText(''); reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUpdateReasonPleaseTry')));
    } finally { setBusy(false); }
  }

  async function download(cn) {
    try {
      const blob = await creditNotesApi.download(cn.id);
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
        await creditNotesApi.approve(confirm.cn.id);
        toast.success(t('refundApprovedMoneyReturned'));
      } else {
        await creditNotesApi.reject(confirm.cn.id, remarks.trim());
        toast.success(t('refundRejected'));
      }
      setConfirm(null); setRemarks(''); reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUpdateRefundPleaseTry')));
    } finally { setBusy(false); }
  }

  const columns = useMemo(() => [
    { key: 'number', header: t('creditNotes.columns.creditNote'), minWidth: 140, alwaysVisible: true,
      render: (r) => <span className="link-btn" style={{ fontWeight: 600 }}>{r.number}</span> },
    { key: 'invoice', header: t('creditNotes.columns.invoice'), minWidth: 130, priority: 'medium',
      render: (r) => r.invoice_number || <span className="muted">-</span> },
    { key: 'customer', header: t('creditNotes.columns.customer'), minWidth: 170, truncate: true,
      render: (r) => r.customer_name || r.bill_to || '-' },
    { key: 'total', header: t('creditNotes.columns.returned'), sortKey: 'total', align: 'right',
      minWidth: 110, nowrap: true,
      render: (r) => <Money amount={r.total} code={r.currency} /> },
    { key: 'reason', header: t('creditNotes.columns.reason'), minWidth: 180, truncate: true,
      priority: 'low',
      render: (r) => <span className="muted">{r.reason || '-'}</span> },
    { key: 'status', header: t('creditNotes.columns.status'), minWidth: 130,
      render: (r) => (
        <StatusBadge tone={CREDIT_NOTE_STATUS_TONE[r.status] || 'muted'}
          label={r.status_display || creditNoteStatusLabels(t)[r.status] || r.status} />
      ) },
    { key: 'date', header: t('creditNotes.columns.date'), sortKey: 'issued_at', minWidth: 120,
      nowrap: true, render: (r) => formatDate(r.issued_at || r.requested_at) },
  ], [t]);

  const groupOptions = useMemo(
    () => GROUP_KEYS.map(([key, k]) => ({ key, label: t(k) })), [t]);

  const filters = useMemo(() => [
    { key: 'status', label: t('creditNotes.filters.status'), type: 'select', options: creditNoteStatuses(t) },
  ], [t]);

  // Approve / reject appear only on a credit note awaiting approval, and only
  // for a user holding the capability. The backend re-checks both.
  const rowActions = useCallback((row) => [
    { key: 'view', label: tc('actions.view'), icon: <Eye size={14} />,
      onClick: () => navigate(`/credit-notes/${row.id}`) },
    { key: 'download', label: t('creditNotes.downloadPdf'), icon: <Download size={14} />,
      onClick: () => download(row) },
    canEditReason && { key: 'reason', label: t('creditNotes.editReason'), icon: <Pencil size={14} />,
      onClick: () => { setReasonText(row.reason || ''); setReasonFor(row); } },
    canApprove && row.status === 'pending_approval' && {
      key: 'approve', label: t('creditNotes.approve'), icon: <Check size={14} />,
      onClick: () => { setRemarks(''); setConfirm({ mode: 'approve', cn: row }); } },
    canApprove && row.status === 'pending_approval' && {
      key: 'reject', label: t('creditNotes.reject'), icon: <X size={14} />, danger: true,
      onClick: () => { setRemarks(''); setConfirm({ mode: 'reject', cn: row }); } },
  ].filter(Boolean), [canApprove, canEditReason, navigate]);

  return (
    <ListPage title={t('refunds')} subtitle={t('creditNotesRefundsRaisedAgainst')}>
      <ListView
        tableKey="credit-notes"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="-issued_at"
        searchPlaceholder={t('creditNotes.searchPlaceholder')}
        emptyTitle={t('creditNotes.emptyTitle')}
        emptyHint={t('creditNotes.emptyHint')}
        onRowClick={(r) => navigate(`/credit-notes/${r.id}`)}
        columns={columns}
        filters={filters}
        groupOptions={groupOptions}
        rowActions={rowActions}
      />

      <ConfirmDialog
        open={Boolean(confirm)} busy={busy}
        tone={confirm?.mode === 'reject' ? 'danger' : 'primary'}
        title={confirm?.mode === 'reject' ? t('rejectRefund2') : t('approveRefund2')}
        confirmLabel={confirm?.mode === 'reject' ? t('common:actions.reject') : t('approveReturnMoney')}
        message={confirm ? (
          <>
            {confirm.mode === 'reject'
              ? <>{t('rejectRefund')} <strong>{confirm.cn.number}</strong>? No money moves. A reason is required.</>
              : <>{t('approveRefund')} <strong>{confirm.cn.number}</strong> for <Money amount={confirm.cn.total} code={confirm.cn.currency} />? The money is returned now.</>}
            {confirm.mode === 'reject' && (
              <input className="form-input" style={{ marginTop: 10 }} placeholder={t('reasonRequired')}
                value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            )}
          </>
        ) : null}
        onConfirm={runConfirm}
        onClose={() => { if (!busy) { setConfirm(null); setRemarks(''); } }}
      />

      {/* Edit the reason note - allowed even after the credit note is posted. */}
      <ConfirmDialog
        open={Boolean(reasonFor)} busy={busy} title={t('editRefundReason')}
        confirmLabel={t('saveReason')}
        message={reasonFor ? (
          <>
            {t('updateReason')} <strong>{reasonFor.number}</strong>. The credit note itself is
            unchanged.
            <textarea className="form-input" style={{ marginTop: 10, minHeight: 70 }}
              placeholder={t('common:labels.reason')} value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
          </>
        ) : null}
        onConfirm={saveReason}
        onClose={() => { if (!busy) { setReasonFor(null); setReasonText(''); } }}
      />
    </ListPage>
  );
}
