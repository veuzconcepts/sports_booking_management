import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Calendar, LayoutGrid, MapPin, User, UserX, RefreshCw, XCircle, Tag, RotateCcw, FileText, Copy, Pencil, Trash2,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { BookingFinancePanel } from '../../components/BookingFinancePanel.jsx';
import { BookingFormModal } from './BookingFormModal.jsx';
import { PaymentSuccessModal } from '../../components/PaymentSuccessModal.jsx';
import { RefundModal } from '../../components/RefundModal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { CompletionPaymentWizard } from '../../components/CompletionPaymentWizard.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';

import {
  BOOKING_STATUSES,
  NEXT_STATUSES,
  bookingsApi,
  bookingDuplicateInitial,
  bookingEditInitial,
} from '../../services/bookingsService.js';
import { usersApi } from '../../services/usersService.js';
import {
  invoicesApi, receiptsApi, creditNotesApi,
} from '../../services/paymentsService.js';

const STAFF = ['super_admin', 'admin', 'club_admin', 'manager', 'facility_operator', 'facility_staff'];
import { Money } from '../../services/currency.jsx';
import { formatTime, formatDateTime, formatDate } from '../../services/timeformat.jsx';
import { usePrompt } from '../../components/PromptDialog.jsx';
import { apiErrorMessage } from '../../utils/apiError';
import { actorLabel } from '../../utils/actor';

const statusLabel = (v) => BOOKING_STATUSES.find((s) => s.value === v)?.label || v;
const PRIORITY_TONE = { normal: 'muted', urgent: 'warning', vip: 'danger' };
const PAYMENT_TONE = {
  pending: 'warning', paid: 'success', partially_paid: 'info',
  covered: 'success', no_payment_required: 'muted',
};
// Subscription coverage state on a booking (distinguishes a temporary hold from
// final consumption, so a 0 amount is never ambiguous).
const COVERAGE_STATE = {
  consumed:   { tone: 'success', label: 'Subscription consumed' },
  held:       { tone: 'info',    label: 'Subscription held / reserved (deducted on completion)' },
  at_risk:    { tone: 'warning', label: 'Held - subscription no longer available; revalidates at completion' },
  released:   { tone: 'muted',   label: 'Subscription released - charged separately' },
  eligible:   { tone: 'info',    label: 'Eligible subscription available' },
  chargeable: { tone: 'muted',   label: 'Chargeable - no subscription applied' },
};

