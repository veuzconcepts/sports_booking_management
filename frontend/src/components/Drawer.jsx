import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Right-side slide-over panel. Mirrors Modal (portal to <body>, scroll-lock,
 * Esc to close) but anchored to the right edge for read-only detail views.
 * Backdrop click closes (read-only - nothing to lose).
 */
export function Drawer({ open, onClose, title, subtitle, children, width = 440 }) {
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(2px)' }}
      />
      <div
        className="fade-in"
        style={{
          position: 'relative', width: '100%', maxWidth: width, height: '100%', background: '#fff',
          boxShadow: '-20px 0 50px rgba(15,23,42,0.25)', display: 'flex', flexDirection: 'column',
        }}
      >
        <div className="modal-head">
          <div>
            <h3 className="modal-title">{title}</h3>
            {subtitle && <p className="card-subtitle" style={{ margin: 0 }}>{subtitle}</p>}
          </div>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="Close" type="button">
            <X size={26} strokeWidth={2.25} />
          </button>
        </div>
        <div className="modal-body" style={{ overflowY: 'auto' }}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
