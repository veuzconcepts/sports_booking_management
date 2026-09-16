import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

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
      .then(([s, t, tp, l]) => { setSummary(s); setTiers(t); setTop(tp); setLiability(l); })
      .catch((e) => toast.error(apiErrorMessage(e, 'Unable to load loyalty reports')))
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo]);

  useEffect(load, [load]);

  return (
    <>
      <PageHeader title="Loyalty Reports"
        subtitle="Points issued, redeemed and expired, tier distribution, top customers and liability." />

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13 }}>From
          <input className="form-input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>To
          <input className="form-input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
      </div>

      {loading ? <p className="muted">Loading…</p> : (
        <>
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <Stat label="Points issued" value={(summary?.issued ?? 0).toLocaleString()} />
            <Stat label="Points redeemed" value={(summary?.redeemed ?? 0).toLocaleString()} />
            <Stat label="Points expired" value={(summary?.expired ?? 0).toLocaleString()} />
            <Stat label="Outstanding points" value={(liability?.outstanding_points ?? 0).toLocaleString()} />
            <Stat label="Liability value" value={liability?.value ?? '0'} />
          </div>

          <div style={{ height: 20 }} />
          <div className="row">
            <div className="col" style={{ flex: '1 1 320px' }}>
              <div className="card">
                <div className="card-header"><h3 className="card-title">Tier distribution</h3></div>
                <div className="table-wrapper">
                  <table className="table">
                    <thead><tr><th>Tier</th><th>Customers</th></tr></thead>
                    <tbody>
                      {tiers.map((r) => (
                        <tr key={r.tier}><td style={{ textTransform: 'capitalize' }}>{r.tier}</td><td>{r.count}</td></tr>
                      ))}
                      {tiers.length === 0 && <tr><td colSpan={2} className="muted">No data.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="col" style={{ flex: '2 1 480px' }}>
              <div className="card">
                <div className="card-header"><h3 className="card-title">Top loyalty customers</h3></div>
                <div className="table-wrapper">
                  <table className="table">
                    <thead><tr><th>Customer</th><th>Tier</th><th>Balance</th><th>Earned</th><th>Redeemed</th></tr></thead>
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
                      {top.length === 0 && <tr><td colSpan={5} className="muted">No data.</td></tr>}
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
