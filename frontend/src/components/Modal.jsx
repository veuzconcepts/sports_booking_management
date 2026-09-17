import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { titleCase } from '../utils/titleCase.js';

const backdropStyle = {
  position: 'fixed', inset: 0,
  background: 'rgba(15, 23, 42, 0.45)',
  backdropFilter: 'blur(2px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, padding: 20,
};

const dialogStyle = (size) => ({
  width: '100%',
  maxWidth: size === 'lg' ? 720 : size === 'sm' ? 380 : 520,
  background: '#fff',
  borderRadius: 14,
  boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
  display: 'flex', flexDirection: 'column',
  maxHeight: '90vh',
  overflow: 'hidden',
});

export function Modal({ open, onClose, title, children, footer, size = 'md' }) {
  // Lock background scroll while the modal is open.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  // Rendered through a portal to <body> so it's never trapped by a
  // transformed/positioned ancestor and always sits above the header.
  // Clicking the backdrop does NOT close - use the ✕ (or a footer button).
  return createPortal(
    <div style={backdropStyle}>
      <div style={dialogStyle(size)} className="modal-dialog fade-in">
        <div className="modal-head">
          <h3 className="modal-title">{titleCase(title)}</h3>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="Close" type="button">
            <X size={28} strokeWidth={2.25} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
