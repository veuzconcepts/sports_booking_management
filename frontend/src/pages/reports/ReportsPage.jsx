import { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet, FileText, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';

import { PageHeader } from '../../components/PageHeader.jsx';
import { AiInsightsPanel } from './AiInsightsPanel.jsx';
import { InsightWidgets } from './InsightWidgets.jsx';
import './insights.css';
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
  const { t } = useTranslation('reports');
  const [revenue, setRevenue] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [topServices, setTopServices] = useState([]);
  const [performance, setPerformance] = useState([]);
  const [memberships, setMemberships] = useState(null);
  // AI Insights: the panel, and the report it has opened into the page.
  const [aiOpen, setAiOpen] = useState(false);
  const [fullReport, setFullReport] = useState(null);
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
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadReportsPleaseTry'))))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, club, t]);

  useEffect(load, [load]);

  async function doExport(report, fmt) {
    try {
      const blob = await reportsApi.export(report, fmt, params);
      downloadBlob(blob, `${report}-report.${fmt}`);
      toast.success(t('exported', { format: fmt.toUpperCase() }));
    } catch (e) { toast.error(apiErrorMessage(e, t('unableExportReportPleaseTry'))); }
  }

  const exportButtons = (report) => (
    <div style={{ display: 'flex', gap: 6 }}>
      <button className="btn btn-ghost btn-sm" onClick={() => doExport(report, 'xlsx')}><FileSpreadsheet size={14} /> {t('excel')}</button>
      <button className="btn btn-ghost btn-sm" onClick={() => doExport(report, 'pdf')}><FileText size={14} /> PDF</button>
    </div>
  );

  const revenueChart = (revenue?.series || []).map((p) => ({ day: shortDate(p.date), net: Number(p.net) }));
  const statusChart = Object.entries(bookings?.by_status || {})
    .map(([k, v]) => ({ status: k.replace('_', ' '), count: v }));

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
    // A docked side panel, not an overlay. With the assistant open the page
    // becomes two columns and the report narrows to make room; with it closed
    // the report has the whole width back. The panel used to be
    // `position: fixed`, which floated it over the page and clipped its head
    // under the top bar.
    <div className={`rp-shell${aiOpen ? ' is-split' : ''}`}>
      <div className="rp-main">
      <PageHeader
        title={t('reports')}
        subtitle={t('revenueBookingsStaffPerformance')}
        actions={
          <div className="action-row">
            <button
              type="button"
              className={`ai-trigger${aiOpen ? ' is-open' : ''}`}
              aria-expanded={aiOpen}
              title={t('insights.title')}
              onClick={() => setAiOpen((open) => !open)}
            >
              <Sparkles size={15} className="ai-trigger__spark" />
              {t('insights.title')}
            </button>
            <button className="btn btn-secondary" onClick={() => doExport('revenue', 'xlsx')}><FileSpreadsheet size={15} /> {t('excel')}</button>
            <button className="btn btn-secondary" onClick={() => doExport('revenue', 'pdf')}><FileText size={15} /> PDF</button>
          </div>
        }
      />

      {/* A report the assistant produced, opened into the page's own
          workspace where a chart has room to be read. */}
      {fullReport && (
        <div className="card ai-report">
          <div className="card-body">
            <div className="ai-report__head">
              <div>
                <h3 className="ai-report__question">{fullReport.question}</h3>
                {fullReport.answer && <p className="ai-report__answer">{fullReport.answer}</p>}
                <div className="ai-report__meta">
                  {fullReport.cached ? t('insights.reused') : t('insights.freshlyGenerated')}
                </div>
              </div>
              <button type="button" className="icon-btn" title={t('common:actions.close')}
                onClick={() => setFullReport(null)}>
                <X size={18} />
              </button>
            </div>
            <InsightWidgets widgets={fullReport.widgets} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
        <div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>{t('from')}</div>
          <input className="form-input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>To</div>
          <input className="form-input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <div style={{ flex: '1 1 180px', minWidth: 0, maxWidth: 260 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>{t('common:labels.club')}</div>
          <Select2
            options={clubs.rows.map((s) => ({ value: s.id, label: s.name }))}
            value={club} onChange={(v) => setClub(v || '')} placeholder={t('allClubs')} clearable
          />
        </div>
        {(dateFrom || dateTo || club) && (
          <button className="btn btn-ghost" onClick={() => { setDateFrom(''); setDateTo(''); setClub(''); }}>
            {t('common:actions.clear')}
          </button>
        )}
      </div>

      {loading ? (
        <div className="card"><div className="card-body center" style={{ padding: 48 }}><span className="muted">Loading reports…</span></div></div>
      ) : (
        <>
          <div className="metric-grid">
            <MetricCard label={t('grossRevenue')} value={<Money amount={revenue?.gross_revenue} />} icon={Download} tint="blue" />
            <MetricCard label={t('refunded')} value={<Money amount={revenue?.refunded} />} icon={Download} tint="rose" />
            <MetricCard label={t('netRevenue')} value={<Money amount={revenue?.net_revenue} />} icon={Download} tint="green" />
            <MetricCard label={t('bookings')} value={String(bookings?.total ?? 0)} icon={Download} tint="purple" />
          </div>

          <div className="chart-row">
            <div className="card">
              <div className="card-header"><h3 className="card-title">{t('netRevenueDay')}</h3></div>
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
              <div className="card-header"><h3 className="card-title">{t('bookingsStatus')}</h3></div>
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
                <h3 className="card-title">{t('club')}</h3>
                {exportButtons('club')}
              </div>
              <DataTable
                rows={clubRows}
                emptyTitle={t('noClubData')}
                emptyHint={t('bookingsPaymentsTiedClubAppear')}
                columns={[
                  { key: 'name', header: t('common:labels.club'), render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
                  { key: 'count', header: t('bookings'), render: (r) => r.count },
                  { key: 'net', header: t('netRevenue'), render: (r) => <Money amount={r.net} /> },
                ]}
              />
            </div>

            <div className="card">
              <div className="card-header">
                <h3 className="card-title">{t('topServices')}</h3>
                {exportButtons('services')}
              </div>
              <DataTable
                rows={topServices}
                emptyTitle={t('noServiceData')}
                emptyHint={t('bookingsServiceAppearHere')}
                columns={[
                  { key: 'name', header: t('service'), render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span> },
                  { key: 'bookings', header: t('bookings'), render: (r) => r.bookings },
                  { key: 'net', header: t('netRevenue'), render: (r) => <Money amount={r.net} /> },
                ]}
              />
            </div>
          </div>

          <div style={{ height: 24 }} />

          <div className="card">
            <div className="card-header"><h3 className="card-title">{t('staffPerformance')}</h3></div>
            <DataTable
              rows={performance}
              emptyTitle={t('noStaffYet')}
              emptyHint={t('addStaffSeePerformance')}
              columns={[
                { key: 'name', header: t('staff'), render: (r) => (
                  <div><div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{r.employee_id} · {r.role}</div></div>
                ) },
                { key: 'jobs', header: t('bookingsCompleted'), render: (r) => r.jobs_completed },
                { key: 'rating', header: t('rating'), render: (r) => Number(r.rating).toFixed(1) },
              ]}
            />
          </div>

          <div style={{ height: 24 }} />

          <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>{t('memberships')}</h3>
          <div className="metric-grid">
            <MetricCard label={t('common:state.active')} value={String(memberships?.active ?? 0)} icon={Download} tint="green" />
            <MetricCard label={t('expiring30d')} value={String(memberships?.expiring_soon ?? 0)} icon={Download} tint="amber" />
            <MetricCard label={t('expired')} value={String(memberships?.expired ?? 0)} icon={Download} tint="rose" />
            <MetricCard label={t('revenue')} value={<Money amount={memberships?.revenue} code={memberships?.currency} />} icon={Download} tint="blue" />
            <MetricCard label={t('sessionsUsed')} value={String(memberships?.units_consumed ?? 0)} icon={Download} tint="purple" />
          </div>

          <div style={{ height: 12 }} />

          <div className="card">
            <div className="card-header"><h3 className="card-title">{t('activePlan')}</h3></div>
            <DataTable
              rows={memberships?.by_plan || []}
              emptyTitle={t('noActiveMemberships')}
              emptyHint={t('issueMembershipsSeePlanUptake')}
              columns={[
                { key: 'plan', header: t('plan'), render: (r) => r.plan },
                { key: 'active', header: t('common:state.active'), render: (r) => r.active },
              ]}
            />
          </div>

          {(memberships?.expiring_list || []).length > 0 && (
            <>
              <div style={{ height: 12 }} />
              <div className="card">
                <div className="card-header"><h3 className="card-title">{t('expiringSoon')}</h3></div>
                <DataTable
                  rows={memberships.expiring_list}
                  columns={[
                    { key: 'number', header: t('membership'), render: (r) => r.number },
                    { key: 'customer', header: t('common:labels.customer'), render: (r) => r.customer },
                    { key: 'plan', header: t('plan'), render: (r) => r.plan },
                    { key: 'end_date', header: t('expires'), render: (r) => new Date(r.end_date).toLocaleDateString() },
                  ]}
                />
              </div>
            </>
          )}
        </>
      )}

      </div>

      {aiOpen && (
        <div className="rp-side">
          <AiInsightsPanel
            scope={{
              period: dateFrom || dateTo
                ? [dateFrom, dateTo].filter(Boolean).join(' - ')
                : t('insights.allDates'),
              club: club
                ? (clubs.rows.find((row) => String(row.id) === String(club))?.name
                  || t('insights.oneClub'))
                : t('allClubs'),
            }}
            open={aiOpen}
            onClose={() => setAiOpen(false)}
            onOpenFullReport={(turn) => { setFullReport(turn); setAiOpen(false); }}
          />
        </div>
      )}
    </div>
  );
}
