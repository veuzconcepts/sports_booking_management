import { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { titleCase } from '../utils/titleCase.js';

// Sizing lives in responsive.css: an inline style cannot carry a media query,
// so it could never go full-bleed on a phone.
const SIZES = { sm: 'sm', md: 'md', lg: 'lg', xl: 'xl' };

/**
 * `side` turns the dialog into a slide-over panel anchored to the edge of the
 * screen, the way a long record form usually opens.
 *
 * A variant of Modal rather than a second component, because everything that
 * makes a form dialog behave (the portal, the scroll lock, the footer, the
 * deliberate refusal to close on a backdrop click, the labelled `role`) is
 * identical and must not drift into two implementations. Only the position
 * and the way it arrives differ.
 *
 * It is an explicit opt-in, not something inferred from `size`. A form's shape
 * should not change because somebody picked a wider dialog, and counting
 * fields at render time would make the same modal a panel or a box depending
 * on which conditional sections happened to be showing.
 */
export function Modal({ open, onClose, title, children, footer, size = 'md',
                        side = false }) {
  const { t } = useTranslation('common');
  const titleId = useId();
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
    <div className={`modal-backdrop${side ? ' modal-backdrop--side' : ''}`}>
      {/* Announced as a dialog and named by its own heading, so assistive
          technology reports what opened instead of an unlabelled group. */}
      <div
        className={`modal-dialog modal-dialog--${SIZES[size] || 'md'}`
          + (side ? ' modal-dialog--side slide-in-end' : ' fade-in')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-head">
          <h3 className="modal-title" id={titleId}>{titleCase(title)}</h3>
          <button className="icon-btn modal-close" onClick={onClose} aria-label={t('common:actions.close')} type="button">
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
