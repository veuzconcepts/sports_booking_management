import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, Coffee, Copy, MoreVertical, Plus, RotateCcw, X,
} from 'lucide-react';

import { TimePicker } from './TimePicker.jsx';
import { useTimeFormat } from '../services/timeformat.jsx';
import {
  CLOSED_DAY, DAY_KEYS, DAY_LABELS, DAY_SHORT, SLOT_OPTIONS, TEMPLATES,
  WEEKDAYS, WEEKEND, copyDayTo, displayTime, normalizeDay, openDay, setEveryDay,
  spansMidnight, summarizeDay, toMinutes, validateWeek, windowMinutes,
} from '../utils/schedule.js';
import './schedule.css';

const DAY = 24 * 60;

/** Reopening a day keeps the hours it had before it was closed, when it had any. */
function reopen(cfg) {
  const previous = normalizeDay(cfg);
  return previous.shifts.length
    ? { closed: false, shifts: previous.shifts, breaks: previous.breaks || [] }
    : openDay('08:00', '22:00');
}

/* ------------------------------------------------------------------ menu -- */
function Menu({ label, icon, children, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="sch-menu" ref={wrap}>
      <button type="button" className={icon ? 'icon-btn' : 'btn btn-secondary'}
        aria-label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon || <>{label} <ChevronDown size={14} /></>}
      </button>
      {open && (
        <div className="sch-menu__pop" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}
          onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

const Item = ({ onClick, danger, children }) => (
  <button type="button" className={`sch-menu__item${danger ? ' sch-menu__item--danger' : ''}`}
    onClick={onClick}>{children}</button>
);

/* ------------------------------------------------------------- header bar - */
function HeaderBar({
  slotMinutes, onSlotMinutes, bufferBefore, bufferAfter, onBuffers,
  week, onWeek, canEdit, showTemplates,
}) {
  const [custom, setCustom] = useState(
    () => slotMinutes != null && !SLOT_OPTIONS.includes(Number(slotMinutes)));

  return (
    <div className="sch-bar">
      <div className="sch-bar__group">
        <span className="sch-bar__label">Slot duration</span>
        {custom ? (
          <input className="sch-num" type="number" min="1" max="1440" disabled={!canEdit}
            value={slotMinutes ?? ''} aria-label="Slot duration in minutes"
            onChange={(e) => onSlotMinutes(e.target.value === '' ? null : Number(e.target.value))} />
        ) : (
          <select className="sch-select" disabled={!canEdit} value={slotMinutes ?? ''}
            aria-label="Slot duration"
            onChange={(e) => {
              if (e.target.value === 'custom') { setCustom(true); return; }
              onSlotMinutes(e.target.value === '' ? null : Number(e.target.value));
            }}>
            <option value="">Inherit</option>
            {SLOT_OPTIONS.map((m) => <option key={m} value={m}>{m} min</option>)}
            <option value="custom">Custom…</option>
          </select>
        )}
        {custom && (
          <button type="button" className="icon-btn" title="Back to the usual durations"
            onClick={() => setCustom(false)}><X size={14} /></button>
        )}
      </div>

      <div className="sch-bar__group">
        <span className="sch-bar__label" title="Held before each booking, for setup">
          Buffer before
        </span>
        <input className="sch-num" type="number" min="0" max="240" disabled={!canEdit}
          value={bufferBefore ?? ''} aria-label="Buffer before a booking, in minutes"
          onChange={(e) => onBuffers(e.target.value === '' ? null : Number(e.target.value), bufferAfter)} />
      </div>
      <div className="sch-bar__group">
        <span className="sch-bar__label" title="Held after each booking, for changeover">
          Buffer after
        </span>
        <input className="sch-num" type="number" min="0" max="240" disabled={!canEdit}
          value={bufferAfter ?? ''} aria-label="Buffer after a booking, in minutes"
          onChange={(e) => onBuffers(bufferBefore, e.target.value === '' ? null : Number(e.target.value))} />
      </div>

      <div className="sch-bar__spacer" />

      {canEdit && showTemplates && (
        <Menu label="Templates">
          <div className="sch-menu__group">Start from</div>
          {TEMPLATES.map((t) => (
            <Item key={t.key} onClick={() => onWeek(t.build())}>
              {t.label}
              <div className="muted" style={{ fontSize: 11.5 }}>{t.detail}</div>
            </Item>
          ))}
        </Menu>
      )}

      {canEdit && (
        <Menu label="Quick actions">
          <div className="sch-menu__group">Apply Monday to</div>
          <Item onClick={() => onWeek(copyDayTo(week, 'mon', DAY_KEYS))}>All days</Item>
          <Item onClick={() => onWeek(copyDayTo(week, 'mon', WEEKDAYS))}>Weekdays</Item>
          <Item onClick={() => onWeek(copyDayTo(week, 'mon', WEEKEND))}>Weekend</Item>
          <hr className="sch-menu__sep" />
          <Item onClick={() => onWeek(setEveryDay(week, openDay('08:00', '22:00')))}>
            Set all open
          </Item>
          <Item onClick={() => onWeek(setEveryDay(week, { ...CLOSED_DAY }))}>
            Set all closed
          </Item>
        </Menu>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- day row - */
function DayRow({
  dayKey, cfg, inherited, source, error, expanded, canEdit,
  onToggle, onExpand, onCopy, onReset, format24, isOverride,
}) {
  const day = normalizeDay(cfg ?? inherited);
  const breaks = day.breaks || [];
  const overnight = day.shifts.some((s) => spansMidnight(s.open, s.close));

  return (
    <div className={`sch-row${day.closed ? ' sch-row--closed' : ''}`
      + `${expanded ? ' sch-row--open-detail' : ''}`
      + `${error ? ' sch-row--invalid' : ''}`}>
      <button type="button" className="sch-row__day link-btn" onClick={onExpand}
        aria-expanded={expanded}
        style={{ display: 'flex', alignItems: 'center', gap: 4, textAlign: 'left' }}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {DAY_LABELS[dayKey]}
      </button>

      <label className={`sch-toggle sch-row__status${day.closed ? ' sch-toggle--off' : ''}`}>
        <input type="checkbox" checked={!day.closed} disabled={!canEdit}
          onChange={(e) => onToggle(e.target.checked)} />
        {day.closed ? 'Closed' : 'Open'}
      </label>

      <div className="sch-row__hours">
        {day.closed ? <span>Closed all day</span> : day.shifts.map((s, i) => (
          <span key={i}>
            {displayTime(s.open, format24)}
            <span className="sch-row__sep"> - </span>
            {displayTime(s.close, format24)}
            {i < day.shifts.length - 1 ? ',' : ''}
          </span>
        ))}
        {!day.closed && day.shifts.length === 0 && (
          <span className="muted">No hours set</span>
        )}
        {overnight && <span className="sch-badge sch-badge--overnight">Overnight</span>}
      </div>

      <div className="sch-row__meta">
        {breaks.length > 0
          ? <span className="sch-badge sch-badge--break">
            {breaks.length} break{breaks.length > 1 ? 's' : ''}
          </span>
          : <span className="muted" style={{ fontSize: 12 }}>No breaks</span>}
      </div>

      <div className="sch-row__meta">
        <span className={`sch-badge sch-badge--${isOverride ? 'custom' : 'inherited'}`}>
          {isOverride ? 'Custom' : source}
        </span>
      </div>

      <div className="sch-row__menu">
        {canEdit && (
          <Menu label={`${DAY_LABELS[dayKey]} actions`} icon={<MoreVertical size={15} />}>
            <div className="sch-menu__group">Copy {DAY_SHORT[dayKey]} to</div>
            {DAY_KEYS.filter((d) => d !== dayKey).map((d) => (
              <Item key={d} onClick={() => onCopy([d])}>{DAY_LABELS[d]}</Item>
            ))}
            <hr className="sch-menu__sep" />
            <Item onClick={() => onCopy(WEEKDAYS)}>Weekdays</Item>
            <Item onClick={() => onCopy(WEEKEND)}>Weekend</Item>
            <Item onClick={() => onCopy(DAY_KEYS)}>All days</Item>
            {isOverride && onReset && (
              <>
                <hr className="sch-menu__sep" />
                <Item danger onClick={onReset}>Reset to {source.toLowerCase()}</Item>
              </>
            )}
          </Menu>
        )}
      </div>

      {error && <div className="sch-row__err">{error}</div>}
    </div>
  );
}

/* ------------------------------------------------------- expanded editor -- */
function DayDetail({ dayKey, cfg, inherited, canEdit, onChange }) {
  const day = normalizeDay(cfg ?? inherited);
  if (day.closed) {
    return (
      <div className="sch-detail">
        <span className="muted" style={{ fontSize: 13 }}>
          {DAY_LABELS[dayKey]} is closed. Switch it to Open to set hours.
        </span>
      </div>
    );
  }

  const set = (next) => onChange({ closed: false, ...next });
  const shifts = day.shifts;
  const breaks = day.breaks || [];

  return (
    <div className="sch-detail">
      <div className="sch-detail__section">
        <div className="sch-detail__title">Operating hours</div>
        {shifts.map((s, i) => (
          <div className="sch-line" key={i}>
            <TimePicker value={s.open} disabled={!canEdit} ariaLabel="Opens"
              onChange={(v) => set({
                shifts: shifts.map((x, j) => (j === i ? { ...x, open: v } : x)), breaks,
              })} />
            <span className="sch-row__sep">to</span>
            <TimePicker value={s.close} disabled={!canEdit} ariaLabel="Closes"
              onChange={(v) => set({
                shifts: shifts.map((x, j) => (j === i ? { ...x, close: v } : x)), breaks,
              })} />
            {spansMidnight(s.open, s.close) && (
              <span className="sch-badge sch-badge--overnight">Next day</span>
            )}
            {canEdit && shifts.length > 1 && (
              <button type="button" className="icon-btn" title="Remove shift"
                onClick={() => set({ shifts: shifts.filter((_, j) => j !== i), breaks })}>
                <X size={14} />
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <button type="button" className="sch-add"
            onClick={() => set({ shifts: [...shifts, { open: '16:00', close: '22:00' }], breaks })}>
            <Plus size={13} /> Add shift
          </button>
        )}
      </div>

      <div className="sch-detail__section">
        <div className="sch-detail__title">Breaks</div>
        {breaks.length === 0 && (
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
            No breaks. A break blocks bookings inside the operating hours.
          </div>
        )}
        {breaks.map((b, i) => (
          <div className="sch-line" key={i}>
            <input className="sch-line__name" placeholder="Name, e.g. Maintenance"
              value={b.name || ''} disabled={!canEdit} aria-label="Break name"
              onChange={(e) => set({
                shifts, breaks: breaks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
              })} />
            <TimePicker value={b.open} disabled={!canEdit} ariaLabel="Break starts"
              onChange={(v) => set({
                shifts, breaks: breaks.map((x, j) => (j === i ? { ...x, open: v } : x)),
              })} />
            <span className="sch-row__sep">to</span>
            <TimePicker value={b.close} disabled={!canEdit} ariaLabel="Break ends"
              onChange={(v) => set({
                shifts, breaks: breaks.map((x, j) => (j === i ? { ...x, close: v } : x)),
              })} />
            {canEdit && (
              <button type="button" className="icon-btn" title="Remove break"
                onClick={() => set({ shifts, breaks: breaks.filter((_, j) => j !== i) })}>
                <X size={14} />
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <button type="button" className="sch-add"
            onClick={() => set({
              shifts,
              breaks: [...breaks, { name: '', open: '13:00', close: '14:00' }],
            })}>
            <Coffee size={13} /> Add break
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- weekly timeline */
export function WeeklyTimeline({ week, format24 }) {
  return (
    <div className="sch-timeline">
      {DAY_KEYS.map((key) => {
        const day = normalizeDay(week[key]);
        return (
          <div className="sch-tl-row" key={key}>
            <span>{DAY_LABELS[key]}</span>
            <div className="sch-tl-track" title={summarizeDay(day, format24)}>
              {!day.closed && day.shifts.map((s, i) => {
                const start = toMinutes(s.open) ?? 0;
                const length = windowMinutes(s.open, s.close) || 0;
                return (
                  <div key={`s${i}`} className="sch-tl-open"
                    style={{ left: `${(start / DAY) * 100}%`,
                      width: `${(Math.min(length, DAY - start) / DAY) * 100}%` }} />
                );
              })}
              {!day.closed && (day.breaks || []).map((b, i) => {
                const start = toMinutes(b.open) ?? 0;
                const length = windowMinutes(b.open, b.close) || 0;
                return (
                  <div key={`b${i}`} className="sch-tl-break"
                    style={{ left: `${(start / DAY) * 100}%`,
                      width: `${(Math.min(length, DAY - start) / DAY) * 100}%` }} />
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="sch-tl-scale">
        <span />
        <div className="sch-tl-scale__marks">
          {['00:00', '06:00', '12:00', '18:00', '24:00'].map((t) => (
            <span key={t}>{t === '24:00' ? t : displayTime(t, format24)}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------- effective (read-only) */
export function EffectiveSchedule({ week, format24 }) {
  return (
    <div className="sch-eff">
      {DAY_KEYS.map((key) => {
        const cfg = week?.[key] || {};
        const day = normalizeDay(cfg);
        const breaks = day.breaks || [];
        return (
          <div className="sch-eff__row" key={key}>
            <span style={{ fontWeight: 600 }}>{DAY_LABELS[key]}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {summarizeDay(day, format24)}
              {breaks.length > 0 && (
                <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  break {breaks.map((b) => `${displayTime(b.open, format24)}-${displayTime(b.close, format24)}`).join(', ')}
                </span>
              )}
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              {day.closed && <span className="sch-badge sch-badge--closed">Closed</span>}
              {breaks.length > 0 && <span className="sch-badge sch-badge--break">Break</span>}
              <span className={`sch-badge sch-badge--${cfg.source === 'organization' ? 'inherited' : 'custom'}`}>
                {cfg.source === 'organization' ? 'Organization'
                  : cfg.source === 'club' ? 'Club' : 'Custom'}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ================================================================= editor == */
/**
 * The compact weekly scheduler, used unchanged at all three scopes.
 *
 * `value` is the scope's OWN document. At organization level it is a complete
 * week; at club and facility level it is an override that may hold only the
 * days that differ, and `inherited` supplies the rest for display. Removing a
 * day from `value` returns that day to the parent - nothing is ever copied
 * down, so the parent stays live.
 */
export function ScheduleEditor({
  scope = 'organization',
  parentLabel = 'Organization',
  value,
  onChange,
  inherited,
  slotMinutes,
  onSlotMinutes,
  bufferBefore,
  bufferAfter,
  onBuffers,
  canEdit = true,
  onResetAll,
  // A staff roster uses the same weekly document but has no slot interval or
  // buffers, so it hides the configuration bar rather than forking the editor.
  showConfig = true,
}) {
  const { format24 } = useTimeFormat();
  const [expanded, setExpanded] = useState(null);
  const week = value || {};
  const isChild = scope !== 'organization';

  const { errors } = useMemo(
    () => validateWeek(week, { partial: isChild }), [week, isChild]);

  function setDay(key, cfg) {
    onChange({ ...week, [key]: cfg });
  }

  function resetDay(key) {
    const next = { ...week };
    delete next[key];                 // absent = inherited, never copied down
    onChange(next);
  }

  function dayFor(key) {
    return key in week ? week[key] : (inherited?.[key] ?? null);
  }

  return (
    <div className="sch">
      {showConfig && (
      <HeaderBar
        slotMinutes={slotMinutes}
        onSlotMinutes={onSlotMinutes}
        bufferBefore={bufferBefore}
        bufferAfter={bufferAfter}
        onBuffers={onBuffers}
        week={week}
        onWeek={onChange}
        canEdit={canEdit}
        showTemplates={!isChild || Object.keys(week).length > 0}
      />
      )}

      <div className="sch-week">
        <div className="sch-head">
          <span>Day</span><span>Status</span><span>Hours</span>
          <span>Breaks</span><span>Source</span><span />
        </div>

        {DAY_KEYS.map((key) => {
          const isOverride = key in week;
          const cfg = dayFor(key);
          return (
            <div key={key}>
              <DayRow
                dayKey={key}
                cfg={cfg}
                inherited={inherited?.[key]}
                source={isChild ? parentLabel : 'Organization'}
                isOverride={!isChild || isOverride}
                error={errors[key]}
                expanded={expanded === key}
                canEdit={canEdit}
                format24={format24}
                onExpand={() => setExpanded(expanded === key ? null : key)}
                onToggle={(open) => setDay(key, open ? reopen(cfg) : { ...CLOSED_DAY })}
                onCopy={(targets) => onChange(
                  copyDayTo({ ...week, [key]: normalizeDay(cfg) }, key, targets))}
                onReset={isChild && isOverride ? () => resetDay(key) : null}
              />
              {expanded === key && (
                <DayDetail
                  dayKey={key}
                  cfg={cfg}
                  inherited={inherited?.[key]}
                  canEdit={canEdit}
                  onChange={(next) => setDay(key, next)}
                />
              )}
            </div>
          );
        })}
      </div>

      {isChild && canEdit && Object.keys(week).length > 0 && onResetAll && (
        <div>
          <button type="button" className="btn btn-secondary" onClick={onResetAll}>
            <RotateCcw size={14} /> Reset every day to {parentLabel}
          </button>
        </div>
      )}
    </div>
  );
}

export { Menu as ScheduleMenu, Item as ScheduleMenuItem, Copy as CopyIcon };
