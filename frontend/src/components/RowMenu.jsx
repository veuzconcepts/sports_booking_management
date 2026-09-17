import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Action dropdown. Default trigger is a kebab (⋮); pass `triggerLabel` for a
 * labeled "More actions ▾" button (e.g. the bulk bar).
 *
 *   items: [{ key, label, icon?, onClick, danger?, disabled? } | null]
 *
 * Falsy items are dropped, so callers can inline guard logic
 * (`canFoo && { ... }`). If NO items survive, the trigger is not rendered at
 * all - that's how the owner/self rows end up with no destructive actions.
 * The menu renders in a portal so it never clips inside the table's overflow.
 */
export function RowMenu({ items = [], label, triggerLabel }) {
  const { t } = useTranslation('table');
  const live = items.filter(Boolean);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);

  const reposition = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    reposition();
    const onMove = () => reposition();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!live.length) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={triggerLabel ? 'btn btn-secondary' : 'icon-btn'}
        style={triggerLabel ? { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, padding: '6px 11px' } : undefined}
        aria-label={triggerLabel || label || t('table:rowActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {triggerLabel ? <>{triggerLabel}<ChevronDown size={14} /></> : <MoreVertical size={16} />}
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fade-in"
          style={{
            position: 'fixed', top: pos.top, right: pos.right, zIndex: 1200, minWidth: 184,
            background: '#fff', border: '1px solid var(--color-border-soft, #e5e7eb)', borderRadius: 10,
            boxShadow: '0 12px 30px rgba(15,23,42,0.18)', padding: 6,
          }}
        >
          {live.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick?.(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                padding: '8px 10px', fontSize: 13, border: 'none', background: 'transparent', borderRadius: 7,
                cursor: it.disabled ? 'not-allowed' : 'pointer',
                color: it.disabled ? 'var(--color-text-muted, #9ca3af)' : it.danger ? '#dc2626' : 'inherit',
                opacity: it.disabled ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'var(--color-surface-2, #f3f4f6)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
