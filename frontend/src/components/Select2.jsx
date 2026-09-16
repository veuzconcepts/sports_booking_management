import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';

/**
 * Reusable Select2-style dropdown - the single select control for the whole app.
 *
 * Features
 *  - Single OR multiple selection (`multiple` prop)
 *  - Inline search auto-enabled when options > 10 (override with `searchable`)
 *  - Placeholder, disabled, default value, API-loaded options, validation error
 *  - Renders its menu in a portal, so it never clips inside modal/overflow forms
 *  - Keyboard support: ↑/↓ to move, Enter to pick, Esc to close
 *
 * Value contract (controlled):
 *  - single  : value is a scalar (string|number) or '' / null when empty
 *  - multiple : value is an array of scalars
 *  - onChange(nextValue) receives the value(s) directly (NOT a DOM event)
 *
 * For react-hook-form, wrap with <Controller> and pass field.value / field.onChange.
 */
export function Select2({
  options = [],
  value,
  onChange,
  multiple = false,
  placeholder = 'Select…',
  disabled = false,
  searchable,            // undefined => auto (>10 options)
  searchThreshold = 10,
  clearable = false,     // single-select: allow clearing back to empty
  error,
  id,
  name,
  emptyText = 'No results',
  maxMenuHeight = 260,
  onSearch,              // optional: server-side search - called (debounced) with
                         // the typed term; the parent supplies the matching options.
}) {
  const autoId = useId();
  const fieldId = id || autoId;
  const controlRef = useRef(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState(null); // { top, left, width, openUp }

  const opts = useMemo(
    () => (options || []).map((o) => ({
      value: o.value,
      label: o.label ?? String(o.value),
      disabled: !!o.disabled,
    })),
    [options],
  );

  const showSearch = searchable ?? (onSearch ? true : opts.length > searchThreshold);

  const selectedValues = useMemo(() => {
    if (multiple) return Array.isArray(value) ? value : [];
    return value === undefined || value === null || value === '' ? [] : [value];
  }, [value, multiple]);

  const isSelected = useCallback(
    (v) => selectedValues.some((sv) => String(sv) === String(v)),
    [selectedValues],
  );

  const filtered = useMemo(() => {
    // Server-side search: the parent already filtered - show options as given.
    if (onSearch) return opts;
    if (!showSearch || !q.trim()) return opts;
    const needle = q.trim().toLowerCase();
    return opts.filter((o) => o.label.toLowerCase().includes(needle));
  }, [opts, q, showSearch, onSearch]);

  // Debounced server-side search when `onSearch` is provided.
  useEffect(() => {
    if (!onSearch || !open) return undefined;
    const t = setTimeout(() => onSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q, onSearch, open]);

  // Already-selected options drop out of the list (they show as the selected
  // value / chips); removing a selection makes it reappear here.
  const visible = useMemo(
    () => filtered.filter((o) => !isSelected(o.value)),
    [filtered, isSelected],
  );

  /* ---- positioning (fixed, portal) -------------------------------------- */
  const reposition = useCallback(() => {
    const el = controlRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < maxMenuHeight + 16 && r.top > spaceBelow;
    setPos({ top: openUp ? r.top : r.bottom, left: r.left, width: r.width, openUp });
  }, [maxMenuHeight]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    reposition();
    const onMove = () => reposition();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true); // capture: catch modal-body scroll
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, reposition]);

  /* ---- outside click + escape ------------------------------------------- */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (controlRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open && showSearch) {
      // focus search shortly after the menu mounts
      const t = setTimeout(() => searchRef.current?.focus(), 10);
      return () => clearTimeout(t);
    }
    if (!open) { setQ(''); setActive(-1); }
    return undefined;
  }, [open, showSearch]);

  /* ---- actions ----------------------------------------------------------- */
  function toggleOpen() {
    if (disabled) return;
    setOpen((o) => !o);
  }

  function pick(opt) {
    if (opt.disabled) return;
    if (multiple) {
      const exists = isSelected(opt.value);
      const next = exists
        ? selectedValues.filter((sv) => String(sv) !== String(opt.value))
        : [...selectedValues, opt.value];
      onChange?.(next);
    } else {
      onChange?.(opt.value);
      setOpen(false);
    }
  }

  function clearAll(e) {
    e.stopPropagation();
    onChange?.(multiple ? [] : '');
  }

  function removeChip(e, v) {
    e.stopPropagation();
    onChange?.(selectedValues.filter((sv) => String(sv) !== String(v)));
  }

  function onKeyDown(e) {
    if (disabled) return;
    if (!open && (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === ' ')) {
      e.preventDefault(); setOpen(true); return;
    }
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min((i < 0 ? -1 : i) + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (visible[active]) pick(visible[active]);
    }
  }

  const selectedOpts = opts.filter((o) => isSelected(o.value));
  const singleLabel = !multiple && selectedOpts[0]?.label;
  const hasValue = selectedValues.length > 0;

  return (
    <>
      <div
        ref={controlRef}
        id={fieldId}
        className={`s2-control${open ? ' is-open' : ''}${error ? ' is-error' : ''}${disabled ? ' is-disabled' : ''}`}
        tabIndex={disabled ? -1 : 0}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-disabled={disabled}
        onClick={toggleOpen}
        onKeyDown={onKeyDown}
      >
        <div className="s2-value-wrap">
          {multiple ? (
            hasValue ? (
              <span className="s2-chips">
                {selectedOpts.map((o) => (
                  <span className="s2-chip" key={String(o.value)}>
                    {o.label}
                    {!disabled && (
                      <button type="button" className="s2-chip-x" onClick={(e) => removeChip(e, o.value)} aria-label={`Remove ${o.label}`}>
                        <X size={12} />
                      </button>
                    )}
                  </span>
                ))}
              </span>
            ) : (
              <span className="s2-placeholder">{placeholder}</span>
            )
          ) : (
            singleLabel
              ? <span className="s2-single">{singleLabel}</span>
              : <span className="s2-placeholder">{placeholder}</span>
          )}
        </div>

        <div className="s2-indicators">
          {clearable && !multiple && hasValue && !disabled && (
            <button type="button" className="s2-clear" onClick={clearAll} aria-label="Clear">
              <X size={15} />
            </button>
          )}
          <ChevronDown size={16} className="s2-arrow" />
        </div>
      </div>

      {/* hidden input keeps a real form value around (also handy for native form posts) */}
      {name && (
        <input type="hidden" name={name} value={multiple ? selectedValues.join(',') : (value ?? '')} />
      )}

      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="s2-menu fade-in"
          style={{
            position: 'fixed',
            left: pos.left,
            width: pos.width,
            ...(pos.openUp ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            zIndex: 1200,
          }}
        >
          {showSearch && (
            <div className="s2-search">
              <Search size={15} />
              <input
                ref={searchRef}
                value={q}
                placeholder="Search…"
                onChange={(e) => { setQ(e.target.value); setActive(0); }}
                onKeyDown={onKeyDown}
              />
            </div>
          )}
          <div className="s2-options" style={{ maxHeight: maxMenuHeight }} role="listbox">
            {visible.length === 0 ? (
              <div className="s2-empty">
                {!q.trim() && hasValue && filtered.length > 0 ? 'All options selected' : emptyText}
              </div>
            ) : (
              visible.map((o, i) => {
                const sel = isSelected(o.value);
                return (
                  <div
                    key={String(o.value)}
                    role="option"
                    aria-selected={sel}
                    className={`s2-option${sel ? ' is-selected' : ''}${i === active ? ' is-active' : ''}${o.disabled ? ' is-disabled' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                  >
                    <span className="s2-option-label">{o.label}</span>
                    {sel && <Check size={15} className="s2-option-check" />}
                  </div>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
