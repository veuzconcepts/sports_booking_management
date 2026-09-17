import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, AlertTriangle, ShieldCheck, ShieldAlert, Trash2, Eye, Download,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { customersApi } from '../../services/customersService.js';
import { Money } from '../../services/currency.jsx';
import { apiErrorMessage } from '../../utils/apiError';
import { exportRowsToCsv } from '../../utils/exportCsv.js';
import { CustomerFormModal } from './CustomerFormModal.jsx';

const LOGIN_TONE = {
  'Login Enabled': 'success', 'Login Disabled': 'danger',
  'Invite Pending': 'warning', 'No Login': 'muted',
};

const tierOptions = (t) => [
  { value: 'bronze',   label: t('bronze') },
  { value: 'silver',   label: t('silver') },
  { value: 'gold',     label: t('gold') },
  { value: 'platinum', label: t('platinum') },
];


const groups = (t) => [
  { key: 'loyalty_tier', label: t('tier') },
  { key: 'is_corporate', label: t('accountType') },
  { key: 'source', label: t('sourceLabel') },
  { key: 'status', label: t('common:labels.status') },
];

// Built with `t` at export time, so the downloaded file is headed in the
// language the user is working in.
const exportColumns = (t) => [
  { key: 'customer_code', header: t('columns.code') },
  { key: 'full_name', header: t('columns.name') },
  { key: 'email', header: t('columns.email') },
  { key: 'phone', header: t('columns.phone') },
  { key: 'loyalty_tier', header: t('columns.tier') },
  { key: 'loyalty_points', header: t('columns.points') },
  { key: 'lifetime_value', header: t('columns.lifetimeValue') },
  { key: 'is_corporate', header: t('columns.corporate') },
  { key: 'is_verified', header: t('columns.verified') },
];

export default function CustomersListPage() {
  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteRow, setDeleteRow] = useState(null);   // unverified customer pending delete
  const [busy, setBusy] = useState(false);
  // Only UNVERIFIED customers can be deleted (junk/fake cleanup).
  const canDelete = hasPerm('customers.delete');

  const fetcher = useCallback((q) => customersApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const canExport = hasPerm('reports.export');
  const { t } = useTranslation('customers');
  const { t: tc } = useTranslation('common');

  async function doDelete() {
    if (!deleteRow) return;
    setBusy(true);
    try {
      await customersApi.remove(deleteRow.id);
      toast.success(t('actions.deleted'));
      setDeleteRow(null);
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('delete.failed')));
    } finally {
      setBusy(false);
    }
  }

  // --- Listing configuration ------------------------------------------------
  const columns = useMemo(() => [
    {
      key: 'name', header: t('columns.name'), sortKey: 'full_name',
      minWidth: 200, alwaysVisible: true,
      render: (r) => (
        <div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="link-btn" style={{ fontWeight: 600 }}>{r.full_name}</span>
            {r.duplicate_count > 0 && (
              <span title={t('badges.duplicates', { count: r.duplicate_count })}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--color-warning-600)' }}>
                <AlertTriangle size={14} />
                <span style={{ fontSize: 11, fontWeight: 600 }}>{r.duplicate_count}</span>
              </span>
            )}
            {r.is_verified
              ? <ShieldCheck size={14} style={{ color: 'var(--color-success-600)' }} aria-label={t('badges.verified')} />
              : <ShieldAlert size={14} style={{ color: 'var(--color-text-muted)' }} aria-label={t('badges.unverified')} />}
          </span>
          <div className="muted" style={{ fontSize: 12 }}>
            {r.customer_code ? `${r.customer_code} · ` : ''}{r.email}
          </div>
        </div>
      ),
    },
    { key: 'phone', header: t('columns.phone'), minWidth: 130, nowrap: true,
      render: (r) => r.phone || <span className="muted">-</span> },
    { key: 'type', header: t('columns.type'), sortKey: 'is_corporate', minWidth: 110,
      priority: 'medium',
      render: (r) => (
        <StatusBadge tone={r.is_corporate ? 'info' : 'muted'}
          label={r.is_corporate ? t('type.corporate') : t('type.individual')} />
      ) },
    { key: 'login', header: t('columns.login'), minWidth: 110, priority: 'low',
      render: (r) => <StatusBadge tone={LOGIN_TONE[r.login_status] || 'muted'} label={r.login_status} /> },
    { key: 'tier', header: t('columns.tier'), sortKey: 'loyalty_tier', minWidth: 100,
      render: (r) => <StatusBadge tone="warning" label={r.loyalty_tier} /> },
    { key: 'points', header: t('columns.points'), sortKey: 'loyalty_points', align: 'right',
      minWidth: 90, priority: 'low',
      render: (r) => r.loyalty_points.toLocaleString() },
    { key: 'value', header: t('columns.lifetimeValue'), sortKey: 'lifetime_value',
      align: 'right', minWidth: 120, nowrap: true,
      render: (r) => <Money amount={r.lifetime_value} /> },
  ], [t]);

  const filters = useMemo(() => [
    { key: 'loyalty_tier', label: t('filters.tier'), type: 'select', options: tierOptions(t) },
    { key: 'is_corporate', label: t('filters.accountType'), type: 'boolean',
      trueLabel: t('type.corporateFleet'), falseLabel: t('type.individual') },
    { key: 'source', label: t('filters.source'), type: 'select', options: [
      { value: 'admin', label: t('source.admin') },
      { value: 'website', label: t('source.website') },
      { value: 'walk_in', label: t('source.walk_in') },
    ] },
  ], [t]);

  // Delete is offered only for UNVERIFIED customers; verified records are
  // protected, and the backend enforces that regardless of this menu.
  const rowActions = useCallback((row) => [
    { key: 'view', label: tc('actions.view'), icon: <Eye size={14} />,
      onClick: () => navigate(`/customers/${row.id}`) },
    canDelete && !row.is_verified && {
      key: 'delete', label: t('delete.confirm'), icon: <Trash2 size={14} />, danger: true,
      onClick: () => setDeleteRow(row) },
  ].filter(Boolean), [canDelete, navigate]);

  const bulkActions = useMemo(() => (canExport ? [{
    key: 'export', label: t('actions.exportSelected'), icon: <Download size={14} />,
    run: (ids, selected) => {
      exportRowsToCsv(selected, exportColumns(t), 'customers');
      toast.success(t('actions.exported', { count: selected.length }));
    },
  }] : []), [canExport, t]);

  return (
    <ListPage
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        hasPerm('customers.add') && (
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
            <Plus size={15} /> {t('newCustomer')}
          </button>
        )
      }
    >
      <ListView
        tableKey="customers"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="-created_at"
        searchPlaceholder={t('searchPlaceholder')}
        emptyTitle={t('emptyTitle')}
        emptyHint={t('emptyHint')}
        onRowClick={(row) => navigate(`/customers/${row.id}`)}
        columns={columns}
        filters={filters}
        groupOptions={groups(t)}
        rowActions={rowActions}
        bulkActions={bulkActions}
      />

      <ConfirmDialog
        open={Boolean(deleteRow)}
        tone="danger"
        title={t('delete.title')}
        message={deleteRow
          ? t('delete.body', { name: deleteRow.full_name || deleteRow.customer_code })
          : ''}
        confirmLabel={t('delete.confirm')}
        busy={busy}
        onConfirm={doDelete}
        onClose={() => { if (!busy) setDeleteRow(null); }}
      />

      <CustomerFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          toast.success(t('actions.created'));
          reload();
        }}
      />
    </ListPage>
  );
}
