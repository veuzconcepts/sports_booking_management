import { useEffect, useState } from 'react';

import { Modal } from './Modal.jsx';
import { Money, CurrencySymbol, currencyDecimals } from '../services/currency.jsx';

// Refund destinations offered in the dialog.
const REFUND_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'wallet', label: 'Wallet (store credit)' },
  { value: 'bank_transfer', label: 'Bank transfer' },
];
const ALLOWED = REFUND_METHODS.map((m) => m.value);

/**
 * Refund (credit note) dialog. The amount defaults to the full remaining
 * refundable balance and can be reduced for a partial refund, but never
 * increased beyond it - and repeated partials can never exceed the invoice
 * (the backend caps each refund at `refundable_amount`). The payment mode and
 * memo are editable; the currency follows the invoice (the org default).
 */
export function RefundModal({ open, invoice, busy = false, onClose, onConfirm }) {
  const currency = invoice?.currency;
  const decimals = currencyDecimals(currency);
  const max = Number(invoice?.refundable_amount ?? invoice?.total ?? 0);
  const step = (1 / 10 ** decimals).toFixed(decimals);

  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [method, setMethod] = useState('cash');

  // Reset to sensible defaults each time the dialog opens for an invoice.
  useEffect(() => {
    if (open && invoice) {
      setAmount(max.toFixed(decimals));
      setMemo(invoice.number || '');
      const original = invoice.receipt?.method;
      setMethod(ALLOWED.includes(original) ? original : 'cash');
    }
  }, [open, invoice?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!invoice) return null;

  const num = Number(amount);
  const tooHigh = num > max + 1e-9;
  const invalid = !(num > 0) || tooHigh;

  const clampOnBlur = () => {
    if (num > max) setAmount(max.toFixed(decimals));
    else if (num > 0) setAmount(num.toFixed(decimals));
  };

  const submit = () => {
    if (invalid) return;
    const full = Math.abs(num - max) < 1e-9;
    onConfirm({ amount: full ? undefined : num.toFixed(decimals), reason: memo.trim(), method });
  };

  const Field = ({ label, children }) => (
    <div style={{ marginBottom: 14 }}>
      <div className="muted" style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );

  return (
    <Modal
      open={open} onClose={onClose} title="Refund" size="md"
      footer={(
        <>
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={onClose}>Discard</button>
          <button className="btn btn-primary" type="button" disabled={busy || invalid} onClick={submit}>
            Create refund
          </button>
        </>
      )}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 28px' }}>
        <Field label="Invoice"><div>{invoice.number}</div></Field>
        <Field label="Amount">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="muted"><CurrencySymbol code={currency} /></span>
            <input
              className="form-input" type="number" min="0" max={max} step={step}
              value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={clampOnBlur}
              style={{ flex: 1 }} autoFocus
            />
          </div>
          <div className={tooHigh ? '' : 'muted'} style={{ fontSize: 12, marginTop: 4, color: tooHigh ? 'var(--color-danger,#dc2626)' : undefined }}>
            {tooHigh
              ? 'Cannot exceed the remaining balance.'
              : <>Max refundable: <Money amount={max} code={currency} /></>}
          </div>
        </Field>

        <Field label="Refund to (payment mode)">
          <select className="form-input" value={method} onChange={(e) => setMethod(e.target.value)}>
            {REFUND_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Memo">
          <input className="form-input" value={memo} onChange={(e) => setMemo(e.target.value)}
            placeholder="Reference / note" />
        </Field>
      </div>
    </Modal>
  );
}
