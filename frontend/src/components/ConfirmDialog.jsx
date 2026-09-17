import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Modal } from './Modal.jsx';

/**
 * Styled confirmation dialog (replaces window.confirm).
 *
 * Props:
 *   open, title, message
 *   confirmLabel (default "Confirm"), cancelLabel (default "Cancel")
 *   tone: "danger" | "primary" (default "primary") - styles the confirm button
 *   busy: disables buttons while an action runs
 *   onConfirm, onClose
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = 'primary',
  busy = false,
  onConfirm,
  onClose,
}) {
  const { t } = useTranslation('common');
  const confirmClass = tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title || t('common:confirm.title')}
      size="sm"
      footer={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={confirmClass} type="button" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div
          style={{
            flexShrink: 0, width: 38, height: 38, borderRadius: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: tone === 'danger' ? 'rgba(220,38,38,0.10)' : 'rgba(37,99,235,0.10)',
            color: tone === 'danger' ? '#dc2626' : 'var(--color-primary-600, #2563eb)',
          }}
        >
          <AlertTriangle size={20} />
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.5 }}>{message}</div>
      </div>
    </Modal>
  );
}
