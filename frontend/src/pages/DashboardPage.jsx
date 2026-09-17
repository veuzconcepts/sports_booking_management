import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarCheck, DollarSign, Users, Repeat, TrendingUp } from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, Tooltip, XAxis, YAxis, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';

import { PageHeader } from '../components/PageHeader.jsx';
import { MetricCard } from '../components/MetricCard.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import { reportsApi } from '../services/reportsService.js';
import { bookingsApi } from '../services/bookingsService.js';
import { Money } from '../services/currency.jsx';

const STAFF = ['super_admin', 'admin', 'club_admin', 'manager', 'facility_operator', 'facility_staff'];
const MANAGERS = ['super_admin', 'admin', 'club_admin', 'manager'];
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const STATUS_COLORS = {
  active: '#2563eb',
  completed: '#10b981',
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const { role } = useAuth();
  const canSeeReports = MANAGERS.includes(role);

  const [summary, setSummary] = useState(null);
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    if (canSeeReports) {
      reportsApi.summary().then(setSummary).catch(() => setSummary(null));
    }
    bookingsApi.list({ ordering: '-created_at', page_size: 6 })
      .then((d) => setRecent(d.results || d))
      .catch(() => setRecent([]));
  }, [canSeeReports]);

  const revenueData = (summary?.revenue_series || []).map((p) => ({
    day: shortDate(p.date),
    revenue: Number(p.net),
  }));
  const statusData = summary
    ? [
        { name: 'In progress', value: summary.active_bookings, color: STATUS_COLORS.active },
        { name: 'Completed', value: summary.completed_bookings, color: STATUS_COLORS.completed },
      ].filter((c) => c.value > 0)
    : [];

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Live overview of bookings across every club."
        actions={
          STAFF.includes(role) && (
            <button className="btn btn-primary" onClick={() => navigate('/bookings')}>+ New booking</button>
          )
        }
      />

      {canSeeReports && (
        <div className="metric-grid">
          <MetricCard label="Net revenue (all-time)" value={summary ? <Money amount={summary.net_revenue} /> : '-'} icon={DollarSign} tint="green" />
          <MetricCard label="Active bookings" value={summary ? String(summary.active_bookings) : '-'} icon={CalendarCheck} tint="blue" />
          <MetricCard label="Customers" value={summary ? String(summary.total_customers) : '-'} icon={Users} tint="purple" />
          <MetricCard label="Repeat rate" value={summary ? `${summary.repeat_rate_percent}%` : '-'} icon={Repeat} tint="amber" />
        </div>
      )}

      {canSeeReports && (
        <div className="chart-row">
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">Net revenue (last 14 days)</h3>
                <p className="card-subtitle">Paid less refunds across all channels.</p>
              </div>
              <span className="badge badge-success"><TrendingUp size={12} /> AOV {summary ? <Money amount={summary.average_order_value} /> : '-'}</span>
            </div>
            <div className="card-body" style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={revenueData} margin={{ top: 6, right: 12, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"  stopColor="#2563eb" stopOpacity={0.32} />
                      <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#eef2f7" vertical={false} />
                  <XAxis dataKey="day" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12.5 }} />
                  <Area type="monotone" dataKey="revenue" stroke="#2563eb" strokeWidth={2.5} fill="url(#rev)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">Booking mix</h3>
                <p className="card-subtitle">Share of bookings by stage.</p>
              </div>
            </div>
            <div className="card-body" style={{ height: 280 }}>
              {statusData.length === 0 ? (
                <div className="center" style={{ height: '100%' }}><span className="muted">No bookings yet.</span></div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusData} innerRadius={56} outerRadius={86} paddingAngle={2} dataKey="value">
                      {statusData.map((c) => <Cell key={c.name} fill={c.color} />)}
                    </Pie>
                    <Legend verticalAlign="bottom" iconType="circle" iconSize={9} wrapperStyle={{ fontSize: 12.5 }} />
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ height: 24 }} />

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Recent bookings</h3>
            <p className="card-subtitle">Latest activity across all clubs.</p>
          </div>
          <button className="btn btn-secondary" onClick={() => navigate('/bookings')}>View all</button>
        </div>
        {recent.length === 0 ? (
          <div className="empty"><p>No bookings yet.</p></div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Booking</th><th>Customer</th><th>Club</th><th>Facility</th>
                  <th>Status</th><th style={{ textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((b) => (
                  <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/bookings/${b.id}`)}>
                    <td style={{ fontWeight: 600 }}>{b.reference}</td>
                    <td>{b.customer_name}</td>
                    <td className="muted">{b.club_name || '-'}</td>
                    <td>{b.facility_type_name || b.facility_category_name || '-'}</td>
                    <td><StatusBadge status={b.status} /></td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}><Money amount={b.total_amount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
