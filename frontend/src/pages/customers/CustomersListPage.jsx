import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, AlertTriangle, ShieldCheck, ShieldAlert, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toolbar } from '../../components/Toolbar.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { customersApi } from '../../services/customersService.js';
import { Money } from '../../services/currency.jsx';
import { apiErrorMessage } from '../../utils/apiError';
import { CustomerFormModal } from './CustomerFormModal.jsx';

const LOGIN_TONE = {
  'Login Enabled': 'success', 'Login Disabled': 'danger',
  'Invite Pending': 'warning', 'No Login': 'muted',
};

const TIER_OPTIONS = [
  { value: 'bronze',   label: 'Bronze' },
  { value: 'silver',   label: 'Silver' },
  { value: 'gold',     label: 'Gold' },
  { value: 'platinum', label: 'Platinum' },
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
  const { rows, loading, count, query, setQuery, reload } = useApiList(fetcher);

  async function doDelete() {
    if (!deleteRow) return;
    setBusy(true);
    try {
      await customersApi.remove(deleteRow.id);
      toast.success('Customer deleted');
      setDeleteRow(null);
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to delete this customer. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="All registered customers across every club and booking channel."
        actions={
          hasPerm('customers.add') && (
            <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
              <Plus size={15} /> New customer
            </button>
          )
        }
      />

      <Toolbar
        searchValue={query.search}
        onSearchChange={(v) => setQuery({ ...query, search: v || undefined, page: 1 })}
        searchPlaceholder="Search by name, email, phone…"
        filters={[
          {
            value: query.loyalty_tier,
            options: TIER_OPTIONS,
            placeholder: 'All tiers',
            onChange: (v) => setQuery({ ...query, loyalty_tier: v, page: 1 }),
          },
          {
            value: query.is_corporate,
            options: [
              { value: 'true',  label: 'Corporate / fleet' },
              { value: 'false', label: 'Individual' },
            ],
            placeholder: 'Account type',
            onChange: (v) => setQuery({ ...query, is_corporate: v, page: 1 }),
          },
        ]}
      />

      <DataTable
        loading={loading}
        rows={rows}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        emptyTitle="No customers yet"
        emptyHint="Use “New customer” above to onboard your first customer."
        onRowClick={(row) => navigate(`/customers/${row.id}`)}
        columns={[
          {
            key: 'name', header: 'Name',
            render: (r) => (
              <div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <button className="link-btn" style={{ fontWeight: 600 }}
                    onClick={(e) => { e.stopPropagation(); navigate(`/customers/${r.id}`); }}>{r.full_name}</button>
                  {r.duplicate_count > 0 && (
                    <span title={`${r.duplicate_count} possible duplicate record${r.duplicate_count > 1 ? 's' : ''} - open to review & merge`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--warning, #b45309)' }}>
                      <AlertTriangle size={14} />
                      <span style={{ fontSize: 11, fontWeight: 600 }}>{r.duplicate_count}</span>
                    </span>
                  )}
                  {r.is_verified
                    ? <ShieldCheck size={14} style={{ color: 'var(--color-success, #16a34a)' }} aria-label="Verified" />
                    : <ShieldAlert size={14} style={{ color: 'var(--color-text-muted, #9ca3af)' }} aria-label="Unverified" />}
                </span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {r.customer_code ? `${r.customer_code} · ` : ''}{r.email}
                </div>
              </div>
            ),
          },
          { key: 'phone',  header: 'Phone',
            render: (r) => r.phone || <span className="muted">-</span> },
          {
            key: 'type',   header: 'Type',
            render: (r) => (
              <StatusBadge
                tone={r.is_corporate ? 'info' : 'muted'}
                label={r.is_corporate ? 'Corporate' : 'Individual'}
              />
            ),
          },
          {
            key: 'login', header: 'Login',
            render: (r) => <StatusBadge tone={LOGIN_TONE[r.login_status] || 'muted'} label={r.login_status} />,
          },
          {
            key: 'tier',   header: 'Tier',
            render: (r) => <StatusBadge tone="warning" label={r.loyalty_tier} />,
          },
          { key: 'points', header: 'Points',
            render: (r) => r.loyalty_points.toLocaleString() },
          { key: 'value',  header: 'Lifetime value', render: (r) => <Money amount={r.lifetime_value} /> },
          ...(canDelete ? [{
            key: 'actions', header: '', sticky: 'right', render: (r) => (
              // Delete shows only for UNVERIFIED customers (verified ones are protected).
              !r.is_verified ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="icon-btn" title="Delete customer" style={{ color: 'var(--color-danger, #dc2626)' }}
                    onClick={(e) => { e.stopPropagation(); setDeleteRow(r); }}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ) : null
            ),
          }] : []),
        ]}
      />

      <ConfirmDialog
        open={Boolean(deleteRow)}
        tone="danger"
        title="Delete customer"
        message={deleteRow
          ? `Permanently delete ${deleteRow.full_name || deleteRow.customer_code}? Only unverified customers can be deleted. This cannot be undone.`
          : ''}
        confirmLabel="Delete customer"
        busy={busy}
        onConfirm={doDelete}
        onClose={() => { if (!busy) setDeleteRow(null); }}
      />

      <CustomerFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          toast.success('Customer created');
          reload();
        }}
      />
    </>
  );
}
