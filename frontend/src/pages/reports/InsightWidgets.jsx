import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useTranslation } from 'react-i18next';

import { Money } from '../../services/currency.jsx';

/**
 * Renders a report the assistant produced.
 *
 * The model returns prose; the widget list is built on the backend from the
 * shape of the verified data. Nothing here evaluates anything the model wrote,
 * and an unrecognised widget type is skipped rather than guessed at, so a
 * change at the other end cannot turn into markup injection.
 *
 * Charts come from recharts, which the Reports page already uses.
 */

const PALETTE = [
  'var(--color-primary-600)',
  'var(--color-info-600)',
  'var(--color-success-600)',
  'var(--color-warning-600)',
  'var(--color-danger-600)',
  'var(--color-primary-400)',
];

const AXIS = { fontSize: 11, stroke: 'var(--color-text-muted)' };
const GRID = 'var(--color-border-soft)';

function formatted(value, format) {
  if (value === null || value === undefined || value === '') return '-';
  if (format === 'money') return <Money amount={value} />;
  if (format === 'percent') return `${value}%`;
  return String(value);
}

function Kpis({ widget }) {
  return (
    <div className="ai-kpis">
      {(widget.items || []).map((item) => (
        <div className="ai-kpi" key={item.label}>
          <span className="ai-kpi__label">{item.label}</span>
          <span className="ai-kpi__value">{formatted(item.value, item.format)}</span>
        </div>
      ))}
    </div>
  );
}

function Chart({ widget, height = 180 }) {
  const rows = widget.rows || [];
  if (!rows.length) return null;

  return (
    <div className="ai-widget">
      {widget.title && <div className="ai-widget__title">{widget.title}</div>}
      {/* The container sizes from its parent, so the same widget works in the
          narrow panel and in the full-width workspace. */}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {widget.type === 'donut' ? (
            <PieChart>
              <Pie
                data={rows} dataKey={widget.y} nameKey={widget.x}
                innerRadius="50%" outerRadius="80%" paddingAngle={2}
              >
                {rows.map((row, index) => (
                  <Cell key={row[widget.x]} fill={PALETTE[index % PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          ) : widget.type === 'bar' ? (
            <BarChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey={widget.x} tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} />
              <Tooltip />
              <Bar dataKey={widget.y} fill="var(--color-primary-600)" radius={[4, 4, 0, 0]} />
            </BarChart>
          ) : (
            <AreaChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey={widget.x} tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} />
              <Tooltip />
              <Area
                type="monotone" dataKey={widget.y}
                stroke="var(--color-primary-600)" fill="var(--color-primary-100)"
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Table({ widget }) {
  const columns = widget.columns || [];
  const rows = widget.rows || [];
  if (!columns.length || !rows.length) return null;

  return (
    <div className="ai-widget">
      {widget.title && <div className="ai-widget__title">{widget.title}</div>}
      {/* Scrolls inside its own card rather than widening the panel. */}
      <div className="ai-table-wrap scroll-x">
        <table className="table ai-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} style={column.align === 'right' ? { textAlign: 'end' } : undefined}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              // Report rows have no id of their own; the position is stable
              // because the dataset is a fixed snapshot.
              // eslint-disable-next-line react/no-array-index-key
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column.key} style={column.align === 'right' ? { textAlign: 'end' } : undefined}>
                    {formatted(row[column.key], column.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function InsightWidgets({ widgets, compact = false }) {
  const { t } = useTranslation('reports');
  if (!widgets?.length) return null;

  return (
    <div className={`ai-widgets${compact ? ' ai-widgets--compact' : ''}`}>
      {widgets.map((widget, index) => {
        // eslint-disable-next-line react/no-array-index-key
        const key = `${widget.type}-${widget.title || index}`;
        if (widget.type === 'kpi') return <Kpis widget={widget} key={key} />;
        if (widget.type === 'table') return <Table widget={widget} key={key} />;
        if (['line', 'bar', 'donut'].includes(widget.type)) {
          return <Chart widget={widget} key={key} height={compact ? 160 : 260} />;
        }
        return null;      // an unknown type is skipped, never rendered raw
      })}
      {compact && (
        <p className="ai-widgets__note">{t('insights.previewNote')}</p>
      )}
    </div>
  );
}
