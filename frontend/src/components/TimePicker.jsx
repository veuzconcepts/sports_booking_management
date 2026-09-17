import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock } from 'lucide-react';

import { useTimeFormat } from '../services/timeformat.jsx';

/**
 * A compact time-of-day control: ONE field showing "08:00 AM", typeable, with a
 * dropdown of the usual times.
 *
 * It replaces the three stacked selects (hour / minute / AM-PM) that made a
 * single shift row six controls wide, which is what stopped a weekly schedule
 * fitting on one screen. Value and onChange stay 24-hour "HH:MM" strings, so it
 * is a drop-in for the old control and the stored shape does not change.
 *
 * Typing is deliberately forgiving: "9", "930", "9:30", "9.30", "9pm",
 * "21:30" all land on the right time, because an admin setting seven days of
 * hours should not have to reach for the mouse. A bare hour is read literally -
 * "6" is 06:00, not 18:00.
 */
const pad = (n) => String(n).padStart(2, '0');

/** "HH:MM" -> minutes past midnight; null when unusable. */
export function toMinutes(value) {
  const [h, m] = String(value || '').split(':');
  const hh = parseInt(h, 10);
  if (Number.isNaN(hh)) return null;
  return hh * 60 + (parseInt(m, 10) || 0);
}

export function fromMinutes(total) {
  const t = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

/** Display a stored "HH:MM" per the organization's 12/24-hour preference. */
export function displayTime(value, format24) {
  const mins = toMinutes(value);
  if (mins === null) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (format24) return `${pad(h)}:${pad(m)}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}

/**
 * Parse what a person actually types into "HH:MM", or null.
 * Accepts 9 | 930 | 9:30 | 9.30 | 9 30 | 9pm | 9:30 pm | 21:30 | 2130.
 */
export function parseTimeInput(raw, { format24 = false } = {}) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;

  const pm = /p/.test(text);
  const am = /a/.test(text);
  const digits = text.replace(/[^\d]/g, '');
  if (!digits) return null;

  let h;
  let m = 0;
  if (/[:.\s]/.test(text)) {
    const [left, right] = text.split(/[:.\s]+/);
    h = parseInt(left.replace(/\D/g, ''), 10);
    m = parseInt((right || '0').replace(/\D/g, ''), 10) || 0;
  } else if (digits.length <= 2) {
    h = parseInt(digits, 10);
  } else {
    h = parseInt(digits.slice(0, digits.length - 2), 10);
    m = parseInt(digits.slice(-2), 10);
  }

  if (Number.isNaN(h) || Number.isNaN(m) || m > 59) return null;

  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  // A bare hour is taken literally. Guessing that "6" means 18:00 would be
  // right about as often as it was wrong, and a silently wrong opening time is
  // worse than typing two more characters.
  if (h === 24) h = 0;
  if (h > 23) return null;
  return `${pad(h)}:${pad(m)}`;
}

/** Every :00 and :30 through the day, for the dropdown. */
function suggestions(step) {
  const out = [];
  for (let m = 0; m < 1440; m += step) out.push(fromMinutes(m));
  return out;
}

export function TimePicker({
  value, onChange, disabled, invalid, step = 30, ariaLabel = 'Time',
}) {
  const { format24 } = useTimeFormat();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);      // non-null while being typed
  const wrap = useRef(null);
  const listRef = useRef(null);

  const options = useMemo(() => suggestions(step), [step]);
  const shown = draft !== null ? draft : displayTime(value, format24);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrap.current && !wrap.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Open the list at the current value rather than at midnight.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const active = listRef.current.querySelector('[data-on="1"]');
    if (active) active.scrollIntoView({ block: 'center' });
  }, [open]);

  function commit(text) {
    const parsed = parseTimeInput(text, { format24 });
    setDraft(null);
    if (parsed && parsed !== value) onChange?.(parsed);
  }

  return (
    <div className={`tp${invalid ? ' tp--invalid' : ''}`} ref={wrap}>
      <input
        className="tp-input"
        type="text"
        inputMode="numeric"
        aria-label={ariaLabel}
        disabled={disabled}
        value={shown}
        placeholder={format24 ? '00:00' : '12:00 AM'}
        onFocus={() => setOpen(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); setOpen(false); }
          if (e.key === 'Escape') { setDraft(null); setOpen(false); }
        }}
      />
      <button type="button" className="tp-btn" tabIndex={-1} disabled={disabled}
        aria-label={`Choose ${ariaLabel.toLowerCase()}`}
        onClick={() => setOpen((o) => !o)}>
        <Clock size={13} />
      </button>

      {open && !disabled && (
        <ul className="tp-list" ref={listRef} role="listbox">
          {options.map((opt) => (
            <li key={opt}>
              <button type="button" data-on={opt === value ? '1' : '0'}
                className={`tp-opt${opt === value ? ' is-on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setDraft(null); onChange?.(opt); setOpen(false); }}>
                {displayTime(opt, format24)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
