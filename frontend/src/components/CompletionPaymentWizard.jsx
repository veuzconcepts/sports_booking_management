import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { Modal } from './Modal.jsx';
import { FormField } from './FormField.jsx';
import { Select2 } from './Select2.jsx';
import { Money, currencyDecimals } from '../services/currency.jsx';
import { bookingsApi } from '../services/bookingsService.js';
import { loyaltyApi } from '../services/loyaltyService.js';
import { useAuth } from '../hooks/useAuth.jsx';
import { apiErrorMessage } from '../utils/apiError';

// Offline-recordable methods for completing at the counter. Wallet/membership
// charges go through the dedicated payment flow, not this wizard.
const payMethods = (t) => [
  { value: 'cash', label: t('cash') },
  { value: 'card', label: t('card') },
];

/**
 * Completion & Payment wizard (spec #6/#7). When the booking owes money and
 * isn't yet paid, the operator records the payment (method / reference / date /
 * amount / notes) and reviews the pricing (original, discounts, promo, final)
 * before completing. Completing auto-generates the invoice + receipt. If the
 * booking is already paid (or zero-value), it's a simple confirm.
 */
export function CompletionPaymentWizard({ open, booking, mode = 'complete', onClose, onCompleted, onChanged }) {
  const { t } = useTranslation('payments');
  const { hasPerm } = useAuth();
  // Local copy so applying a promo / redeeming a subscription refreshes totals live.
  const [bk, setBk] = useState(booking);
  const currency = bk?.currency;
  const decimals = currencyDecimals(currency);
  const total = Number(bk?.total_amount ?? 0);
  const amountPaid = Number(bk?.amount_paid ?? 0);
  // Only the still-OUTSTANDING amount is ever collected - paid services (and later
  // add-on deltas) are never re-charged.
  const outstanding = Number(bk?.outstanding ?? Math.max(0, total - amountPaid));
  const isBill = mode === 'bill';                 // "Generate Invoice & take payment"
  const hasInvoice = Boolean(bk?.paid_invoice_number);
  const settled = amountPaid > 0 || ['paid', 'partially_paid'].includes(bk?.payment_status);
  const needsPayment = outstanding > 0;

  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [promo, setPromo] = useState('');
  const [promoBusy, setPromoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pointsBal, setPointsBal] = useState(null);   // customer's available points
  const [redeemInput, setRedeemInput] = useState('');

  useEffect(() => {
    if (!open) return;
    setBk(booking);
    setMethod('cash');
    setAmount(Number(booking?.outstanding ?? booking?.total_amount ?? 0).toFixed(decimals));
    setReference(''); setNotes(''); setPromo(''); setRedeemInput('');
    setPointsBal(null);
    if (booking?.customer && hasPerm('loyalty.redeem')) {
      loyaltyApi.summary(booking.customer).then((s) => setPointsBal(s.balance)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, booking]);

  async function doRedeemPoints() {
    const n = parseInt(redeemInput, 10);
    if (!n || n <= 0) { toast.error(t('enterPointsRedeem')); return; }
    setBusy(true);
    try {
      applyUpdated(await bookingsApi.redeemPoints(bk.id, n));
      setRedeemInput('');
      if (bk?.customer) loyaltyApi.summary(bk.customer).then((s) => setPointsBal(s.balance)).catch(() => {});
      toast.success(t('pointsRedeemed'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableRedeemPointsPleaseTry')));
    } finally { setBusy(false); }
  }

  async function doUnredeemPoints() {
    setBusy(true);
    try {
      applyUpdated(await bookingsApi.unredeemPoints(bk.id));
      if (bk?.customer) loyaltyApi.summary(bk.customer).then((s) => setPointsBal(s.balance)).catch(() => {});
      toast.success(t('redemptionReversed'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableReverseRedemptionPleaseTry')));
    } finally { setBusy(false); }
  }

  async function applyPromo() {
    const code = promo.trim();
    if (!code) return;
    setPromoBusy(true);
    try {
      const updated = await bookingsApi.applyPromo(bk.id, code);
      setBk(updated);
      setPromo('');
      // Only the still-outstanding amount is collected - never the full total.
      setAmount(Number(updated.outstanding ?? updated.total_amount ?? 0).toFixed(decimals));
      onChanged?.(updated);
      toast.success(t('promoApplied'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableApplyPromoCodePlease')));
    } finally {
      setPromoBusy(false);
    }
  }

  async function removePromo() {
    setPromoBusy(true);
    try {
      const updated = await bookingsApi.removePromo(bk.id);
      setBk(updated);
      setAmount(Number(updated.outstanding ?? updated.total_amount ?? 0).toFixed(decimals));
      onChanged?.(updated);
      toast.success(t('promoRemoved'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableRemovePromoCodePlease')));
    } finally {
      setPromoBusy(false);
    }
  }

  // After redeem/unapply, refresh local totals + the amount field, and let the
  // parent detail page stay in sync.
  function applyUpdated(updated) {
    setBk(updated);
    setAmount(Number(updated.outstanding ?? updated.total_amount ?? 0).toFixed(decimals));
    onChanged?.(updated);
  }

  async function doRedeem() {
    setBusy(true);
    try {
      applyUpdated(await bookingsApi.redeemSubscription(bk.id));
      toast.success(t('subscriptionRedeemedCoverageApplied'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableRedeemSubscriptionPleaseTry')));
    } finally { setBusy(false); }
  }

  async function doUnapply() {
    setBusy(true);
    try {
      applyUpdated(await bookingsApi.unapplySubscription(bk.id, ''));
      toast.success(t('subscriptionUnappliedBookingNowChargeable'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUnapplySubscriptionPleaseTry')));
    } finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true);
    try {
      const payload = needsPayment
        ? { method, amount, reference: reference || undefined, notes: notes || undefined }
        : {};
      if (isBill) {
        const updated = await bookingsApi.bill(bk.id, payload);
        toast.success(`Invoice ${updated.paid_invoice_number || ''} generated and payment recorded`);
        onCompleted?.(updated);   // "done" → parent closes + refreshes
      } else {
        const updated = await bookingsApi.complete(bk.id, payload);
        onCompleted?.(updated);
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, isBill
        ? t('invoiceFailed')
        : t('unableCompleteBookingPleaseTry')));
    } finally {
      setBusy(false);
    }
  }

  // Bill mode requires an amount to collect; complete mode can proceed with nothing due.
  const amountInvalid = needsPayment && (!amount || Number(amount) <= 0 || Number(amount) > outstanding + 0.0001);
  const submitDisabled = busy || amountInvalid || (isBill && !needsPayment);

  return (
    <Modal
      open={open} onClose={onClose} title={isBill ? t('invoiceReceipt') : t('completeBooking')} size="md"
      footer={(
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitDisabled}>
            {busy ? 'Saving…' : (isBill
              ? 'Confirm'
              : (needsPayment ? t('recordPaymentComplete') : t('completeBooking')))}
          </button>
        </>
      )}
    >
      {/* Subscription coverage - a PRE-INVOICE action only. Once an invoice exists
          the banners are hidden (coverage is frozen). */}
      {!hasInvoice && bk?.eligible_subscription && hasPerm('bookings.apply_subscription') && (
        <div role="status" style={{
          marginBottom: 10, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: 'var(--color-info-bg, #eff6ff)', border: '1px solid var(--color-info, #3b82f6)',
        }}>
          <strong>{t('eligibleSubscriptionAvailableBooking')}</strong>{' '}
          {bk.eligible_subscription.membership_number} - {bk.eligible_subscription.plan_name}:{' '}
          {bk.eligible_subscription.covered.map((c) => c.label).join(', ')}.
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={doRedeem}>
              {t('redeemSubscription')}
            </button>
          </div>
        </div>
      )}
      {!hasInvoice && bk?.coverage_snapshot && !bk?.subscription_opt_out && hasPerm('bookings.unapply_subscription') && (
        <div role="status" style={{
          marginBottom: 10, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: 'var(--color-success-bg, #ecfdf5)', border: '1px solid var(--color-success, #10b981)',
        }}>
          <strong>{t('coveredMembership')}</strong> ({bk.coverage_snapshot.membership_number} - {bk.coverage_snapshot.plan_name}).
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={doUnapply}>
              {t('unapplySubscription')}
            </button>
          </div>
        </div>
      )}

      {/* Loyalty points redemption - a PRE-INVOICE action. */}
      {!hasInvoice && hasPerm('loyalty.redeem') && (Number(bk?.loyalty_points_redeemed) > 0 || (pointsBal > 0 && needsPayment)) && (
        <div role="status" style={{
          marginBottom: 10, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: 'var(--color-warning-bg, #fff7ed)', border: '1px solid var(--color-warning, #f59e0b)',
        }}>
          {Number(bk?.loyalty_points_redeemed) > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span><strong>{bk.loyalty_points_redeemed} points</strong> redeemed
                {Number(bk?.loyalty_discount) > 0 && (<> · − <Money amount={bk.loyalty_discount} code={currency} /></>)}.</span>
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', color: 'var(--color-danger,#dc2626)' }}
                disabled={busy} onClick={doUnredeemPoints}>{t('undo')}</button>
            </div>
          ) : (
            <>
              <strong>{pointsBal} loyalty points available.</strong>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input className="form-input" type="number" min="1" max={pointsBal} value={redeemInput}
                  onChange={(e) => setRedeemInput(e.target.value)} placeholder={t('pointsRedeem')} style={{ flex: 1 }} />
                <button type="button" className="btn btn-secondary" disabled={busy || !redeemInput} onClick={doRedeemPoints}>
                  {t('redeem')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Pricing review */}
      <div className="modal-section">{t('pricingSummary')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SummaryRow label={t('originalAmount')} value={<Money amount={bk?.base_amount} code={currency} />} />
        {Number(bk?.addons_amount) > 0 && (
          <SummaryRow label={t('addOns')} value={<Money amount={bk?.addons_amount} code={currency} />} />
        )}
        {Number(bk?.surcharge_amount) > 0 && (
          <SummaryRow label={t('surchargesRules')} value={<Money amount={bk?.surcharge_amount} code={currency} />} />
        )}
        {Number(bk?.discount_amount) > 0 && (
          <SummaryRow label={t('discounts')} value={<>− <Money amount={bk?.discount_amount} code={currency} /></>} />
        )}
        {Number(bk?.promo_discount) > 0 && (
          <SummaryRow
            label={`Promo${bk?.promo_code_label ? ` (${bk.promo_code_label})` : ''}`}
            value={<>− <Money amount={bk?.promo_discount} code={currency} /></>}
          />
        )}
        {bk?.coverage_snapshot && Number(bk.coverage_snapshot.covered_amount) > 0 && (
          <SummaryRow
            label={`Covered by membership${bk.coverage_snapshot.membership_number ? ` (${bk.coverage_snapshot.membership_number})` : ''}`}
            value={<>− <Money amount={bk.coverage_snapshot.covered_amount} code={currency} /></>}
          />
        )}
        {Number(bk?.loyalty_discount) > 0 && (
          <SummaryRow
            label={`Loyalty points${bk?.loyalty_points_redeemed ? ` (${bk.loyalty_points_redeemed} pts)` : ''}`}
            value={<>− <Money amount={bk?.loyalty_discount} code={currency} /></>}
          />
        )}
        {Number(bk?.tax_amount) > 0 && (
          <SummaryRow label={t('taxVat')} value={<Money amount={bk?.tax_amount} code={currency} />} />
        )}
        <div style={{ borderTop: '1px solid var(--color-border)', margin: '6px 0' }} />
        <SummaryRow strong label={t('common:labels.total')} value={<Money amount={bk?.total_amount} code={currency} />} />
        {amountPaid > 0 && (
          <SummaryRow label={t('paid')} value={<>− <Money amount={amountPaid} code={currency} /></>} />
        )}
        {needsPayment ? (
          <SummaryRow strong label={amountPaid > 0 ? t('balanceDue') : t('amountDue')}
            value={<Money amount={outstanding} code={currency} />} />
        ) : settled ? (
          <SummaryRow strong label={t('paymentStatus')}
            value={<span style={{ color: 'var(--color-success, #10b981)' }}>
              Fully paid{bk?.paid_invoice_number ? ` · ${bk.paid_invoice_number}` : ''}
            </span>} />
        ) : null}
      </div>

      {/* Promo management needs promotions.view; available while a balance remains.
          (The masked code still shows in the pricing summary above for others.) */}
      {needsPayment && hasPerm('promotions.view') && (
        <FormField label={t('promoCouponCode')} hint={t('optionalApplyDiscountBeforePaying')}>
          {bk?.promo_code ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span>{t('promo')} <strong>{bk.promo_code_label || bk.promo_code}</strong> applied
                {Number(bk?.promo_discount) > 0 && (<> · − <Money amount={bk.promo_discount} code={currency} /></>)}
              </span>
              <button type="button" className="btn btn-ghost btn-sm"
                style={{ marginLeft: 'auto', color: 'var(--color-danger,#dc2626)' }}
                disabled={promoBusy} onClick={removePromo}>{promoBusy ? t('removing') : t('common:actions.remove')}</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="form-input" value={promo} onChange={(e) => setPromo(e.target.value)}
                placeholder={t('eGWelcome10')} style={{ textTransform: 'uppercase', flex: 1 }} />
              <button type="button" className="btn btn-secondary" onClick={applyPromo}
                disabled={promoBusy || !promo.trim()}>{promoBusy ? t('applying') : t('common:actions.apply')}</button>
            </div>
          )}
        </FormField>
      )}

      {/* Payment capture - only the outstanding (delta) is ever collected */}
      {needsPayment ? (
        <>
          <div className="modal-section">{t('payment')}</div>
          <div className="row">
            <div className="col">
              <FormField label={t('paymentMethod')}>
                <Select2 options={payMethods(t)} value={method} onChange={setMethod} />
              </FormField>
            </div>
            <div className="col">
              <FormField label={t('amountPaid')} error={amountInvalid ? 'Enter a valid amount.' : undefined}>
                <input className="form-input" type="number" min="0" value={amount}
                  onChange={(e) => setAmount(e.target.value)} />
              </FormField>
            </div>
          </div>
          <FormField label={t('transactionReference')} hint={t('optionalTerminalReceiptReference')}>
            <input className="form-input" value={reference} onChange={(e) => setReference(e.target.value)} />
          </FormField>
          <FormField label={t('common:labels.notes')} hint={t('optionalKeptAuditTrail')}>
            <textarea className="form-textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </>
      ) : (
        <p className="muted" style={{ marginTop: 10 }}>
          {settled
            ? `Payment already received${bk?.paid_invoice_number ? ` against Invoice ${bk.paid_invoice_number}` : ''}. No additional payment required.`
            : 'No payment is due for this booking. Completing it will finalize the records.'}
        </p>
      )}
    </Modal>
  );
}

function SummaryRow({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0',
      fontWeight: strong ? 700 : 400 }}>
      <span className={strong ? '' : 'muted'}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
