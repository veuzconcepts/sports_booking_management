import { useTimeFormat } from '../services/timeformat.jsx';

/**
 * Time-of-day picker that honours the Organization 12h/24h preference regardless
 * of the OS locale (a native <input type="time"> follows the OS, which is why the
 * preference was being ignored). Value + onChange use 24-hour "HH:MM" strings.
 */
const pad = (n) => String(n).padStart(2, '0');
const RANGE = (n) => Array.from({ length: n }, (_, i) => i);

export function TimeInput({ value, onChange, disabled, style }) {
  const { format24 } = useTimeFormat();
  const [hRaw, mRaw] = (value || '').split(':');
  const h = hRaw === undefined || hRaw === '' ? '' : parseInt(hRaw, 10);
  const m = mRaw === undefined || mRaw === '' ? '' : parseInt(mRaw, 10);

  const emit = (hh, mm) => {
    if (hh === '' || mm === '') { onChange?.(''); return; }
    onChange?.(`${pad(hh)}:${pad(mm)}`);
  };

  const sel = { ...style };
  const minuteSelect = (
    <select className="form-input" style={{ maxWidth: 78 }} disabled={disabled}
      value={m === '' ? '' : m}
      onChange={(e) => emit(h === '' ? 0 : h, e.target.value === '' ? '' : Number(e.target.value))}>
      <option value="">--</option>
      {RANGE(60).map((i) => <option key={i} value={i}>{pad(i)}</option>)}
    </select>
  );

  if (format24) {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', ...sel }}>
        <select className="form-input" style={{ maxWidth: 78 }} disabled={disabled}
          value={h === '' ? '' : h}
          onChange={(e) => emit(e.target.value === '' ? '' : Number(e.target.value), m === '' ? 0 : m)}>
          <option value="">--</option>
          {RANGE(24).map((i) => <option key={i} value={i}>{pad(i)}</option>)}
        </select>
        <span>:</span>
        {minuteSelect}
      </div>
    );
  }

  // 12-hour mode: hour 1-12 + minute + AM/PM, mapped back to 24h on change.
  const period = h === '' ? 'AM' : (h >= 12 ? 'PM' : 'AM');
  const h12 = h === '' ? '' : (h % 12 === 0 ? 12 : h % 12);
  const emit12 = (hh12, mm, pp) => {
    if (hh12 === '' || mm === '') { onChange?.(''); return; }
    let h24 = hh12 % 12;
    if (pp === 'PM') h24 += 12;
    emit(h24, mm);
  };
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', ...sel }}>
      <select className="form-input" style={{ maxWidth: 72 }} disabled={disabled}
        value={h12 === '' ? '' : h12}
        onChange={(e) => emit12(e.target.value === '' ? '' : Number(e.target.value), m === '' ? 0 : m, period)}>
        <option value="">--</option>
        {RANGE(12).map((i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
      </select>
      <span>:</span>
      <select className="form-input" style={{ maxWidth: 72 }} disabled={disabled}
        value={m === '' ? '' : m}
        onChange={(e) => emit12(h12 === '' ? 12 : h12, e.target.value === '' ? '' : Number(e.target.value), period)}>
        <option value="">--</option>
        {RANGE(60).map((i) => <option key={i} value={i}>{pad(i)}</option>)}
      </select>
      <select className="form-input" style={{ maxWidth: 70 }} disabled={disabled}
        value={period}
        onChange={(e) => emit12(h12 === '' ? 12 : h12, m === '' ? 0 : m, e.target.value)}>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}