export default function BookingDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { role, hasPerm, user } = useAuth();
  const prompt = usePrompt();
  const isStaff = STAFF.includes(role);

  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [assignOpen, setAssignOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [promoInput, setPromoInput] = useState('');
  const [finance, setFinance] = useState({ invoices: [], payments: [] });
  const [refundFor, setRefundFor] = useState(null);
  const [successInvoice, setSuccessInvoice] = useState(null);
  const [dup, setDup] = useState(null);   // duplicate prefill payload (null = closed)
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteReasons, setDeleteReasons] = useState([]);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteNote, setDeleteNote] = useState('');
  const [completeOpen, setCompleteOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false);          // Invoice & Receipt wizard
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const seenPaidRef = useRef(new Set());
  const financeInitedRef = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    bookingsApi.get(id)
      .then(setBooking)
      .catch((e) => toast.error(apiErrorMessage(e, 'Unable to load the booking. Please try again.')))
      .finally(() => setLoading(false));
  }, [id]);

  const loadFinance = useCallback(async () => {
    if (!hasPerm('invoicing.view') && !hasPerm('payments.view')) return;
    try {
      const data = await bookingsApi.finance(id);
      const invoices = data.invoices || [];
      // Detect a newly-PAID invoice (a payment just succeeded) to pop the
      // one-time confirmation. The first load only seeds the baseline, so
      // re-opening an already-paid booking never re-shows the modal.
      const paid = invoices.filter((i) => i.status === 'paid' && i.receipt);
      if (!financeInitedRef.current) {
        financeInitedRef.current = true;
      } else {
        const fresh = paid.find((i) => !seenPaidRef.current.has(i.id));
        if (fresh) setSuccessInvoice(fresh);
      }
      paid.forEach((i) => seenPaidRef.current.add(i.id));
      setFinance({ invoices, payments: data.payments || [] });
    } catch { /* ignore */ }
  }, [id, hasPerm]);

  useEffect(load, [load]);
  useEffect(() => { loadFinance(); }, [loadFinance]);

  async function doTransition(status) {
    setBusy(true);
    try {
      const updated = await bookingsApi.transition(id, status);
      setBooking(updated);
      toast.success(`Moved to ${statusLabel(status)}`);
      loadFinance();   // completion may auto-raise an invoice/receipt → pops the success modal
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to update the booking status. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  // Assign control (shown only while Pending). If a worker is already on the
  // booking, there's nothing to assign - just advance to the next stage; the
  // operator is changed via Edit. Otherwise open the assign / skip dialog.
  function handleAssignClick() {
    if (booking.assigned_to) {
      const next = (NEXT_STATUSES[booking.status] || [])[0];
      if (next) doTransition(next);
    } else {
      setAssignOpen(true);
    }
  }

  async function doCancel() {
    const note = await prompt({ title: 'Cancel booking', label: 'Reason for cancellation', multiline: true });
    if (note === null) return;
    setBusy(true);
    try {
      const updated = await bookingsApi.cancel(id, note);
      setBooking(updated);
      toast.success('Booking cancelled');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to cancel the booking. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function doNoShow() {
    const note = await prompt({ title: 'Mark no-show', label: 'Note (optional)', multiline: true });
    if (note === null) return;
    setBusy(true);
    try {
      const updated = await bookingsApi.noShow(id, note);
      setBooking(updated);
      toast.success('Marked as no-show');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to mark the booking as no-show. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function doApplyPromo() {
    setBusy(true);
    try {
      const updated = await bookingsApi.applyPromo(id, promoInput.trim());
      setBooking(updated); setPromoInput('');
      toast.success('Promo applied');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to apply the promo code. Please try again.'));
    } finally { setBusy(false); }
  }

  async function doRedeemSubscription() {
    setBusy(true);
    try {
      const updated = await bookingsApi.redeemSubscription(id);
      setBooking(updated);
      toast.success('Subscription redeemed - coverage applied to this booking');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to redeem the subscription. Please try again.'));
    } finally { setBusy(false); }
  }

  async function doUnapplySubscription() {
    const reason = await prompt({ title: 'Unapply subscription',
      label: 'Reason (optional)', multiline: true });
    if (reason === null) return;   // dismissed
    setBusy(true);
    try {
      const updated = await bookingsApi.unapplySubscription(id, reason || '');
      setBooking(updated);
      toast.success('Subscription unapplied - this booking is now chargeable');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to unapply the subscription. Please try again.'));
    } finally { setBusy(false); }
  }

  // After the Invoice & Receipt wizard records payment + raises the invoice/receipt,
  // refresh the booking + finance panel so the new paid state shows immediately.
  function onBilled(updated) {
    if (updated) setBooking(updated);
    setBillOpen(false);
    load();
    loadFinance();
  }

  async function downloadDoc(getBlob, number) {
    try {
      const blob = await getBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${number}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error(apiErrorMessage(e, 'Unable to download the document. Please try again.')); }
  }
  const downloadInvoice = (inv) => downloadDoc(() => invoicesApi.download(inv.id), inv.number);

  async function doCancelInvoice(inv) {
    const reason = await prompt({ title: 'Cancel invoice', label: 'Reason (optional)', defaultValue: '' });
    if (reason === null) return;            // dialog dismissed
    setBusy(true);
    try {
      await invoicesApi.cancel(inv.id, reason);
      toast.success('Invoice cancelled');
      loadFinance();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to cancel the invoice. Please try again.'));
    } finally { setBusy(false); }
  }

  async function runRefund({ amount, reason, method }) {
    setBusy(true);
    try {
      const cn = await invoicesApi.requestRefund(refundFor.id, { amount, reason, method });
      toast.success(cn.status === 'pending_approval'
        ? `Refund ${cn.number} submitted for approval`
        : `Refund processed - credit note ${cn.number}`);
      setRefundFor(null);
      loadFinance();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to request the refund. Please try again.'));
    } finally { setBusy(false); }
  }

  async function doRemovePromo() {
    setBusy(true);
    try {
      const updated = await bookingsApi.removePromo(id);
      setBooking(updated);
      toast.success('Promo removed');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to remove the promo code. Please try again.'));
    } finally { setBusy(false); }
  }

  async function doReopen() {
    const isNoShow = booking.status === 'no_show';
    const note = await prompt({
      title: isNoShow ? 'Reset no-show' : 'Reopen booking',
      label: isNoShow
        ? 'Reason (optional) - restores the booking to its status before No-show'
        : 'Reason (optional)',
      multiline: true,
    });
    if (note === null) return;
    setBusy(true);
    try {
      const updated = await bookingsApi.reopen(id, note);
      setBooking(updated);
      toast.success(isNoShow
        ? 'No-show reset - booking restored to its previous status.'
        : 'Booking reopened successfully.');
    } catch (e) {
      toast.error(apiErrorMessage(e, isNoShow
        ? 'Unable to reset the no-show. Please try again.'
        : 'Unable to reopen the booking. Please try again.'));
    } finally { setBusy(false); }
  }

  function openDelete() {
    setDeleteReason(''); setDeleteNote('');
    setConfirmDelete(true);
    if (deleteReasons.length === 0) {
      bookingsApi.deletionReasons().then(setDeleteReasons).catch(() => setDeleteReasons([]));
    }
  }

  async function doDelete() {
    if (!deleteReason) { toast.error('Select a reason for deleting this booking.'); return; }
    if (deleteReason.toLowerCase() === 'other' && !deleteNote.trim()) {
      toast.error('Describe the reason when choosing “Other”.'); return;
    }
    setBusy(true);
    try {
      await bookingsApi.remove(id, { reason: deleteReason, reason_note: deleteNote.trim() });
      toast.success('Booking deleted successfully.');
      navigate('/bookings');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to delete the booking. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="card"><div className="card-body center" style={{ padding: 64 }}><span className="muted">Loading booking…</span></div></div>;
  }
  if (!booking) return null;

  const nextStatuses = NEXT_STATUSES[booking.status] || [];
  // Fully terminal = no further forward action (hides the Actions card).
  // 'completed' is NOT terminal - it can still be Closed.
  const terminal = ['closed', 'cancelled', 'no_show'].includes(booking.status);
  // Pricing is frozen once the booking is finalised or fully paid (nothing left to
  // discount). While a balance remains a promo can still be applied to it.
  const fullyPaid = Number(booking.outstanding ?? 0) <= 0
    && (booking.payment_status === 'paid' || Number(booking.amount_paid || 0) > 0);
  const priceLocked = ['completed', 'closed', 'cancelled', 'no_show'].includes(booking.status)
    || fullyPaid;
  const canNoShow = ['booked', 'confirmed', 'assigned', 'arrived'].includes(booking.status);
  const canReopen = ['completed', 'closed', 'cancelled', 'no_show'].includes(booking.status)
    && hasPerm('bookings.reopen');

  return (
    <>
      <button className="btn btn-ghost" onClick={() => navigate('/bookings')} style={{ marginBottom: 12 }}>
        <ArrowLeft size={15} /> Back to bookings
      </button>

      <PageHeader
        title={booking.reference}
        subtitle={[booking.facility_type_name || booking.facility_category_name,
                   booking.club_name, booking.facility_name].filter(Boolean).join(' \u00b7 ')}
        actions={
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <StatusBadge status={booking.status} />
            {hasPerm('bookings.edit') && booking.can_modify && (
              <button className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => setEditOpen(true)}>
                <Pencil size={15} /> Edit
              </button>
            )}
            {hasPerm('bookings.duplicate') && (
              <button className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => setDup(bookingDuplicateInitial(booking))}>
                <Copy size={15} /> Duplicate
              </button>
            )}
            {hasPerm('bookings.delete') && booking.can_delete && (
              <button className="btn btn-secondary btn-sm" disabled={busy}
                onClick={openDelete} style={{ color: 'var(--color-danger, #dc2626)' }}>
                <Trash2 size={15} /> Delete
              </button>
            )}
            {canReopen && (
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={doReopen}>
                <RotateCcw size={15} /> {booking.status === 'no_show' ? 'Reset no-show' : 'Reopen'}
              </button>
            )}
          </div>
        }
      />

      <BookingStatusPath status={booking.status} />

      {booking.customer_info_updated && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
          padding: '12px 16px', borderRadius: 10,
          background: 'var(--color-warning-bg, #fff7ed)', border: '1px solid var(--color-warning, #f59e0b)',
        }}>
          <UserX size={18} style={{ color: 'var(--color-warning, #b45309)', flexShrink: 0 }} />
          <span style={{ fontSize: 13.5 }}>
            <strong>Existing customer updated their information</strong> while placing this booking -
            review the customer’s details to confirm the change.
          </span>
        </div>
      )}

      <div className="row">
        {/* --- Summary --- */}
        <div className="col" style={{ flex: '1 1 340px' }}>
          <div className="card">
            <div className="card-header"><h3 className="card-title">Details</h3></div>
            <div className="card-body">
              <KV icon={User} label="Customer">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {booking.customer_label}{booking.booking_type === 'walk_in' ? ' · Walk-in' : ''}
                  {booking.customer != null && (
                    booking.customer_was_new
                      ? <StatusBadge tone="info" label="New customer" />
                      : <StatusBadge tone="muted" label="Existing customer" />
                  )}
                  {booking.customer_verified === true && <StatusBadge tone="success" label="Verified" />}
                  {booking.customer_verified === false && <StatusBadge tone="warning" label="Unverified" />}
                </span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {booking.customer_email || booking.walk_in_email || booking.walk_in_phone || ''}
                </div>
              </KV>
              <KV icon={LayoutGrid} label="Facility">
                {booking.facility_type_name || booking.facility_category_name || '-'}
              </KV>
              <KV icon={Calendar} label="Scheduled">
                {formatDate(booking.scheduled_date)} at {formatTime(booking.scheduled_time)}
                <div className="muted" style={{ fontSize: 12 }}>{booking.duration_minutes} min</div>
              </KV>
              <KV icon={MapPin} label="Club / Facility">
                {booking.club_name || '-'}
                {booking.facility_name ? ` · ${booking.facility_name}` : ''}
              </KV>
              <KV icon={User} label="Assigned to">{booking.assigned_to_name || <span className="muted">Unassigned</span>}</KV>
              <KV label="Priority">
                <StatusBadge tone={PRIORITY_TONE[booking.priority] || 'muted'} label={booking.priority} />
                {booking.booking_type ? <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{booking.booking_type === 'walk_in' ? 'Walk-in' : 'Advance'}</span> : null}
              </KV>
              <KV label="Payment">
                <StatusBadge tone={PAYMENT_TONE[booking.payment_status] || 'muted'} label={(booking.payment_status || '').replace('_', ' ')} />
                {booking.payment_method ? <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{booking.payment_method.replace('_', ' ')}</span> : null}
              </KV>
              <KV label="Source">{booking.source_display || (booking.source ? booking.source.replace('_', ' ') : '-')}</KV>
              {booking.add_on_names?.length > 0 && (
                <KV label="Add-ons">{booking.add_on_names.join(', ')}</KV>
              )}
              {booking.customer_notes && <KV label="Customer notes">{booking.customer_notes}</KV>}
              {booking.internal_notes && <KV label="Internal notes">{booking.internal_notes}</KV>}
              {booking.special_instructions && <KV label="Special instructions">{booking.special_instructions}</KV>}
              <KV label="Created by">
                {booking.created_by_name || '-'}
                {booking.updated_by_name ? <div className="muted" style={{ fontSize: 12 }}>Last updated by {booking.updated_by_name}</div> : null}
              </KV>
            </div>
          </div>

          <div style={{ height: 16 }} />

          <div className="card">
            <div className="card-header"><h3 className="card-title">Pricing</h3></div>
            <div className="card-body">
              {/* Clear subscription state - never confuse a temporary hold with final use. */}
              {booking.coverage_state && COVERAGE_STATE[booking.coverage_state] && (
                <div style={{ marginBottom: 8 }}>
                  <StatusBadge tone={COVERAGE_STATE[booking.coverage_state].tone}
                    label={COVERAGE_STATE[booking.coverage_state].label} />
                </div>
              )}
              {/* A membership became eligible AFTER this booking was priced - redeem it
                  here without re-editing the whole booking (pre-payment, non-terminal). */}
              {booking.eligible_subscription
                && !['completed', 'closed', 'cancelled', 'no_show'].includes(booking.status)
                && !['paid', 'partially_paid'].includes(booking.payment_status) && (
                <div role="status" style={{
                  marginBottom: 10, padding: '10px 12px', borderRadius: 8, fontSize: 13,
                  background: 'var(--color-info-bg, #eff6ff)',
                  border: '1px solid var(--color-info, #3b82f6)',
                }}>
                  <strong>Eligible subscription available for this booking.</strong>{' '}
                  {booking.eligible_subscription.membership_number} - {booking.eligible_subscription.plan_name}:{' '}
                  {booking.eligible_subscription.covered.map((c) => c.label).join(', ')}.
                  {(booking.eligible_subscription.held_by || []).length > 0 && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Currently held by: {booking.eligible_subscription.held_by.join(', ')}
                    </div>
                  )}
                  {hasPerm('bookings.apply_subscription') && (
                    <div style={{ marginTop: 8 }}>
                      <button className="btn btn-primary btn-sm" disabled={busy} onClick={doRedeemSubscription}>
                        Redeem from Subscription
                      </button>
                    </div>
                  )}
                </div>
              )}
              {booking.coverage_snapshot ? (
                // Booking-time snapshot (immutable): what the subscription covered + the
                // money breakdown as it stood when the booking was priced.
                <div role="status" style={{
                  marginBottom: 10, padding: '10px 12px', borderRadius: 8, fontSize: 13,
                  background: 'var(--color-success-bg, #ecfdf5)',
                  border: '1px solid var(--color-success, #10b981)',
                }}>
                  <strong>Covered by Membership</strong>{' '}
                  ({booking.coverage_snapshot.membership_number} - {booking.coverage_snapshot.plan_name})
                  <div style={{ marginTop: 4 }}>
                    {(booking.coverage_snapshot.covered_lines || []).map((l, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{l.label}</span>
                        <span><Money amount={l.actual_price} code={booking.coverage_snapshot.currency} /></span>
                      </div>
                    ))}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Covered <Money amount={booking.coverage_snapshot.covered_amount} code={booking.coverage_snapshot.currency} />
                    {' · '}Payable <Money amount={booking.coverage_snapshot.payable_amount} code={booking.coverage_snapshot.currency} />
                    {' · '}Usage deducted on completion
                  </div>
                  {hasPerm('bookings.unapply_subscription') && !booking.subscription_opt_out
                    && !['completed', 'closed', 'cancelled', 'no_show'].includes(booking.status)
                    && !['paid', 'partially_paid'].includes(booking.payment_status) && (
                    <div style={{ marginTop: 8 }}>
                      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={doUnapplySubscription}>
                        Unapply Subscription
                      </button>
                    </div>
                  )}
                </div>
              ) : booking.membership_coverage && (
                <div role="status" style={{
                  marginBottom: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13,
                  background: 'var(--color-success-bg, #ecfdf5)',
                  border: '1px solid var(--color-success, #10b981)',
                }}>
                  <strong>Covered by Membership</strong> ({booking.membership_coverage.membership_number} - {booking.membership_coverage.plan_name}):{' '}
                  {booking.membership_coverage.covered.map((c) => c.label).join(', ')}. Usage is
                  deducted on completion.
                </div>
              )}
              {booking.price_breakdown?.length ? (
                <>
                  {booking.price_breakdown.map((ln, i) => (
                    <div key={i} style={{ padding: '4px 0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span>{ln.label}{ln.tax_inclusive && <span className="muted" style={{ fontSize: 11 }}> · incl. VAT</span>}</span>
                        <span><Money amount={ln.total} code={booking.currency} /></span>
                      </div>
                      {(Number(ln.discount) > 0 || Number(ln.tax) > 0) && (
                        <div className="muted" style={{ fontSize: 11.5, display: 'flex', gap: 12, marginTop: 1 }}>
                          {Number(ln.discount) > 0 && <span>Discount − <Money amount={ln.discount} code={booking.currency} /></span>}
                          <span>VAT {ln.tax_inclusive ? '' : '+ '}<Money amount={ln.tax} code={booking.currency} /></span>
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="divider" style={{ margin: '4px 0' }} />
                  <PriceRow label="Subtotal (excl. VAT)"
                    value={<Money amount={(Number(booking.total_amount) - Number(booking.tax_amount)).toFixed(2)} code={booking.currency} />} />
                  <PriceRow label="VAT" value={<Money amount={booking.tax_amount} code={booking.currency} />} />
                </>
              ) : (
                <>
                  <PriceRow label="Service" value={<Money amount={booking.base_amount} code={booking.currency} />} />
                  {Number(booking.addons_amount) > 0 && (
                    <PriceRow label="Add-ons" value={<Money amount={booking.addons_amount} code={booking.currency} />} />
                  )}
                  {Number(booking.surcharge_amount) > 0 && (
                    <PriceRow label="Surcharges" value={<>+ <Money amount={booking.surcharge_amount} code={booking.currency} /></>} />
                  )}
                  {Number(booking.discount_amount) > 0 && (
                    <PriceRow label="Discounts" value={<>- <Money amount={booking.discount_amount} code={booking.currency} /></>} />
                  )}
                  <PriceRow label={booking.tax_inclusive ? 'VAT (included)' : 'VAT'} value={<Money amount={booking.tax_amount} code={booking.currency} />} />
                </>
              )}

              {booking.applied_rules?.length > 0 && (
                <div style={{ margin: '6px 0 2px' }}>
                  <div className="muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
                    Applied rules
                  </div>
                  {booking.applied_rules.map((r) => (
                    <div key={r.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '2px 0',
                    }}>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.name}
                        <span className="muted"> · {r.rule_type_display || r.rule_type} · {r.adjustment}</span>
                      </span>
                      <span style={{ whiteSpace: 'nowrap', color: Number(r.amount) < 0 ? 'var(--color-success,#16a34a)' : 'var(--color-text)' }}>
                        {Number(r.amount) < 0 ? '- ' : '+ '}<Money amount={Math.abs(Number(r.amount))} code={booking.currency} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="divider" />
              <PriceRow label="Total" value={<Money amount={booking.total_amount} code={booking.currency} />} strong />
              {booking.calculated_at && (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                  Priced {formatDateTime(booking.calculated_at)}
                </div>
              )}
              {(hasPerm('invoicing.view') || hasPerm('payments.view')) && (
                <div style={{ marginTop: 14 }}>
                  <BookingFinancePanel
                    finance={finance}
                    canViewInvoices={hasPerm('invoicing.view')}
                    canViewPayments={hasPerm('payments.view')}
                    canReverse={hasPerm('invoicing.credit')}
                    canInvoice={hasPerm('invoicing.add')}
                    canCancel={hasPerm('invoicing.cancel_invoice')}
                    busy={busy}
                    onRefund={(inv) => setRefundFor(inv)}
                    onCancel={(inv) => doCancelInvoice(inv)}
                    outstanding={Number(booking.outstanding ?? 0)}
                    onGenerate={hasPerm('invoicing.add') && hasPerm('payments.add')
                      && Number(booking.total_amount) > 0 ? () => setConfirmGenerate(true) : undefined}
                    onCollect={hasPerm('invoicing.add') && hasPerm('payments.add')
                      ? () => setBillOpen(true) : undefined}
                    onDownloadInvoice={(inv) => downloadInvoice(inv)}
                    onDownloadReceipt={(inv) => inv.receipt && downloadDoc(() => receiptsApi.download(inv.receipt.id), inv.receipt.number)}
                    onDownloadCreditNote={(cn) => downloadDoc(() => creditNotesApi.download(cn.id), cn.number)}
                  />
                </div>
              )}

              {!terminal && !priceLocked && hasPerm('promotions.view') && (
                <div style={{ marginTop: 12 }}>
                  {booking.promo_code ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                      <Tag size={14} /> Promo <strong>{booking.promo_code_label}</strong> applied
                      <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', color: 'var(--color-danger,#dc2626)' }}
                        disabled={busy} onClick={doRemovePromo}>Remove</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input className="form-input" value={promoInput} onChange={(e) => setPromoInput(e.target.value)}
                        placeholder="Promo code" style={{ flex: 1, textTransform: 'uppercase' }} />
                      <button className="btn btn-secondary" disabled={busy || !promoInput.trim()} onClick={doApplyPromo}>Apply</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

        </div>

        {/* --- Actions + timeline --- */}
        <div className="col" style={{ flex: '1.4 1 420px' }}>
          {isStaff && !terminal && (
            <div className="card">
              <div className="card-header"><h3 className="card-title">Actions</h3></div>
              <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {/* Assigned goes through the Assign dialog; Completed goes through
                    the Completion & Payment wizard - neither is a raw status jump,
                    so assignment can't be bypassed and completion requires payment. */}
                {nextStatuses.filter((s) => s !== 'assigned' && s !== 'completed').map((s) => (
                  <button key={s} className="btn btn-primary" disabled={busy} onClick={() => doTransition(s)}>
                    {statusLabel(s)}
                  </button>
                ))}
                {nextStatuses.includes('completed') && hasPerm('bookings.edit') && (
                  <button className="btn btn-primary" disabled={busy} onClick={() => setCompleteOpen(true)}>
                    <FileText size={15} /> Complete &amp; pay
                  </button>
                )}
                {/* Assign belongs to the assignment stage only (after Confirmed):
                    assign a worker (dialog) or, if one is already set, just move
                    to Assigned. Once assigned, this disappears - progress with the
                    status buttons and change the operator via Edit. */}
                {booking.status === 'confirmed'
                  && (hasPerm('bookings.assign') || hasPerm('bookings.skip_assignment')) && (
                  <button className="btn btn-primary" disabled={busy} onClick={handleAssignClick}>
                    <User size={15} /> {booking.assigned_to ? 'Move to Assigned' : 'Assign'}
                  </button>
                )}
                {booking.recurrence !== 'none' && (
                  <button className="btn btn-ghost" disabled={busy} onClick={async () => {
                    const n = Number(await prompt({ title: 'Generate recurrences', label: 'How many future occurrences?', type: 'number', defaultValue: '4' }));
                    if (!n) return;
                    await bookingsApi.generateRecurrences(id, n);
                    toast.success(`${n} recurrences generated`);
                  }}><RefreshCw size={15} /> Generate recurrences</button>
                )}
                {canNoShow && (
                  <button className="btn btn-ghost" disabled={busy} onClick={doNoShow} style={{ color: 'var(--color-warning, #b45309)' }}>
                    <UserX size={15} /> Mark no-show
                  </button>
                )}
                <button className="btn btn-ghost" disabled={busy} onClick={doCancel} style={{ color: 'var(--color-danger, #dc2626)' }}>
                  <XCircle size={15} /> Cancel
                </button>
              </div>
            </div>
          )}

          <div style={{ height: isStaff && !terminal ? 16 : 0 }} />

          <div className="card">
            <div className="card-header"><h3 className="card-title">Booking log</h3></div>
            <div className="card-body">
              {(booking.status_history || []).length === 0 ? (
                <p className="muted">No activity yet - booking is freshly created.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {booking.status_history.map((h) => {
                    // from==to (non-empty) is an activity entry (coverage, payment,
                    // invoice, job-card…), not a status transition.
                    const isEvent = h.from_status && h.from_status === h.to_status;
                    const meta = h.meta || {};
                    return (
                      <div key={h.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <div style={{ marginTop: 3 }}><StatusBadge status={h.to_status} /></div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13 }}>
                            {isEvent
                              ? (h.note || statusLabel(h.to_status))
                              : <>{h.from_status ? `${statusLabel(h.from_status)} → ` : ''}{statusLabel(h.to_status)}</>}
                          </div>
                          {meta.covered_amount != null && (
                            <div className="muted" style={{ fontSize: 12 }}>
                              Covered <Money amount={meta.covered_amount} code={meta.currency} />
                              {meta.payable_amount != null && <> · Payable <Money amount={meta.payable_amount} code={meta.currency} /></>}
                            </div>
                          )}
                          {meta.amount != null && (
                            <div className="muted" style={{ fontSize: 12 }}>
                              Amount <Money amount={meta.amount} code={meta.currency} />
                            </div>
                          )}
                          <div className="muted" style={{ fontSize: 12 }}>
                            {formatDateTime(h.created_at)}
                            {' · by '}
                            <strong style={{ fontWeight: 600 }}>{actorLabel(h.changed_by, h.changed_by_name, user?.id)}</strong>
                            {meta.source ? ` · ${meta.source}` : ''}
                            {!isEvent && h.note ? ` · ${h.note}` : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <AssignModal
        open={assignOpen}
        booking={booking}
        canSkip={hasPerm('bookings.skip_assignment')}
        onClose={() => setAssignOpen(false)}
        onAssigned={(updated) => { setBooking(updated); setAssignOpen(false); toast.success('Worker assigned successfully.'); }}
        onSkipped={(updated) => { setBooking(updated); setAssignOpen(false); toast.success('Assignment skipped - booking moved to Assigned.'); }}
      />

      <RefundModal
        open={Boolean(refundFor)}
        invoice={refundFor}
        busy={busy}
        onClose={() => { if (!busy) setRefundFor(null); }}
        onConfirm={runRefund}
      />

      <PaymentSuccessModal
        open={Boolean(successInvoice)}
        invoice={successInvoice}
        onClose={() => setSuccessInvoice(null)}
        onDownloadInvoice={() => successInvoice && downloadInvoice(successInvoice)}
        onDownloadReceipt={() => successInvoice?.receipt && downloadDoc(() => receiptsApi.download(successInvoice.receipt.id), successInvoice.receipt.number)}
      />

      <BookingFormModal
        open={Boolean(dup)}
        initial={dup}
        onClose={() => setDup(null)}
        onSaved={(b) => { setDup(null); toast.success('Booking duplicated'); if (b?.id) navigate(`/bookings/${b.id}`); }}
      />

      <BookingFormModal
        open={editOpen}
        editId={booking.id}
        initial={editOpen ? bookingEditInitial(booking) : null}
        lockedExceptNotes={booking.status === 'closed'}
        onClose={() => setEditOpen(false)}
        onSaved={(b) => { setEditOpen(false); setBooking(b); toast.success('Booking updated successfully.'); }}
      />

      <Modal
        open={confirmDelete}
        onClose={() => { if (!busy) setConfirmDelete(false); }}
        title="Delete booking"
        size="sm"
        footer={
          <>
            <button className="btn btn-secondary" type="button" disabled={busy}
              onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button className="btn btn-danger" type="button" disabled={busy || !deleteReason}
              onClick={doDelete}>{busy ? 'Deleting…' : 'Delete booking'}</button>
          </>
        }
      >
        <p style={{ marginTop: 0, fontSize: 13.5 }}>
          Permanently delete booking <strong>{booking.reference}</strong> and its history.
          This cannot be undone. A reason is required for the audit trail.
        </p>
        <FormField label="Reason *">
          <Select2
            options={deleteReasons.map((r) => ({ value: r, label: r }))}
            value={deleteReason}
            onChange={setDeleteReason}
            placeholder="Select a reason…"
          />
        </FormField>
        <FormField label={`Note${deleteReason.toLowerCase() === 'other' ? ' *' : ' (optional)'}`}>
          <textarea className="form-textarea" rows={3} value={deleteNote}
            onChange={(e) => setDeleteNote(e.target.value)}
            placeholder="Add any detail for the record…" />
        </FormField>
      </Modal>

      <CompletionPaymentWizard
        open={completeOpen}
        booking={booking}
        onClose={() => setCompleteOpen(false)}
        onChanged={(updated) => setBooking(updated)}
        onCompleted={(updated) => {
          setCompleteOpen(false);
          setBooking(updated);
          toast.success('Booking completed successfully.');
          loadFinance();   // refreshes the panel and pops the invoice/receipt success modal
        }}
      />

      {/* Manual "Generate Invoice" - confirm first (booking not yet completed),
          then the same Invoice & Receipt wizard captures payment up front. */}
      <ConfirmDialog
        open={confirmGenerate}
        title="Generate invoice now?"
        message="This service booking has not yet been completed. Do you still want to generate the invoice?"
        confirmLabel="Yes, generate"
        busy={busy}
        onConfirm={() => { setConfirmGenerate(false); setBillOpen(true); }}
        onClose={() => setConfirmGenerate(false)}
      />
      <CompletionPaymentWizard
        open={billOpen}
        mode="bill"
        booking={booking}
        onClose={() => setBillOpen(false)}
        onChanged={(updated) => setBooking(updated)}   /* redeem/unapply: live sync, keep open */
        onCompleted={onBilled}                          /* invoice+payment done: close + refresh */
      />
    </>
  );
}

// Salesforce-style "Path": a horizontal chevron progress bar of the booking
// lifecycle. Purely presentational - reflects the current status, no actions.
const PATH_FLOW = [
  { value: 'booked', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'arrived', label: 'Checked in' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'closed', label: 'Closed' },
];
const PATH_NEGATIVE = { cancelled: 'Cancelled', no_show: 'No-show' };

function BookingStatusPath({ status }) {
  const negativeLabel = PATH_NEGATIVE[status];
  const currentIndex = PATH_FLOW.findIndex((s) => s.value === status);
  // For a cancelled / no-show booking the normal flow is greyed and a red
  // terminal chevron is appended to make the closed-negative outcome obvious.
  const steps = negativeLabel
    ? [...PATH_FLOW.map((s) => ({ ...s, state: 'muted' })),
       { value: status, label: negativeLabel, state: 'negative' }]
    : PATH_FLOW.map((s, i) => ({
        ...s,
        state: i < currentIndex ? 'complete' : i === currentIndex ? 'current' : 'upcoming',
      }));

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-body" style={{ paddingTop: 14, paddingBottom: 14 }}>
        <div className="sf-path">
          {steps.map((s, i) => (
            <div key={`${s.value}-${i}`} className={`sf-path-step is-${s.state}`} title={s.label}>
              {s.state === 'complete' && <span className="sf-path-check">✓</span>}
              {s.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AssignModal({ open, booking, canSkip = false, onClose, onAssigned, onSkipped }) {
  const [staff, setStaff] = useState([]);
  const [worker, setWorker] = useState('');
  const [facility, setFacility] = useState('');
  const [facilityOptions, setFacilityOptions] = useState([]);
  const [busy, setBusy] = useState(false);
  // When the backend rejects on availability (409) and the user may override,
  // we hold the reason here and offer an explicit "Assign anyway".
  const [conflict, setConflict] = useState(null);

  useEffect(() => {
    if (!open) return;
    setFacility(booking?.facility || '');
    setWorker('');
    setConflict(null);
    usersApi.list({ is_active: 'true', page_size: 100 })
      .then((d) => setStaff((d.results || d).filter((u) => u.role !== 'customer')));
    // Ask the server which units could actually take this booking's slot: it
    // filters by facility type, maintenance and overlapping bookings, so the
    // picker can never offer a choice the server would reject.
    if (booking?.id) {
      bookingsApi.freeFacilities(booking.id)
        .then((d) => setFacilityOptions(d.results || []))
        .catch(() => setFacilityOptions([]));
    } else {
      setFacilityOptions([]);
    }
  }, [open, booking]);

  // Skipping only makes sense while still pending, and only for users granted
  // the opt-in capability. (The dialog only opens for unassigned bookings.)
  const showSkip = canSkip && booking?.status === 'confirmed';

  async function submit(override = false) {
    if (!worker) return;
    setBusy(true);
    try {
      const updated = await bookingsApi.assign(
        booking.id, Number(worker), facility ? Number(facility) : null, override);
      onAssigned?.(updated);
    } catch (e) {
      const data = e?.response?.data;
      if (e?.response?.status === 409 && data?.code === 'availability') {
        if (data.overridable) {
          setConflict(data.detail);   // offer "Assign anyway"
        } else {
          setConflict(null);
          toast.error(data.detail);   // blocked, no override right
        }
      } else {
        setConflict(null);
        toast.error(apiErrorMessage(e, 'Unable to assign the worker. Please try again.'));
      }
    } finally { setBusy(false); }
  }

  async function skip() {
    setBusy(true);
    try {
      const updated = await bookingsApi.skipAssignment(booking.id);
      onSkipped?.(updated);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to skip assignment. Please try again.'));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      open={open} onClose={onClose} title="Assign staff" size="sm"
      footer={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
          {showSkip && (
            <button className="btn btn-ghost" type="button" onClick={skip} disabled={busy}>
              Skip assignment
            </button>
          )}
          {conflict ? (
            <button className="btn btn-warning" onClick={() => submit(true)} disabled={busy}>
              Assign anyway
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => submit(false)} disabled={!worker || busy}>
              Assign
            </button>
          )}
        </>
      }
    >
      <FormField label="Staff member">
        <Select2
          options={staff.map((u) => ({ value: u.id, label: `${u.full_name || u.email} (${u.role})` }))}
          value={worker}
          onChange={(v) => { setWorker(v); setConflict(null); }}
          placeholder="Choose a staff member…"
        />
      </FormField>
      {facilityOptions.length > 0 && (
        <FormField label="Facility"
          hint="Only units free for this slot are listed. Leave as is to keep the allocated one.">
          <Select2
            options={facilityOptions.map((f) => ({ value: f.id, label: f.name }))}
            value={facility}
            onChange={(v) => { setFacility(v); setConflict(null); }}
            placeholder="No specific facility"
            clearable
          />
        </FormField>
      )}
      {conflict && (
        <div
          role="alert"
          style={{
            marginTop: 12, padding: '10px 12px', borderRadius: 8,
            background: 'var(--color-warning-bg, #fff7ed)',
            border: '1px solid var(--color-warning, #f59e0b)', fontSize: 13,
          }}
        >
          <strong>Availability warning.</strong> {conflict} You can assign anyway - this
          will be recorded in the audit log.
        </div>
      )}
    </Modal>
  );
}

function KV({ icon: Icon, label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '5px 0' }}>
      {Icon && <Icon size={16} style={{ marginTop: 2, color: 'var(--color-text-muted)' }} />}
      <div style={{ flex: 1 }}>
        <div className="muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
        <div style={{ fontWeight: 500 }}>{children}</div>
      </div>
    </div>
  );
}

function PriceRow({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontWeight: strong ? 700 : 400 }}>
      <span className={strong ? '' : 'muted'}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
