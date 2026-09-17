import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Columns3, Filter, Layers, RotateCcw, Search, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The listing toolbar: one search box with Filters, Group By and Columns beside
 * it, and a row of chips showing every condition currently in force.
 *
 * Filters and groups are supplied as configuration by the page, so a new
 * listing declares what it can be narrowed by instead of building another
 * filter bar. Nothing here knows what a booking or a customer is.
 */
function useCloseOnOutside(open, onClose) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return ref;
}

function Dropdown({ label, icon, badge, children, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useCloseOnOutside(open, () => setOpen(false));

  return (
    <div className="lv-drop" ref={ref}>
      <button
        type="button"
        className={`btn btn-secondary lv-drop__btn${open ? ' is-open' : ''}`}
        aria-haspopup="true" aria-expanded={open} disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        <span className="lv-drop__label">{label}</span>
        {badge > 0 && <span className="lv-drop__badge">{badge}</span>}
      </button>
      {open && <div className="lv-drop__pop">{children}</div>}
    </div>
  );
}

/** One filter's control. Kept deliberately small: select, date, date range. */
function FilterControl({ filter, value, onChange, t }) {
  if (filter.type === 'dateRange') {
    const [from, to] = String(value || '..').split('..');
    const emit = (nextFrom, nextTo) => (
      onChange(nextFrom || nextTo ? `${nextFrom || ''}..${nextTo || ''}` : '')
    );
    return (
      <div className="lv-range">
        <input
          className="form-input" type="date" value={from || ''}
          aria-label={`${filter.label} ${t('rangeFrom')}`}
          onChange={(e) => emit(e.target.value, to)}
        />
        <span className="muted">{t('rangeTo')}</span>
        <input
          className="form-input" type="date" value={to || ''}
          aria-label={`${filter.label} ${t('rangeTo')}`}
          onChange={(e) => emit(from, e.target.value)}
        />
      </div>
    );
  }

  if (filter.type === 'date') {
    return (
      <input
        className="form-input" type="date" value={value || ''}
        aria-label={filter.label}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (filter.type === 'boolean') {
    return (
      <select
        className="form-input" value={value ?? ''} aria-label={filter.label}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{filter.placeholder || t('any')}</option>
        <option value="true">{filter.trueLabel || t('yes')}</option>
        <option value="false">{filter.falseLabel || t('no')}</option>
      </select>
    );
  }

  return (
    <select
      className="form-input" value={value ?? ''} aria-label={filter.label}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">
        {filter.placeholder || t('allOf', { field: filter.label.toLowerCase() })}
      </option>
      {(filter.options || []).map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** Human wording for an active filter, used on its chip. */
function chipLabel(filter, value, t) {
  if (filter.type === 'dateRange') {
    const [from, to] = String(value).split('..');
    if (from && to) return t('chip.between', { field: filter.label, from, to });
    if (from) return t('chip.after', { field: filter.label, from });
    return t('chip.before', { field: filter.label, to });
  }
  const shown = filter.type === 'boolean'
    ? (value === 'true' ? (filter.trueLabel || t('yes')) : (filter.falseLabel || t('no')))
    : ((filter.options || []).find((o) => String(o.value) === String(value))?.label ?? value);
  return t('chip.is', { field: filter.label, value: shown });
}

export function ListToolbar({
  searchPlaceholder,
  searchValue,
  onSearchChange,

  filters = [],
  activeFilters = {},
  onFilterChange,
  onClearFilters,

  groupOptions = [],
  groupBy,
  onGroupBy,

  allColumns = [],
  hiddenColumns,
  onToggleColumn,

  onResetView,
  canResetView,

  right,
}) {
  const { t } = useTranslation('table');
  const placeholder = searchPlaceholder || t('search');

  const activeChips = useMemo(() => Object.entries(activeFilters || {})
    .map(([key, value]) => {
      const filter = filters.find((f) => f.key === key);
      return filter ? { key, label: chipLabel(filter, value, t) } : null;
    })
    .filter(Boolean), [activeFilters, filters, t]);

  const groupLabel = groupOptions.find((g) => g.key === groupBy)?.label;
  const hideableColumns = allColumns.filter((c) => c.hideable !== false && !c.alwaysVisible);

  return (
    <div className="lv-toolbar">
      <div className="lv-toolbar__row">
        <div className="lv-search">
          <Search size={15} className="lv-search__icon" />
          <input
            className="lv-search__input"
            type="search"
            value={searchValue}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {searchValue && (
            <button
              type="button" className="lv-search__clear" aria-label={t('clearSearch')}
              onClick={() => onSearchChange('')}
            >
              <X size={14} />
            </button>
          )}
        </div>

        {filters.length > 0 && (
          <Dropdown
            label={t('filters')} icon={<Filter size={14} />}
            badge={activeChips.length}
          >
            <div className="lv-drop__title">{t('filters')}</div>
            {filters.map((f) => (
              <div className="lv-filter" key={f.key}>
                <span className="lv-filter__label">{f.label}</span>
                <FilterControl
                  filter={f}
                  value={activeFilters[f.key] ?? ''}
                  onChange={(v) => onFilterChange(f.key, v)}
                  t={t}
                />
              </div>
            ))}
            {activeChips.length > 0 && (
              <button type="button" className="lv-drop__action" onClick={onClearFilters}>
                {t('clearFilters')}
              </button>
            )}
          </Dropdown>
        )}

        {groupOptions.length > 0 && (
          <Dropdown
            label={groupLabel ? t('groupPrefix', { field: groupLabel }) : t('groupBy')}
            icon={<Layers size={14} />}
          >
            <div className="lv-drop__title">{t('groupBy')}</div>
            {groupOptions.map((g) => (
              <button
                key={g.key} type="button"
                className={`lv-drop__item${groupBy === g.key ? ' is-on' : ''}`}
                onClick={() => onGroupBy(groupBy === g.key ? '' : g.key)}
              >
                <span className="lv-drop__tick">{groupBy === g.key && <Check size={13} />}</span>
                {g.label}
              </button>
            ))}
            {groupBy && (
              <button type="button" className="lv-drop__action" onClick={() => onGroupBy('')}>
                {t('removeGrouping')}
              </button>
            )}
          </Dropdown>
        )}

        {hideableColumns.length > 0 && (
          <Dropdown label={t('columns')} icon={<Columns3 size={14} />}>
            <div className="lv-drop__title">{t('columns')}</div>
            <p className="lv-drop__hint">{t('columnsHint')}</p>
            {hideableColumns.map((c) => {
              const shown = !hiddenColumns.has(c.key);
              return (
                <button
                  key={c.key} type="button"
                  className={`lv-drop__item${shown ? ' is-on' : ''}`}
                  role="menuitemcheckbox" aria-checked={shown}
                  onClick={() => onToggleColumn(c.key)}
                >
                  <span className="lv-drop__tick">{shown && <Check size={13} />}</span>
                  {typeof c.header === 'string' ? c.header : c.key}
                </button>
              );
            })}
          </Dropdown>
        )}

        {canResetView && (
          <button
            type="button" className="btn btn-secondary lv-reset"
            onClick={onResetView} title={t('resetViewHint')}
          >
            <RotateCcw size={14} />
            <span className="lv-drop__label">{t('resetView')}</span>
          </button>
        )}

        <div className="lv-toolbar__spacer" />
        {right}
      </div>

      {(activeChips.length > 0 || groupBy) && (
        <div className="lv-chips">
          {activeChips.map((chip) => (
            <button
              key={chip.key} type="button" className="lv-chip"
              onClick={() => onFilterChange(chip.key, '')}
            >
              {chip.label}
              <X size={12} />
            </button>
          ))}
          {groupBy && (
            <button
              type="button" className="lv-chip lv-chip--group"
              onClick={() => onGroupBy('')}
            >
              {t('groupedBy', { field: groupLabel })}
              <X size={12} />
            </button>
          )}
          {activeChips.length > 1 && (
            <button type="button" className="lv-chip-clear" onClick={onClearFilters}>
              {t('clearAll')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
