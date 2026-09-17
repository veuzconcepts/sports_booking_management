import { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';

import { PageHeader } from '../../components/PageHeader.jsx';
import { MetricCard } from '../../components/MetricCard.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { reportsApi } from '../../services/reportsService.js';
import { clubsApi } from '../../services/clubsService.js';
import { Money } from '../../services/currency.jsx';
import { apiErrorMessage } from '../../utils/apiError';
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  window.URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [revenue, setRevenue] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [topServices, setTopServices] = useState([]);
  const [performance, setPerformance] = useState([]);
  const [memberships, setMemberships] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [club, setClub] = useState('');

  const clubs = useApiList(useCallback((q) => clubsApi.list({ ...q, is_active: 'true', page_size: 100 }), []));

  const params = {
    ...(dateFrom ? { date_from: dateFrom } : {}),
    ...(dateTo ? { date_to: dateTo } : {}),
    ...(club ? { club } : {}),
  };

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      reportsApi.revenue(params), reportsApi.bookings(params),
      reportsApi.services(params), reportsApi.performance(params),
      reportsApi.memberships(params),
    ])
      .then(([r, b, s, p, m]) => { setRevenue(r); setBookings(b); setTopServices(s); setPerformance(p); setMemberships(m); })
      .catch((e) => toast.error(apiErrorMessage(e, 'Unable to load the reports. Please try again.')))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, club]);

  useEffect(load, [load]);

  async function doExport(report, fmt) {
    try {
      const blob = await reportsApi.export(report, fmt, params);
      downloadBlob(blob, `${report}-report.${fmt}`);
      toast.success(`Exported ${fmt.toUpperCase()}`);
    } catch (e) { toast.error(apiErrorMessage(e, 'Unable to export the report. Please try again.')); }
  }

  const exportButtons = (report) => (
    <div style={{ display: 'flex', gap: 6 }}>
      <button className="btn btn-ghost btn-sm" onClick={() => doExport(report, 'xlsx')}><FileSpreadsheet size={14} /> Excel</button>
      <button className="btn btn-ghost btn-sm" onClick={() => doExport(report, 'pdf')}><FileText size={14} /> PDF</button>
    </div>
  );

  const revenueChart = (revenue?.series || []).map((p) => ({ day: shortDate(p.date), net: Number(p.net) }));
  const statusChart = bookings
    ? Object.entries(bookings.by_status).map(([k, v]) => ({ status: k.replace('_', ' '), count: v }))
    : [];

  // Merge revenue + booking club splits into one "by club" table.
  const clubRows = (() => {
    const map = new Map();
    (bookings?.by_club || []).forEach((r) => map.set(r.club, { name: r.name, count: r.count, net: '0.00' }));
    (revenue?.by_club || []).forEach((r) => {
      const row = map.get(r.club) || { name: r.name, count: 0, net: '0.00' };
      row.net = r.net; map.set(r.club, row);
    });
    return [...map.values()].sort((a, b) => Number(b.net) - Number(a.net));
  })();

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Revenue, bookings, and staff performance."
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => doExport('revenue', 'xlsx')}><FileSpreadsheet size={15} /> Excel</button>
            <button className="btn btn-secondary" onClick={() => doExport('revenue', 'pdf')}><FileText size={15} /> PDF</button>
          </div>
        }
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
        <div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>From</div>
          <input className="form-input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>To</div>
          <input className="form-input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <div style={{ width: 220 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>Club</div>
          <Select2
            options={clubs.rows.map((s) => ({ value: s.id, label: s.name }))}
            value={club} onChange={(v) => setClub(v || '')} placeholder="All clubs" clearable
          />
        </div>
        {(dateFrom || dateTo || club) && (
          <button className="btn btn-ghost" onClick={() => { setDateFrom(''); setDateTo(''); setClub(''); }}>
            Clear
          </button>
        )}
      </div>

      {loading ? (
        <div className="card"><div className="card-body center" style={{ padding: 48 }}><span className="muted">Loading reports…</span></div></div>
      ) : (
        <>
          <div className="metric-grid">
            <MetricCard label="Gross revenue" value={<Money amount={revenue?.gross_revenue} />} icon={Download} tint="blue" />
            <MetricCard label="Refunded" value={<Money amount={revenue?.refunded} />} icon={Download} tint="rose" />
            <MetricCard label="Net revenue" value={<Money amount={revenue?.net_revenue} />} icon={Download} tint="green" />
            <MetricCard label="Bookings" value={String(bookings?.total ?? 0)} icon={Download} tint="purple" />
          </div>

          <div className="chart-row">
            <div className="card">
              <div className="card-header"><h3 className="card-title">Net revenue by day</h3></div>
              <div className="card-body" style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={revenueChart} margin={{ top: 6, right: 12, left: -10, bottom: 0 }}>
                    <CartesianGrid stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="day" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12.5 }} />
                    <Bar dataKey="net" fill="#2563eb" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card">
              <div className="card-header"><h3 className="card-title">Bookings by status</h3></div>
              <div className="card-body" style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={statusChart} margin={{ top: 6, right: 12, left: -10, bottom: 0 }}>
                    <CartesianGrid stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="status" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12.5 }} />
                    <Bar dataKey="count" fill="#10b981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div style={{ height: 24 }} />

          <div className="chart-row">
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">By club</h3>
                {exportButtons('club')}
              </div>
              <DataTable
                rows={clubRows}
                emptyTitle="No club data"
                emptyHint="Bookings/payments tied to a club appear here."
                columns={[
                  { key: 'name', header: 'Club', render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
                  { key: 'count', header: 'Bookings', render: (r) => r.count },
                  { key: 'net', header: 'Net revenue', render: (r) => <Money amount={r.net} /> },
                ]}
              />
            </div>

            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Top services</h3>
                {exportButtons('services')}
              </div>
              <DataTable
                rows={topServices}
                emptyTitle="No service data"
                emptyHint="Bookings with a service appear here."
                columns={[
                  { key: 'name', header: 'Service', render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
                  { key: 'bookings', header: 'Bookings', render: (r) => r.bookings },
                  { key: 'net', header: 'Net revenue', render: (r) => <Money amount={r.net} /> },
                ]}
              />
            </div>
          </div>

          <div style={{ height: 24 }} />

          <div className="card">
            <div className="card-header"><h3 className="card-title">Staff performance</h3></div>
            <DataTable
              rows={performance}
              emptyTitle="No staff yet"
              emptyHint="Add staff to see performance."
              columns={[
                { key: 'name', header: 'Staff', render: (r) => (
                  <div><div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{r.employee_id} · {r.role}</div></div>
                ) },
                { key: 'jobs', header: 'Bookings completed', render: (r) => r.jobs_completed },
                { key: 'rating', header: 'Rating', render: (r) => Number(r.rating).toFixed(1) },
              ]}
            />
          </div>

          <div style={{ height: 24 }} />

          <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Memberships</h3>
          <div className="metric-grid">
            <MetricCard label="Active" value={String(memberships?.active ?? 0)} icon={Download} tint="green" />
            <MetricCard label="Expiring (30d)" value={String(memberships?.expiring_soon ?? 0)} icon={Download} tint="amber" />
            <MetricCard label="Expired" value={String(memberships?.expired ?? 0)} icon={Download} tint="rose" />
            <MetricCard label="Revenue" value={<Money amount={memberships?.revenue} code={memberships?.currency} />} icon={Download} tint="blue" />
            <MetricCard label="Sessions used" value={String(memberships?.units_consumed ?? 0)} icon={Download} tint="purple" />
          </div>

          <div style={{ height: 12 }} />

          <div className="card">
            <div className="card-header"><h3 className="card-title">Active by plan</h3></div>
            <DataTable
              rows={memberships?.by_plan || []}
              emptyTitle="No active memberships"
              emptyHint="Issue memberships to see plan uptake."
              columns={[
                { key: 'plan', header: 'Plan', render: (r) => r.plan },
                { key: 'active', header: 'Active', render: (r) => r.active },
              ]}
            />
          </div>

          {(memberships?.expiring_list || []).length > 0 && (
            <>
              <div style={{ height: 12 }} />
              <div className="card">
                <div className="card-header"><h3 className="card-title">Expiring soon</h3></div>
                <DataTable
                  rows={memberships.expiring_list}
                  columns={[
                    { key: 'number', header: 'Membership', render: (r) => r.number },
                    { key: 'customer', header: 'Customer', render: (r) => r.customer },
                    { key: 'plan', header: 'Plan', render: (r) => r.plan },
                    { key: 'end_date', header: 'Expires', render: (r) => new Date(r.end_date).toLocaleDateString() },
                  ]}
                />
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
