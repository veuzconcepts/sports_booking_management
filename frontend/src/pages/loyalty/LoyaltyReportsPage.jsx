import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../components/PageHeader.jsx';
import { loyaltyApi } from '../../services/loyaltyService.js';
import { apiErrorMessage } from '../../utils/apiError.js';

const stat = { border: '1px solid var(--color-border)', borderRadius: 12, padding: 16,
  background: 'var(--color-surface, #fff)' };

function Stat({ label, value }) {
  return (
    <div style={stat}>
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 6 }}>{value}</div>
    </div>
  );
}

export default function LoyaltyReportsPage() {
  const { t } = useTranslation('loyalty');
  const [summary, setSummary] = useState(null);
  const [tiers, setTiers] = useState([]);
  const [top, setTop] = useState([]);
  const [liability, setLiability] = useState(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const params = {
      ...(dateFrom ? { date_from: dateFrom } : {}),
      ...(dateTo ? { date_to: dateTo } : {}),
    };
    Promise.all([
      loyaltyApi.reports.summary(params),
      loyaltyApi.reports.tiers(),
      loyaltyApi.reports.top({ limit: 20 }),
      loyaltyApi.reports.liability(),
    ])
      .then(([summaryData, tierRows, topRows, liabilityData]) => {
        setSummary(summaryData);
        setTiers(Array.isArray(tierRows) ? tierRows : []);
        setTop(Array.isArray(topRows) ? topRows : []);
        setLiability(liabilityData);
      })
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadLoyaltyReports'))))
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo, t]);

  useEffect(load, [load]);

  return (
    <>
      <PageHeader title={t('loyaltyReports')}
        subtitle={t('pointsIssuedRedeemedExpiredTier')} />

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13 }}>{t('from')}
          <input className="form-input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>To
          <input className="form-input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
      </div>

      {loading ? <p className="muted">Loading…</p> : (
        <>
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <Stat label={t('pointsIssued')} value={(summary?.issued ?? 0).toLocaleString()} />
            <Stat label={t('pointsRedeemed')} value={(summary?.redeemed ?? 0).toLocaleString()} />
            <Stat label={t('pointsExpired')} value={(summary?.expired ?? 0).toLocaleString()} />
            <Stat label={t('outstandingPoints')} value={(liability?.outstanding_points ?? 0).toLocaleString()} />
            <Stat label={t('liabilityValue')} value={liability?.value ?? '0'} />
          </div>

          <div style={{ height: 20 }} />
          <div className="row">
            <div className="col" style={{ flex: '1 1 320px' }}>
              <div className="card">
                <div className="card-header"><h3 className="card-title">{t('tierDistribution')}</h3></div>
                <div className="table-wrapper">
                  <table className="table">
                    <thead><tr><th>{t('tier')}</th><th>{t('customers')}</th></tr></thead>
                    <tbody>
                      {tiers.map((r) => (
                        <tr key={r.tier}><td style={{ textTransform: 'capitalize' }}>{r.tier}</td><td>{r.count}</td></tr>
                      ))}
                      {tiers.length === 0 && <tr><td colSpan={2} className="muted">{t('noData')}</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="col" style={{ flex: '2 1 480px' }}>
              <div className="card">
                <div className="card-header"><h3 className="card-title">{t('topLoyaltyCustomers')}</h3></div>
                <div className="table-wrapper">
                  <table className="table">
                    <thead><tr><th>{t('common:labels.customer')}</th><th>{t('tier')}</th><th>{t('balance')}</th><th>{t('earned')}</th><th>{t('redeemed')}</th></tr></thead>
                    <tbody>
                      {top.map((c) => (
                        <tr key={c.id}>
                          <td style={{ fontWeight: 600 }}>{c.name} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{c.code}</span></td>
                          <td style={{ textTransform: 'capitalize' }}>{c.tier}</td>
                          <td>{c.points.toLocaleString()}</td>
                          <td>{c.earned.toLocaleString()}</td>
                          <td>{c.redeemed.toLocaleString()}</td>
                        </tr>
                      ))}
                      {top.length === 0 && <tr><td colSpan={5} className="muted">{t('noData')}</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
