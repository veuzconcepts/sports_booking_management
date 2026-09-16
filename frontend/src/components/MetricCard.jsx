import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

const TINTS = {
  blue:   { fg: '#2563eb', bg: '#dbeafe' },
  green:  { fg: '#059669', bg: '#d1fae5' },
  amber:  { fg: '#d97706', bg: '#fef3c7' },
  purple: { fg: '#7c3aed', bg: '#ede9fe' },
  rose:   { fg: '#e11d48', bg: '#ffe4e6' },
};

export function MetricCard({ label, value, delta, deltaDirection = 'up', icon: Icon, tint = 'blue' }) {
  const palette = TINTS[tint] || TINTS.blue;
  return (
    <div className="metric-card">
      <div className="metric-icon" style={{ background: palette.bg, color: palette.fg }}>
        {Icon ? <Icon size={18} /> : null}
      </div>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {delta != null && (
        <div className={`metric-delta ${deltaDirection}`}>
          {deltaDirection === 'up' ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          <span>{delta}</span>
          <span className="muted" style={{ fontWeight: 500 }}>vs last week</span>
        </div>
      )}
    </div>
  );
}
