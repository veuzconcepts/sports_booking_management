import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Money } from '../../services/currency.jsx';
import { formatDateTime } from '../../services/timeformat.jsx';
import { promoCodesApi, PROMO_STATUS_TONE } from '../../services/promotionsService.js';
import { apiErrorMessage } from '../../utils/apiError';

const SCOPE_LABEL = {
  all: 'All services & add-ons', category: 'Specific categories',
  package: 'Specific services', addon: 'Specific add-ons',
};

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--color-border-soft, #eef0f4)' }}>
      <span className="muted" style={{ width: 160, flexShrink: 0, fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 13.5, fontWeight: 500 }}>{children}</span>
    </div>
  );
}

export default function PromoCodeDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [promo, setPromo] = useState(null);
  const [redemptions, setRedemptions] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([promoCodesApi.get(id), promoCodesApi.redemptions(id)])
      .then(([p, r]) => { setPromo(p); setRedemptions(Array.isArray(r) ? r : (r.results || [])); })
      .catch((e) => toast.error(apiErrorMessage(e, 'Unable to load the promo code. Please try again.')))
      .finally(() => setLoading(false));
  }, [id]);
  useEffect(load, [load]);

  if (loading) {
    return <div className="card"><div className="card-body center" style={{ padding: 56 }}><span className="muted">Loading…</span></div></div>;
  }
  if (!promo) {
    return (
      <>
        <button className="btn btn-ghost" onClick={() => navigate('/promo-codes')} style={{ marginBottom: 12 }}><ArrowLeft size={15} /> Back</button>
        <div className="card"><div className="empty"><h3>Promo code not found</h3></div></div>
      </>
    );
  }

  const scopeNames = promo.applies_to === 'category' ? promo.category_names
    : promo.applies_to === 'package' ? promo.service_names
      : promo.applies_to === 'addon' ? promo.addon_names : [];
  const discount = promo.discount_type === 'percent'
    ? `${Number(promo.discount_value)}%`
    : <Money amount={promo.discount_value} code={promo.currency || undefined} />;

  return (
    <>
      <button className="btn btn-ghost" onClick={() => navigate('/promo-codes')} style={{ marginBottom: 12 }}>
        <ArrowLeft size={15} /> Back to promo codes
      </button>
      <PageHeader
        title={promo.code}
        subtitle={promo.description || 'Promo code'}
        actions={<StatusBadge tone={PROMO_STATUS_TONE[promo.status] || 'muted'} label={promo.status} />}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, maxWidth: 920 }}>
        <div className="card">
          <div className="card-header"><h3 className="card-title">Details</h3></div>
          <div className="card-body">
            <Row label="Discount">{discount}</Row>
            {promo.discount_type === 'percent' && promo.max_discount_amount != null && (
              <Row label="Max discount (cap)"><Money amount={promo.max_discount_amount} /></Row>
            )}
            <Row label="Minimum order">{Number(promo.min_order_amount) > 0 ? <Money amount={promo.min_order_amount} code={promo.currency || undefined} /> : '-'}</Row>
            <Row label="Validity">{promo.valid_from || promo.valid_to ? `${promo.valid_from || '…'} → ${promo.valid_to || '…'}` : 'Always'}</Row>
            <Row label="First order only">{promo.first_order_only ? 'Yes' : 'No'}</Row>
            <Row label="Active">{promo.is_active ? 'Yes' : 'No'}</Row>
            {promo.batch && <Row label="Batch">{promo.batch}</Row>}
            <Row label="Created">{formatDateTime(promo.created_at)}</Row>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><h3 className="card-title">Usage &amp; Scope</h3></div>
          <div className="card-body">
            <Row label="Used">{promo.used_count}</Row>
            <Row label="Total limit">{promo.usage_limit ?? 'Unlimited'}</Row>
            <Row label="Remaining">{promo.usage_limit == null ? 'Unlimited' : promo.remaining}</Row>
            <Row label="Per-customer limit">{promo.usage_limit_per_customer ?? 'Unlimited'}</Row>
            <Row label="Applies to">{SCOPE_LABEL[promo.applies_to] || promo.applies_to}</Row>
            {promo.applies_to !== 'all' && <Row label="Selected">{scopeNames.length ? scopeNames.join(', ') : '-'}</Row>}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <div>
            <h3 className="card-title">Redemption History</h3>
            <p className="card-subtitle">Who used this code, when, on which booking, and how much was discounted.</p>
          </div>
        </div>
        <DataTable
          rows={redemptions}
          emptyTitle="No redemptions yet"
          emptyHint="Usage will appear here once the code is redeemed at checkout."
          columns={[
            { key: 'when', header: 'When', nowrap: true, render: (r) => formatDateTime(r.created_at) },
            { key: 'who', header: 'Customer', render: (r) => r.customer_name || '-' },
            { key: 'booking', header: 'Booking', render: (r) => r.booking_reference || '-' },
            { key: 'amount', header: 'Discount', align: 'right', render: (r) => <Money amount={r.discount_amount} /> },
          ]}
        />
      </div>
    </>
  );
}
