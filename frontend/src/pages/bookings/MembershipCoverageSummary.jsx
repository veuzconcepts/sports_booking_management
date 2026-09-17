import { useTranslation } from 'react-i18next';

// Read-only membership coverage summary for the booking form. Consumes the
// `coverage` block returned by /bookings/price-preview/ (computed server-side by
// coverage_for_booking) - it changes nothing, it only shows what the membership
// covers, what is charged separately, and the remaining entitlement balance.



// Tone is presentation only; the wording comes from the bundle so it follows
// the active language.
const TONE = {
  full:    { bg: 'var(--color-success-bg, #ecfdf5)', border: 'var(--color-success, #10b981)' },
  partial: { bg: 'var(--color-warning-bg, #fffbeb)', border: 'var(--color-warning, #f59e0b)' },
  none:    { bg: 'var(--color-surface-2, #f7f8fa)', border: 'var(--color-border, #e5e7eb)' },
};

export function MembershipCoverageSummary({ coverage }) {
  const { t } = useTranslation('bookings');
  if (!coverage) return null;   // no active membership for this customer
  const tone = TONE[coverage.status] || TONE.none;
  const headline = coverage.status === 'partial'
    ? t('coverage.partialCount', {
      covered: coverage.covered_count, total: coverage.total_count,
    })
    : t(`coverage.${coverage.status in TONE ? coverage.status : 'none'}`);

  return (
    <div style={{ border: `1px solid ${tone.border}`, background: tone.bg,
      borderRadius: 10, padding: 12, fontSize: 13, marginBottom: 10 }} role="status">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <strong>{t('membershipCoverage')}</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          {coverage.membership_number} · {coverage.plan_name}
        </span>
      </div>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{headline}</div>

      <div style={{ display: 'grid', gap: 3 }}>
        {coverage.items.map((it, i) => (
          <div key={i} style={{ display: 'flex', gap: 6 }}>
            <span style={{ color: it.covered ? 'var(--color-success, #10b981)' : 'var(--color-warning, #b45309)' }}>
              {it.covered ? '✓' : '⚠'}
            </span>
            <span>{it.label}</span>
            <span className="muted" style={{ marginLeft: 'auto' }}>
              {it.covered ? t('covered') : t('notCoveredCharged')}
            </span>
          </div>
        ))}
      </div>

      {(coverage.balances || []).length > 0 && (
        <div style={{ marginTop: 8, borderTop: `1px dashed ${tone.border}`, paddingTop: 6 }}>
          <div className="muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>
            {t('remainingBalance')}
          </div>
          {coverage.balances.map((b, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>{b.label}</span>
              <span style={{ fontWeight: 600 }}>
                {b.remaining == null
                  ? t('coverage.unlimited')
                  : `${b.remaining} ${t(`coverage.period.${b.period}`, {
                    defaultValue: t('coverage.period.lifetime'),
                  })}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
