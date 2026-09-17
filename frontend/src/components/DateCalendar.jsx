import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Date picker that disables any weekday in `closedWeekdays` (a Set of JS
 * getDay() indices, 0=Sun … 6=Sat) and anything outside [minDate, maxDate] -
 * used so the booking calendar only offers days the club is open AND the
 * booking policy allows.
 */
export function DateCalendar({ value, onChange, closedWeekdays = new Set(), minDate, maxDate, placeholder }) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const seed = value ? new Date(`${value}T00:00:00`) : new Date();
  const [view, setView] = useState({ y: seed.getFullYear(), m: seed.getMonth() });

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  useEffect(() => {
    if (value) { const d = new Date(`${value}T00:00:00`); setView({ y: d.getFullYear(), m: d.getMonth() }); }
  }, [value]);

  const minD = minDate ? new Date(`${minDate}T00:00:00`) : null;
  const maxD = maxDate ? new Date(`${maxDate}T00:00:00`) : null;
  const startDow = new Date(view.y, view.m, 1).getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(new Date(view.y, view.m, day));

  const isClosed = (d) => closedWeekdays.has(d.getDay());
  const isDisabled = (d) => isClosed(d) || (minD && d < minD) || (maxD && d > maxD);
  const prev = () => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }));
  const next = () => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }));

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="form-input"
        style={{ textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        onClick={() => setOpen((o) => !o)}>
        <Calendar size={15} style={{ color: 'var(--color-text-muted)' }} />
        {value || <span className="muted">{placeholder || t('datePlaceholder')}</span>}
      </button>
      {open && (
        <div style={{ position: 'absolute', zIndex: 60, top: 'calc(100% + 4px)', insetInlineStart: 0, background: '#fff',
          border: '1px solid var(--color-border)', borderRadius: 10, padding: 10,
          width: 'min(264px, calc(100vw - 32px))',
          boxShadow: '0 10px 28px rgba(0,0,0,0.14)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <button type="button" className="icon-btn" onClick={prev}><ChevronLeft size={16} /></button>
            <strong style={{ fontSize: 13.5 }}>{MONTHS[view.m]} {view.y}</strong>
            <button type="button" className="icon-btn" onClick={next}><ChevronRight size={16} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
            {DOW.map((d) => (
              <div key={d} className="muted" style={{ fontSize: 11, fontWeight: 600, padding: '2px 0' }}>{d}</div>
            ))}
            {cells.map((d, i) => {
              if (!d) return <div key={`e${i}`} />;
              const dis = isDisabled(d);
              const sel = value === ymd(d);
              return (
                <button key={ymd(d)} type="button" disabled={dis}
                  onClick={() => { onChange(ymd(d)); setOpen(false); }}
                  title={isClosed(d) ? t('clubClosed') : undefined}
                  style={{
                    padding: '6px 0', fontSize: 12.5, borderRadius: 6, border: 'none',
                    cursor: dis ? 'not-allowed' : 'pointer',
                    background: sel ? 'var(--color-primary, #6366f1)' : 'transparent',
                    color: sel ? '#fff' : (dis ? 'var(--color-text-muted, #9aa1ad)' : 'var(--color-text)'),
                    opacity: dis ? 0.45 : 1,
                    textDecoration: isClosed(d) ? 'line-through' : 'none',
                  }}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>{t('struckThroughDaysClosedClub')}</div>
        </div>
      )}
    </div>
  );
}
