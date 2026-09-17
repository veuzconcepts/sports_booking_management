import { useCallback, useMemo, useState } from 'react';
import { formatDate } from '../../services/timeformat.jsx';
import { Download, Ban, Eye } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { Money } from '../../services/currency.jsx';
import { invoicesApi, invoiceStatuses, INVOICE_STATUS_TONE } from '../../services/paymentsService.js';
import { apiErrorMessage } from '../../utils/apiError';

const GROUP_KEYS = [
  ['status', 'invoices.groups.status'],
  ['customer', 'invoices.groups.customer'],
];

export default function InvoicesListPage() {
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const canCancel = hasPerm('invoicing.cancel_invoice');
  const { t } = useTranslation('payments');
  const { t: tc } = useTranslation('common');
  const fetcher = useCallback((q) => invoicesApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
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
    } catch (e) { toast.error(apiErrorMessage(e, t('invoices.downloadFailed'))); }
  }

  async function runCancel() {
    setBusy(true);
    try {
      await invoicesApi.cancel(toCancel.id, reason.trim());
      toast.success(t('invoices.cancelled'));
      setToCancel(null); setReason(''); reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('invoices.cancelFailed')));
    } finally { setBusy(false); }
  }

  const columns = useMemo(() => [
    { key: 'number', header: t('invoices.columns.invoice'), minWidth: 130, alwaysVisible: true,
      render: (r) => <span className="link-btn" style={{ fontWeight: 600 }}>{r.number}</span> },
    { key: 'customer', header: t('invoices.columns.customer'), minWidth: 170, truncate: true,
      render: (r) => r.customer_name || r.bill_to || '-' },
    { key: 'booking', header: t('invoices.columns.booking'), minWidth: 130, priority: 'medium',
      render: (r) => r.booking_reference || <span className="muted">-</span> },
    { key: 'total', header: t('invoices.columns.total'), sortKey: 'total', align: 'right',
      minWidth: 110, nowrap: true,
      render: (r) => <Money amount={r.total} code={r.currency} /> },
    { key: 'status', header: t('invoices.columns.status'), minWidth: 110,
      render: (r) => (
        <StatusBadge tone={INVOICE_STATUS_TONE[r.status] || 'muted'}
          label={r.status_display || r.status} />
      ) },
    { key: 'issued', header: t('invoices.columns.issued'), sortKey: 'issued_at', minWidth: 120,
      nowrap: true, render: (r) => formatDate(r.issued_at) },
  ], [t]);

  const groupOptions = useMemo(
    () => GROUP_KEYS.map(([key, k]) => ({ key, label: t(k) })), [t]);

  const filters = useMemo(() => [
    { key: 'status', label: t('invoices.filters.status'), type: 'select', options: invoiceStatuses(t) },
  ], [t]);

  // Cancelling is offered only for an issued (unpaid) invoice, and the backend
  // enforces that regardless of what this menu shows.
  const rowActions = useCallback((row) => [
    { key: 'view', label: tc('actions.view'), icon: <Eye size={14} />,
      onClick: () => navigate(`/invoices/${row.id}`) },
    { key: 'download', label: t('invoices.downloadPdf'), icon: <Download size={14} />,
      onClick: () => download(row) },
    canCancel && row.status === 'issued' && {
      key: 'cancel', label: t('invoices.cancel'), icon: <Ban size={14} />, danger: true,
      onClick: () => { setToCancel(row); setReason(''); } },
  ].filter(Boolean), [canCancel, navigate]);

  return (
    <ListPage title={t('invoices.title')} subtitle={t('invoices.subtitle')}>
      <ListView
        tableKey="invoices"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="-issued_at"
        searchPlaceholder={t('invoices.searchPlaceholder')}
        emptyTitle={t('invoices.emptyTitle')}
        emptyHint={t('invoices.emptyHint')}
        onRowClick={(r) => navigate(`/invoices/${r.id}`)}
        columns={columns}
        filters={filters}
        groupOptions={groupOptions}
        rowActions={rowActions}
      />

      <ConfirmDialog
        open={Boolean(toCancel)} busy={busy} tone="danger" title={t('invoices.cancelTitle')} confirmLabel={t('invoices.cancel')}
        message={toCancel ? (
          <>
            {t('invoices.cancelBody', { number: toCancel.number })}
            <input className="form-input" style={{ marginTop: 10 }} placeholder={t('invoices.cancelReason')}
              value={reason} onChange={(e) => setReason(e.target.value)} />
          </>
        ) : null}
        onConfirm={runCancel}
        onClose={() => { if (!busy) { setToCancel(null); setReason(''); } }}
      />
    </ListPage>
  );
}
