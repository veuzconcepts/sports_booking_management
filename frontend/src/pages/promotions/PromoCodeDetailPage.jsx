import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', padding: '8px 0',
      borderBottom: '1px solid var(--color-border-soft, #eef0f4)' }}>
      <span className="muted" style={{ flex: '0 1 160px', minWidth: 110, fontSize: 13 }}>{label}</span>
      <span style={{ flex: '1 1 160px', minWidth: 0, fontSize: 13.5, fontWeight: 500 }}>{children}</span>
    </div>
  );
}

export default function PromoCodeDetailPage() {
  const { t } = useTranslation('promotions');
  const { id } = useParams();
  const navigate = useNavigate();
  const [promo, setPromo] = useState(null);
  const [redemptions, setRedemptions] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([promoCodesApi.get(id), promoCodesApi.redemptions(id)])
      .then(([p, r]) => { setPromo(p); setRedemptions(Array.isArray(r) ? r : (r.results || [])); })
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadPromoCodePlease'))))
      .finally(() => setLoading(false));
  }, [id, t]);
  useEffect(load, [load]);

  if (loading) {
    return <div className="card"><div className="card-body center" style={{ padding: 56 }}><span className="muted">Loading…</span></div></div>;
  }
  if (!promo) {
    return (
      <>
        <button className="btn btn-ghost" onClick={() => navigate('/promo-codes')} style={{ marginBottom: 12 }}><ArrowLeft size={15} /> {t('common:actions.back')}</button>
        <div className="card"><div className="empty"><h3>{t('promoCodeNotFound')}</h3></div></div>
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
        <ArrowLeft size={15} /> {t('backPromoCodes')}
      </button>
      <PageHeader
        title={promo.code}
        subtitle={promo.description || 'Promo code'}
        actions={<StatusBadge tone={PROMO_STATUS_TONE[promo.status] || 'muted'} label={promo.status} />}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, maxWidth: 920 }}>
        <div className="card">
          <div className="card-header"><h3 className="card-title">{t('details')}</h3></div>
          <div className="card-body">
            <Row label={t('discount')}>{discount}</Row>
            {promo.discount_type === 'percent' && promo.max_discount_amount != null && (
              <Row label={t('maxDiscountCap2')}><Money amount={promo.max_discount_amount} /></Row>
            )}
            <Row label={t('minimumOrder')}>{Number(promo.min_order_amount) > 0 ? <Money amount={promo.min_order_amount} code={promo.currency || undefined} /> : '-'}</Row>
            <Row label={t('validity')}>{promo.valid_from || promo.valid_to ? `${promo.valid_from || '…'} → ${promo.valid_to || '…'}` : 'Always'}</Row>
            <Row label={t('firstOrderOnly2')}>{promo.first_order_only ? 'Yes' : 'No'}</Row>
            <Row label={t('common:state.active')}>{promo.is_active ? 'Yes' : 'No'}</Row>
            {promo.batch && <Row label={t('batch2')}>{promo.batch}</Row>}
            <Row label={t('created')}>{formatDateTime(promo.created_at)}</Row>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><h3 className="card-title">{t('usageAndScope')}</h3></div>
          <div className="card-body">
            <Row label={t('used')}>{promo.used_count}</Row>
            <Row label={t('totalLimit')}>{promo.usage_limit ?? 'Unlimited'}</Row>
            <Row label={t('remaining2')}>{promo.usage_limit == null ? 'Unlimited' : promo.remaining}</Row>
            <Row label={t('perCustomerLimit2')}>{promo.usage_limit_per_customer ?? 'Unlimited'}</Row>
            <Row label={t('applies')}>{SCOPE_LABEL[promo.applies_to] || promo.applies_to}</Row>
            {promo.applies_to !== 'all' && <Row label={t('selected')}>{scopeNames.length ? scopeNames.join(', ') : '-'}</Row>}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <div>
            <h3 className="card-title">{t('redemptionHistory')}</h3>
            <p className="card-subtitle">{t('whoUsedCodeWhenWhich')}</p>
          </div>
        </div>
        <DataTable
          rows={redemptions}
          emptyTitle={t('noRedemptionsYet')}
          emptyHint={t('usageWillAppearHereOnce')}
          columns={[
            { key: 'when', header: t('when'), nowrap: true, render: (r) => formatDateTime(r.created_at) },
            { key: 'who', header: t('common:labels.customer'), render: (r) => r.customer_name || '-' },
            { key: 'booking', header: t('booking'), render: (r) => r.booking_reference || '-' },
            { key: 'amount', header: t('discount'), align: 'right', render: (r) => <Money amount={r.discount_amount} /> },
          ]}
        />
      </div>
    </>
  );
}
