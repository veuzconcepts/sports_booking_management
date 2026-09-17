import { Money } from '../../services/currency.jsx';
import { useTranslation } from 'react-i18next';

function PriceLine({ label, value, strong, muted }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8,
      fontWeight: strong ? 700 : 400, color: muted ? 'var(--color-text-muted)' : 'var(--color-text)' }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * Live, backend-computed price breakdown for the booking form. `preview` is the
 * `/bookings/price-preview/` payload (or null). Presentational only - all math
 * is done on the backend.
 */
export function PriceSummary({ hasService, loading, preview }) {
  const { t } = useTranslation('bookings');
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: 14,
      background: 'var(--color-surface-2, #f7f8fa)', fontSize: 13 }}>
      {!hasService ? (
        <span className="muted">{t('selectServiceSeePriceBreakdown')}</span>
      ) : loading && !preview ? (
        <span className="muted">Calculating…</span>
      ) : !preview ? (
        <span className="muted">{t('couldnTCalculatePriceSelection')}</span>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          <PriceLine label={t('service')} value={<Money amount={preview.base_amount} code={preview.currency} />} />
          {Number(preview.addons_amount) > 0 && (
            <PriceLine label={t('addOns')} value={<Money amount={preview.addons_amount} code={preview.currency} />} />
          )}
          <PriceLine label={t('subtotal')} value={<Money amount={preview.subtotal} code={preview.currency} />} muted />

          {(preview.applied_rules || []).length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div className="muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
                {t('appliedRules')}
              </div>
              {preview.applied_rules.map((r) => (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' }}>
                  <span style={{ minWidth: 0 }}>
                    {r.name}
                    <span className="muted" style={{ fontSize: 11.5 }}> · {r.rule_type_display || r.rule_type} · {r.adjustment}</span>
                  </span>
                  <span style={{ whiteSpace: 'nowrap', color: Number(r.amount) < 0 ? 'var(--color-success,#16a34a)' : 'var(--color-text)' }}>
                    {Number(r.amount) < 0 ? '- ' : '+ '}<Money amount={Math.abs(Number(r.amount))} code={preview.currency} />
                  </span>
                </div>
              ))}
            </div>
          )}
          {Number(preview.promo_discount) > 0 && (
            <PriceLine label={t('promoCode')} value={<>- <Money amount={preview.promo_discount} code={preview.currency} /></>} />
          )}
          <PriceLine label={preview.tax_inclusive ? t('vatIncluded') : t('vat')} value={<Money amount={preview.vat_amount} code={preview.currency} />} />
          <div className="divider" style={{ margin: '4px 0' }} />
          <PriceLine label={t('finalTotal')} value={<Money amount={preview.final_amount} code={preview.currency} />} strong />
        </div>
      )}
    </div>
  );
}
