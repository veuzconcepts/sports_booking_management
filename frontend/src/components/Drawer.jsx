import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Right-side slide-over panel. Mirrors Modal (portal to <body>, scroll-lock,
 * Esc to close) but anchored to the right edge for read-only detail views.
 * Backdrop click closes (read-only - nothing to lose).
 */
export function Drawer({ open, onClose, title, subtitle, children, width = 440 }) {
  const { t } = useTranslation('common');
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="drawer-backdrop">
      <div className="drawer-scrim" onClick={onClose} />
      {/* Only the cap is set here; the panel goes full width on a phone through
          responsive.css, which an inline max-width could not override. */}
      <div className="drawer-panel fade-in" style={{ maxWidth: width }}>
        <div className="modal-head">
          <div>
            <h3 className="modal-title">{title}</h3>
            {subtitle && <p className="card-subtitle" style={{ margin: 0 }}>{subtitle}</p>}
          </div>
          <button className="icon-btn modal-close" onClick={onClose} aria-label={t('common:actions.close')} type="button">
            <X size={26} strokeWidth={2.25} />
          </button>
        </div>
        <div className="modal-body" style={{ overflowY: 'auto' }}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
