import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, ChevronRight, Coffee, Copy, MoreVertical, Plus, RotateCcw,
  Snowflake, Sun, X,
} from 'lucide-react';

import { TimePicker } from './TimePicker.jsx';
import { usePopover } from './usePopover.js';
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
  // Portalled: these menus open inside the modal body and the schedule card,
  // both of which scroll and would otherwise clip them.
  const { triggerRef, popRef, open, toggle, close, style } = usePopover({
    width: 216,
    estimatedHeight: 260,
    align: align === 'left' ? 'start' : 'end',
  });

  return (
    <div className="sch-menu">
      <button ref={triggerRef} type="button" className={icon ? 'icon-btn' : 'btn btn-secondary'}
        aria-label={label} aria-expanded={open} onClick={toggle}>
        {icon || <>{label} <ChevronDown size={14} /></>}
      </button>
      {open && style && createPortal(
        <div ref={popRef} className="sch-menu__pop" style={style} onClick={close}>
          {children}
        </div>,
        document.body,
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
  const { t } = useTranslation('schedule');
  const [custom, setCustom] = useState(
    () => slotMinutes != null && !SLOT_OPTIONS.includes(Number(slotMinutes)));

  return (
    <div className="sch-bar">
      <div className="sch-bar__group">
        <span className="sch-bar__label">{t('slotDuration')}</span>
        {custom ? (
          <input className="sch-num" type="number" min="1" max="1440" disabled={!canEdit}
            value={slotMinutes ?? ''} aria-label={t('slotDurationCustomAria')}
            onChange={(e) => onSlotMinutes(e.target.value === '' ? null : Number(e.target.value))} />
        ) : (
          <select className="sch-select" disabled={!canEdit} value={slotMinutes ?? ''}
            aria-label={t('slotDurationAria')}
            onChange={(e) => {
              if (e.target.value === 'custom') { setCustom(true); return; }
              onSlotMinutes(e.target.value === '' ? null : Number(e.target.value));
            }}>
            <option value="">{t('slotDurationInherit')}</option>
            {SLOT_OPTIONS.map((m) => <option key={m} value={m}>{t('slotDurationMinutes', { count: m })}</option>)}
            <option value="custom">{t('slotDurationCustom')}</option>
          </select>
        )}
        {custom && (
          <button type="button" className="icon-btn" title={t('backToPresets')}
            onClick={() => setCustom(false)}><X size={14} /></button>
        )}
      </div>

      <div className="sch-bar__group">
        <span className="sch-bar__label" title={t('bufferBeforeHint')}>
          {t('bufferBefore')}
        </span>
        <input className="sch-num" type="number" min="0" max="240" disabled={!canEdit}
          value={bufferBefore ?? ''} aria-label={t('bufferBeforeAria')}
          onChange={(e) => onBuffers(e.target.value === '' ? null : Number(e.target.value), bufferAfter)} />
      </div>
      <div className="sch-bar__group">
        <span className="sch-bar__label" title={t('bufferAfterHint')}>
          {t('bufferAfter')}
        </span>
        <input className="sch-num" type="number" min="0" max="240" disabled={!canEdit}
          value={bufferAfter ?? ''} aria-label={t('bufferAfterAria')}
          onChange={(e) => onBuffers(bufferBefore, e.target.value === '' ? null : Number(e.target.value))} />
      </div>

      <div className="sch-bar__spacer" />

      {canEdit && showTemplates && (
        <Menu label={t('templates')}>
          <div className="sch-menu__group">{t('startFrom')}</div>
          {TEMPLATES.map((template) => (
            <Item key={template.key} onClick={() => onWeek(template.build())}>
              {t(template.labelKey)}
              <div className="muted" style={{ fontSize: 11.5 }}>{t(template.detailKey)}</div>
            </Item>
          ))}
        </Menu>
      )}

      {canEdit && (
        <Menu label={t('quickActions')}>
          <div className="sch-menu__group">{t('applyMondayTo')}</div>
          <Item onClick={() => onWeek(copyDayTo(week, 'mon', DAY_KEYS))}>{t('allDays')}</Item>
          <Item onClick={() => onWeek(copyDayTo(week, 'mon', WEEKDAYS))}>{t('weekdays')}</Item>
          <Item onClick={() => onWeek(copyDayTo(week, 'mon', WEEKEND))}>{t('weekend')}</Item>
          <hr className="sch-menu__sep" />
          <Item onClick={() => onWeek(setEveryDay(week, openDay('08:00', '22:00')))}>
            {t('setAllOpen')}
          </Item>
          <Item onClick={() => onWeek(setEveryDay(week, { ...CLOSED_DAY }))}>
            {t('setAllClosed')}
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
  const { t } = useTranslation('schedule');
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
        {t(`days.${dayKey}`)}
      </button>

      <label className={`sch-toggle sch-row__status${day.closed ? ' sch-toggle--off' : ''}`}>
        <input type="checkbox" checked={!day.closed} disabled={!canEdit}
          onChange={(e) => onToggle(e.target.checked)} />
        {day.closed ? t('closed') : t('open')}
      </label>

      <div className="sch-row__hours">
        {day.closed ? <span>{t('closedAllDay')}</span> : day.shifts.map((s, i) => (
          <span key={i}>
            {displayTime(s.open, format24)}
            <span className="sch-row__sep"> - </span>
            {displayTime(s.close, format24)}
            {/* Readable without expanding the day, which is the whole point of
                classifying a shift in the first place. */}
            {s.period === 'hot' && (
              <Sun size={12} className="sch-row__period sch-row__period--hot"
                aria-label={t('periodHot')} />
            )}
            {s.period === 'cold' && (
              <Snowflake size={12} className="sch-row__period sch-row__period--cold"
                aria-label={t('periodCold')} />
            )}
            {i < day.shifts.length - 1 ? ',' : ''}
          </span>
        ))}
        {!day.closed && day.shifts.length === 0 && (
          <span className="muted">{t('noHoursSet')}</span>
        )}
        {overnight && <span className="sch-badge sch-badge--overnight">{t('overnight')}</span>}
      </div>

      <div className="sch-row__meta sch-row__breaks">
        {breaks.length > 0
          ? (
            <span className="sch-badge sch-badge--break">
              {t('breaks', { count: breaks.length })}
            </span>
          )
          : <span className="muted" style={{ fontSize: 12 }}>{t('noBreaks')}</span>}
      </div>

      <div className="sch-row__meta sch-row__source">
        <span className={`sch-badge sch-badge--${isOverride ? 'custom' : 'inherited'}`}>
          {isOverride ? t('custom') : source}
        </span>
      </div>

      <div className="sch-row__menu">
        {canEdit && (
          <Menu label={t('dayActions', { day: t(`days.${dayKey}`) })} icon={<MoreVertical size={15} />}>
            <div className="sch-menu__group">{t('copyTo', { day: t(`days.${dayKey}`) })}</div>
            {DAY_KEYS.filter((d) => d !== dayKey).map((d) => (
              <Item key={d} onClick={() => onCopy([d])}>{t(`days.${d}`)}</Item>
            ))}
            <hr className="sch-menu__sep" />
            <Item onClick={() => onCopy(WEEKDAYS)}>{t('weekdays')}</Item>
            <Item onClick={() => onCopy(WEEKEND)}>{t('weekend')}</Item>
            <Item onClick={() => onCopy(DAY_KEYS)}>{t('allDays')}</Item>
            {isOverride && onReset && (
              <>
                <hr className="sch-menu__sep" />
                <Item danger onClick={onReset}>{t('resetToParent', { parent: source })}</Item>
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
/** Normal, Hot or Cold for one operating shift.
 *
 * Compact by necessity: this sits on a row that already carries two time
 * pickers, an overnight badge and a remove button, and it has to stay
 * usable on a phone. Icons carry the meaning, with the name in the title
 * and the accessible label so it is never icon-only.
 */
const PERIODS = [
  { value: 'normal', icon: null, key: 'periodNormal' },
  { value: 'hot', icon: Sun, key: 'periodHot' },
  { value: 'cold', icon: Snowflake, key: 'periodCold' },
];

export function PeriodPicker({ value, disabled, onChange }) {
  const { t } = useTranslation('schedule');
  const current = value || 'normal';
  return (
    <span className="sch-period" role="group" aria-label={t('timeType')}>
      {PERIODS.map((option) => {
        const Icon = option.icon;
        const on = current === option.value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            title={t(option.key)}
            aria-label={t(option.key)}
            className={`sch-period__b sch-period__b--${option.value}${on ? ' is-on' : ''}`}
            onClick={() => onChange(option.value)}
          >
            {Icon ? <Icon size={13} /> : <span aria-hidden="true">&ndash;</span>}
          </button>
        );
      })}
    </span>
  );
}

function DayDetail({ dayKey, cfg, inherited, canEdit, onChange }) {
  const { t } = useTranslation('schedule');
  const day = normalizeDay(cfg ?? inherited);
  if (day.closed) {
    return (
      <div className="sch-detail">
        <span className="muted" style={{ fontSize: 13 }}>
          {t('closedHint', { day: t(`days.${dayKey}`) })}
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
        <div className="sch-detail__title">{t('operatingHours')}</div>
        {shifts.map((s, i) => (
          <div className="sch-line" key={i}>
            <TimePicker value={s.open} disabled={!canEdit} ariaLabel={t('opens')}
              onChange={(v) => set({
                shifts: shifts.map((x, j) => (j === i ? { ...x, open: v } : x)), breaks,
              })} />
            <span className="sch-row__sep">{t('to')}</span>
            <TimePicker value={s.close} disabled={!canEdit} ariaLabel={t('closes')}
              onChange={(v) => set({
                shifts: shifts.map((x, j) => (j === i ? { ...x, close: v } : x)), breaks,
              })} />
            {spansMidnight(s.open, s.close) && (
              <span className="sch-badge sch-badge--overnight">{t('nextDay')}</span>
            )}
            {/* Peak or off-peak. Classification only: it changes no price on
                its own, and a pricing rule has to ask for it by name. */}
            <PeriodPicker
              value={s.period} disabled={!canEdit}
              onChange={(period) => set({
                shifts: shifts.map((x, j) => (j === i
                  ? (period === 'normal'
                    // Leave the key off a normal shift so an untouched
                    // schedule document stays exactly as it was.
                    ? (({ period: _drop, ...rest }) => rest)(x)
                    : { ...x, period })
                  : x)),
                breaks,
              })} />
            {canEdit && shifts.length > 1 && (
              <button type="button" className="icon-btn" title={t('removeShift')}
                onClick={() => set({ shifts: shifts.filter((_, j) => j !== i), breaks })}>
                <X size={14} />
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <button type="button" className="sch-add"
            onClick={() => set({ shifts: [...shifts, { open: '16:00', close: '22:00' }], breaks })}>
            <Plus size={13} /> {t('addShift')}
          </button>
        )}
      </div>

      <div className="sch-detail__section">
        <div className="sch-detail__title">{t('breaksTitle')}</div>
        {breaks.length === 0 && (
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
            {t('noBreaksHint')}
          </div>
        )}
        {breaks.map((b, i) => (
          <div className="sch-line" key={i}>
            <input className="sch-line__name" placeholder={t('breakNamePlaceholder')}
              value={b.name || ''} disabled={!canEdit} aria-label={t('breakName')}
              onChange={(e) => set({
                shifts, breaks: breaks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
              })} />
            <TimePicker value={b.open} disabled={!canEdit} ariaLabel={t('breakStarts')}
              onChange={(v) => set({
                shifts, breaks: breaks.map((x, j) => (j === i ? { ...x, open: v } : x)),
              })} />
            <span className="sch-row__sep">to</span>
            <TimePicker value={b.close} disabled={!canEdit} ariaLabel={t('breakEnds')}
              onChange={(v) => set({
                shifts, breaks: breaks.map((x, j) => (j === i ? { ...x, close: v } : x)),
              })} />
            {canEdit && (
              <button type="button" className="icon-btn" title={t('removeBreak')}
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
            <Coffee size={13} /> {t('addBreak')}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- weekly timeline */
export function WeeklyTimeline({ week, format24 }) {
  const { t } = useTranslation('schedule');
  return (
    <div className="sch-timeline">
      {DAY_KEYS.map((key) => {
        const day = normalizeDay(week[key]);
        return (
          <div className="sch-tl-row" key={key}>
            <span>{t(`days.${key}`)}</span>
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
          {['00:00', '06:00', '12:00', '18:00', '24:00'].map((mark) => (
            <span key={mark}>{mark === '24:00' ? mark : displayTime(mark, format24)}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------- effective (read-only) */
export function EffectiveSchedule({ week, format24 }) {
  const { t } = useTranslation('schedule');
  return (
    <div className="sch-eff">
      {DAY_KEYS.map((key) => {
        const cfg = week?.[key] || {};
        const day = normalizeDay(cfg);
        const breaks = day.breaks || [];
        return (
          <div className="sch-eff__row" key={key}>
            <span style={{ fontWeight: 600 }}>{t(`days.${key}`)}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {summarizeDay(day, format24)}
              {breaks.length > 0 && (
                <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  break {breaks.map((b) => `${displayTime(b.open, format24)}-${displayTime(b.close, format24)}`).join(', ')}
                </span>
              )}
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              {day.closed && <span className="sch-badge sch-badge--closed">{t('closed')}</span>}
              {breaks.length > 0 && <span className="sch-badge sch-badge--break">{t('breaksTitle')}</span>}
              <span className={`sch-badge sch-badge--${cfg.source === 'organization' ? 'inherited' : 'custom'}`}>
                {cfg.source === 'organization' ? 'Organization'
                  : cfg.source === 'club' ? t('common:labels.club') : t('slotDurationCustom')}
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
  const { t } = useTranslation('schedule');
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
          <span>{t('day')}</span><span>{t('common:labels.status')}</span><span>{t('hours')}</span>
          <span>{t('breaksTitle')}</span><span>{t('columns.source')}</span><span />
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
            <RotateCcw size={14} /> {t('resetEveryDay', { parent: parentLabel })}
          </button>
        </div>
      )}
    </div>
  );
}

export { Menu as ScheduleMenu, Item as ScheduleMenuItem, Copy as CopyIcon };
