import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Calendar, LayoutGrid, MapPin, User, UserX, RefreshCw, XCircle, Tag, RotateCcw, FileText, Copy, Pencil, Trash2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../components/PageHeader.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { BookingFinancePanel } from '../../components/BookingFinancePanel.jsx';
import { BookingFormModal } from './BookingFormModal.jsx';
import { PaymentSuccessModal } from '../../components/PaymentSuccessModal.jsx';
import { RefundModal } from '../../components/RefundModal.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { CompletionPaymentWizard } from '../../components/CompletionPaymentWizard.jsx';
import { SplitPaymentPanel } from './SplitPaymentPanel.jsx';
import { OrderPanel } from './OrderPanel.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';

import {
  bookingStatuses,
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
import { ActivityThumb } from './ActivityThumb.jsx';

const statusLabel = (t, v) => bookingStatuses(t).find((s) => s.value === v)?.label || v;
const PRIORITY_TONE = { normal: 'muted', urgent: 'warning', vip: 'danger' };
const PAYMENT_TONE = {
  pending: 'warning', paid: 'success', partially_paid: 'info',
  covered: 'success', no_payment_required: 'muted',
};
// Subscription coverage state on a booking (distinguishes a temporary hold from
// final consumption, so a 0 amount is never ambiguous).
const coverageState = (t) => ({
  consumed:   { tone: 'success', label: t('subscriptionConsumed') },
  held:       { tone: 'info',    label: t('subscriptionHeldReservedDeductedCompletion') },
  at_risk:    { tone: 'warning', label: t('heldSubscriptionNoLongerAvailable') },
  released:   { tone: 'muted',   label: t('subscriptionReleasedChargedSeparately') },
  eligible:   { tone: 'info',    label: t('eligibleSubscriptionAvailable') },
  chargeable: { tone: 'muted',   label: t('chargeableNoSubscriptionApplied') },
});

export default function BookingDetailPage() {
  const { t } = useTranslation('bookings');
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
  const [finance, setFinance] = useState({ invoices: [], payments: [], splits: [] });
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
  // { split, share } awaiting confirmation, then the id being issued.
  const [linkFor, setLinkFor] = useState(null);
  const [issuingShare, setIssuingShare] = useState(null);
  const [issuedLink, setIssuedLink] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // The bill wizard was opened BY a refused confirmation, so its success
  // message should say the booking is confirmed rather than merely invoiced.
  const [paymentToConfirm, setPaymentToConfirm] = useState(false);
  const seenPaidRef = useRef(new Set());
  const financeInitedRef = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    bookingsApi.get(id)
      .then(setBooking)
      .catch((e) => toast.error(apiErrorMessage(e, t('unableLoadBookingPleaseTry'))))
      .finally(() => setLoading(false));
  }, [id, t]);

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
      setFinance({ invoices, payments: data.payments || [], splits: data.splits || [] });
    } catch { /* ignore */ }
  }, [id, hasPerm]);

  useEffect(load, [load]);
  useEffect(() => { loadFinance(); }, [loadFinance]);

  /**
   * Issue a fresh payment link for one unpaid share and put it on the clipboard.
   *
   * The clipboard write can fail (an insecure origin, a browser that refuses
   * without a user gesture it recognises), and a link that exists but was not
   * copied must not be reported as copied: the old link has already stopped
   * working by then, so a silent failure would leave the share unreachable.
   * The URL is shown either way.
   */
  async function issueShareLink(target) {
    if (!target) return;
    setIssuingShare(target.share.id);
    try {
      const issued = await bookingsApi.splitShareLink(id, target.share.id);
      let copied = false;
      try {
        await navigator.clipboard.writeText(issued.url);
        copied = true;
      } catch {
        copied = false;
      }
      setLinkFor(null);
      setLinkCopied(copied);
      setIssuedLink({ ...issued, copied });
      loadFinance();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('split.issueLinkFailed')));
    } finally {
      setIssuingShare(null);
    }
  }

  /** Put the issued link on the clipboard, and say whether it worked. */
  async function copyIssuedLink() {
    if (!issuedLink?.url) return;
    try {
      await navigator.clipboard.writeText(issuedLink.url);
      setLinkCopied(true);
    } catch {
      // Some browsers refuse without a gesture they recognise, and any
      // insecure origin refuses outright. The URL is on screen either way,
      // so say so rather than claiming a copy that did not happen.
      setLinkCopied(false);
      toast.error(t('split.copyFailed'));
    }
  }

  async function doTransition(status) {
    setBusy(true);
    try {
      const updated = await bookingsApi.transition(id, status);
      setBooking(updated);
      toast.success(`Moved to ${statusLabel(t, status)}`);
      loadFinance();   // completion may auto-raise an invoice/receipt → pops the success modal
    } catch (e) {
      // A website checkout that chose to pay online is still refused, because
      // the same predicate decides whether the slot sweep may release it. But
      // the answer is to TAKE the payment, so offer that rather than leaving
      // staff at a dead end with a message and nothing to click. Paying in
      // full confirms the booking on its own, through `confirm_if_settled`.
      if (e?.response?.data?.code === 'payment_required') {
        setPaymentToConfirm(true);
        setBillOpen(true);
        return;
      }
      toast.error(apiErrorMessage(e, t('unableUpdateBookingStatusPlease')));
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
    const note = await prompt({ title: t('cancelBooking'), label: t('reasonCancellation'), multiline: true });
    if (note === null) return;
    setBusy(true);
    try {
      const updated = await bookingsApi.cancel(id, note);
      setBooking(updated);
      toast.success(t('bookingCancelled'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableCancelBookingPleaseTry')));
    } finally {
      setBusy(false);
    }
  }

  async function doNoShow() {
    const note = await prompt({ title: t('markNoShow'), label: t('noteOptional'), multiline: true });
    if (note === null) return;
    setBusy(true);
    try {
      const updated = await bookingsApi.noShow(id, note);
      setBooking(updated);
      toast.success(t('markedAsNoShow'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableMarkBookingAsNo')));
    } finally {
      setBusy(false);
    }
  }

  async function doApplyPromo() {
    setBusy(true);
    try {
      const updated = await bookingsApi.applyPromo(id, promoInput.trim());
      setBooking(updated); setPromoInput('');
      toast.success(t('promoApplied'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableApplyPromoCodePlease')));
    } finally { setBusy(false); }
  }

  async function doRedeemSubscription() {
    setBusy(true);
    try {
      const updated = await bookingsApi.redeemSubscription(id);
      setBooking(updated);
      toast.success(t('subscriptionRedeemedCoverageAppliedBooking'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableRedeemSubscriptionPleaseTry')));
    } finally { setBusy(false); }
  }

  async function doUnapplySubscription() {
    const reason = await prompt({ title: t('unapplySubscription2'),
      label: t('reasonOptional'), multiline: true });
    if (reason === null) return;   // dismissed
    setBusy(true);
    try {
      const updated = await bookingsApi.unapplySubscription(id, reason || '');
      setBooking(updated);
      toast.success(t('subscriptionUnappliedBookingNowChargeable'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableUnapplySubscriptionPleaseTry')));
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
    } catch (e) { toast.error(apiErrorMessage(e, t('unableDownloadDocumentPleaseTry'))); }
  }
  const downloadInvoice = (inv) => downloadDoc(() => invoicesApi.download(inv.id), inv.number);

  async function doCancelInvoice(inv) {
    const reason = await prompt({ title: t('cancelInvoice'), label: t('reasonOptional'), defaultValue: '' });
    if (reason === null) return;            // dialog dismissed
    setBusy(true);
    try {
      await invoicesApi.cancel(inv.id, reason);
      toast.success(t('invoiceCancelled'));
      loadFinance();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableCancelInvoicePleaseTry')));
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
      toast.error(apiErrorMessage(e, t('unableRequestRefundPleaseTry')));
    } finally { setBusy(false); }
  }

  async function doRemovePromo() {
    setBusy(true);
    try {
      const updated = await bookingsApi.removePromo(id);
      setBooking(updated);
      toast.success(t('promoRemoved'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableRemovePromoCodePlease')));
    } finally { setBusy(false); }
  }

  async function doReopen() {
    const isNoShow = booking.status === 'no_show';
    const note = await prompt({
      title: isNoShow ? t('resetNoShow') : t('reopenBooking'),
      label: isNoShow
        ? t('reasonOptionalRestoresBookingIts')
        : t('reasonOptional'),
      multiline: true,
    });
    if (note === null) return;
    setBusy(true);
    try {
      const updated = await bookingsApi.reopen(id, note);
      setBooking(updated);
      toast.success(isNoShow
        ? t('noShowResetBookingRestored')
        : t('bookingReopenedSuccessfully'));
    } catch (e) {
      toast.error(apiErrorMessage(e, isNoShow
        ? t('unableResetNoShowPlease')
        : t('unableReopenBookingPleaseTry')));
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
    if (!deleteReason) { toast.error(t('selectReasonDeletingBooking')); return; }
    if (deleteReason.toLowerCase() === 'other' && !deleteNote.trim()) {
      toast.error(t('describeReasonWhenChoosingOther')); return;
    }
    setBusy(true);
    try {
      await bookingsApi.remove(id, { reason: deleteReason, reason_note: deleteNote.trim() });
      toast.success(t('bookingDeletedSuccessfully'));
      navigate('/bookings');
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableDeleteBookingPleaseTry')));
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
        <ArrowLeft size={15} /> {t('backBookings')}
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
                <Pencil size={15} /> {t('common:actions.edit')}
              </button>
            )}
            {hasPerm('bookings.duplicate') && (
              <button className="btn btn-secondary btn-sm" disabled={busy}
                onClick={() => setDup(bookingDuplicateInitial(booking))}>
                <Copy size={15} /> {t('common:actions.duplicate')}
              </button>
            )}
            {hasPerm('bookings.delete') && booking.can_delete && (
              <button className="btn btn-secondary btn-sm" disabled={busy}
                onClick={openDelete} style={{ color: 'var(--color-danger, #dc2626)' }}>
                <Trash2 size={15} /> {t('common:actions.delete')}
              </button>
            )}
            {canReopen && (
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={doReopen}>
                <RotateCcw size={15} /> {booking.status === 'no_show' ? t('resetNoShow') : t('reopen')}
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
            <strong>{t('existingCustomerUpdatedTheirInformation')}</strong> while placing this booking -
            review the customer’s details to confirm the change.
          </span>
        </div>
      )}

      <div className="row">
        {/* --- Summary --- */}
        <div className="col" style={{ flex: '1 1 340px' }}>
          <div className="card">
            <div className="card-header"><h3 className="card-title">{t('details')}</h3></div>
            <div className="card-body">
              <KV icon={User} label={t('common:labels.customer')}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {booking.customer_label}{booking.booking_type === 'walk_in' ? ' · Walk-in' : ''}
                  {booking.customer != null && (
                    booking.customer_was_new
                      ? <StatusBadge tone="info" label={t('newCustomer')} />
                      : <StatusBadge tone="muted" label={t('existingCustomer')} />
                  )}
                  {booking.customer_verified === true && <StatusBadge tone="success" label={t('verified')} />}
                  {booking.customer_verified === false && <StatusBadge tone="warning" label={t('unverified')} />}
                </span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {booking.customer_email || booking.walk_in_email || booking.walk_in_phone || ''}
                </div>
              </KV>
              <KV icon={LayoutGrid} label={t('common:labels.facility')}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <ActivityThumb
                    src={booking.facility_type_image}
                    name={booking.facility_type_name || booking.facility_category_name}
                    size={30}
                  />
                  <span style={{ minWidth: 0 }}>
                    {booking.facility_type_name || booking.facility_category_name || '-'}
                  </span>
                </span>
              </KV>
              <KV icon={Calendar} label={t('scheduled')}>
                {formatDate(booking.scheduled_date)} at {formatTime(booking.scheduled_time)}
                <div className="muted" style={{ fontSize: 12 }}>{booking.duration_minutes} min</div>
              </KV>
              <KV icon={MapPin} label={t('clubFacility')}>
                {booking.club_name || '-'}
                {booking.facility_name ? ` · ${booking.facility_name}` : ''}
              </KV>
              <KV icon={User} label={t('assigned')}>{booking.assigned_to_name || <span className="muted">{t('common:state.unassigned')}</span>}</KV>
              <KV label={t('priority')}>
                <StatusBadge tone={PRIORITY_TONE[booking.priority] || 'muted'} label={booking.priority} />
                {booking.booking_type ? <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{booking.booking_type === 'walk_in' ? t('walk') : t('advance')}</span> : null}
              </KV>
              <KV label={t('payment')}>
                <StatusBadge tone={PAYMENT_TONE[booking.payment_status] || 'muted'} label={(booking.payment_status || '').replace('_', ' ')} />
                {booking.payment_method ? <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{booking.payment_method.replace('_', ' ')}</span> : null}
              </KV>
              <KV label={t('source')}>{booking.source_display || (booking.source ? booking.source.replace('_', ' ') : '-')}</KV>
              {booking.add_on_names?.length > 0 && (
                <KV label={t('addOns')}>{booking.add_on_names.join(', ')}</KV>
              )}
              {booking.customer_notes && <KV label={t('customerNotes')}>{booking.customer_notes}</KV>}
              {booking.internal_notes && <KV label={t('internalNotes')}>{booking.internal_notes}</KV>}
              {booking.special_instructions && <KV label={t('specialInstructions')}>{booking.special_instructions}</KV>}
              <KV label={t('created')}>
                {booking.created_by_name || '-'}
                {booking.updated_by_name ? <div className="muted" style={{ fontSize: 12 }}>Last updated by {booking.updated_by_name}</div> : null}
              </KV>
            </div>
          </div>

          {booking.order_summary?.slot_count > 1 && (
            <>
              <div style={{ height: 16 }} />
              <OrderPanel order={booking.order_summary} orderId={booking.order} />
            </>
          )}

          <div style={{ height: 16 }} />

          <div className="card">
            <div className="card-header"><h3 className="card-title">{t('pricing')}</h3></div>
            <div className="card-body">
              {/* Clear subscription state - never confuse a temporary hold with final use. */}
              {booking.coverage_state && coverageState(t)[booking.coverage_state] && (
                <div style={{ marginBottom: 8 }}>
                  <StatusBadge tone={coverageState(t)[booking.coverage_state].tone}
                    label={coverageState(t)[booking.coverage_state].label} />
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
                  <strong>{t('eligibleSubscriptionAvailableBooking')}</strong>{' '}
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
                        {t('redeemSubscription')}
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
                  <strong>{t('coveredMembership')}</strong>{' '}
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
                    {t('covered')} <Money amount={booking.coverage_snapshot.covered_amount} code={booking.coverage_snapshot.currency} />
                    {' · '}Payable <Money amount={booking.coverage_snapshot.payable_amount} code={booking.coverage_snapshot.currency} />
                    {' · '}Usage deducted on completion
                  </div>
                  {hasPerm('bookings.unapply_subscription') && !booking.subscription_opt_out
                    && !['completed', 'closed', 'cancelled', 'no_show'].includes(booking.status)
                    && !['paid', 'partially_paid'].includes(booking.payment_status) && (
                    <div style={{ marginTop: 8 }}>
                      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={doUnapplySubscription}>
                        {t('unapplySubscription')}
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
                  <strong>{t('coveredMembership')}</strong> ({booking.membership_coverage.membership_number} - {booking.membership_coverage.plan_name}):{' '}
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
                  <PriceRow label={t('subtotalExclVat')}
                    value={<Money amount={(Number(booking.total_amount) - Number(booking.tax_amount)).toFixed(2)} code={booking.currency} />} />
                  <PriceRow label="VAT" value={<Money amount={booking.tax_amount} code={booking.currency} />} />
                </>
              ) : (
                <>
                  <PriceRow label={t('service')} value={<Money amount={booking.base_amount} code={booking.currency} />} />
                  {Number(booking.addons_amount) > 0 && (
                    <PriceRow label={t('addOns')} value={<Money amount={booking.addons_amount} code={booking.currency} />} />
                  )}
                  {Number(booking.surcharge_amount) > 0 && (
                    <PriceRow label={t('surcharges')} value={<>+ <Money amount={booking.surcharge_amount} code={booking.currency} /></>} />
                  )}
                  {Number(booking.discount_amount) > 0 && (
                    <PriceRow label={t('discounts')} value={<>- <Money amount={booking.discount_amount} code={booking.currency} /></>} />
                  )}
                  <PriceRow label={booking.tax_inclusive ? t('vatIncluded') : t('vat')} value={<Money amount={booking.tax_amount} code={booking.currency} />} />
                </>
              )}

              {booking.applied_rules?.length > 0 && (
                <div style={{ margin: '6px 0 2px' }}>
                  <div className="muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
                    {t('appliedRules')}
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
              <PriceRow label={t('common:labels.total')} value={<Money amount={booking.total_amount} code={booking.currency} />} strong />
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
                  {/* Who actually paid. Only rendered when the customer split
                      the booking, so an ordinary booking reads exactly as before. */}
                  <SplitPaymentPanel
                    splits={finance.splits}
                    currency={booking.currency}
                    issuingShare={issuingShare}
                    onIssueLink={hasPerm('payments.add')
                      ? (split, share) => setLinkFor({ split, share })
                      : undefined}
                  />
                </div>
              )}

              {!terminal && !priceLocked && hasPerm('promotions.view') && (
                <div style={{ marginTop: 12 }}>
                  {booking.promo_code ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                      <Tag size={14} /> {t('promo')} <strong>{booking.promo_code_label}</strong> applied
                      <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', color: 'var(--color-danger,#dc2626)' }}
                        disabled={busy} onClick={doRemovePromo}>{t('common:actions.remove')}</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input className="form-input" value={promoInput} onChange={(e) => setPromoInput(e.target.value)}
                        placeholder={t('promoCode')} style={{ flex: 1, textTransform: 'uppercase' }} />
                      <button className="btn btn-secondary" disabled={busy || !promoInput.trim()} onClick={doApplyPromo}>{t('common:actions.apply')}</button>
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
              {/* The money, beside the buttons that act on it. Reception
                  deciding whether to confirm, assign or cancel needs to know
                  what has been paid, and that lived three cards further down
                  in the Details column. The outstanding figure comes with it
                  where there is one, because "partially paid" on its own does
                  not say how much to ask for. */}
              <div className="card-header" style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              }}>
                <h3 className="card-title" style={{ margin: 0 }}>{t('actionsHeading')}</h3>
                <span style={{
                  marginInlineStart: 'auto', display: 'inline-flex',
                  alignItems: 'center', gap: 8, flexWrap: 'wrap',
                }}>
                  <StatusBadge status={booking.payment_status} />
                  {Number(booking.outstanding) > 0 && (
                    <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                      {t('outstandingAmount')}{' '}
                      <strong><Money amount={booking.outstanding} code={booking.currency} /></strong>
                    </span>
                  )}
                </span>
              </div>
              <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {/* Assigned goes through the Assign dialog; Completed goes through
                    the Completion & Payment wizard - neither is a raw status jump,
                    so assignment can't be bypassed and completion requires payment. */}
                {nextStatuses.filter((s) => s !== 'assigned' && s !== 'completed').map((s) => (
                  <button key={s} className="btn btn-primary" disabled={busy} onClick={() => doTransition(s)}>
                    {statusLabel(t, s)}
                  </button>
                ))}
                {nextStatuses.includes('completed') && hasPerm('bookings.edit') && (
                  <button className="btn btn-primary" disabled={busy} onClick={() => setCompleteOpen(true)}>
                    <FileText size={15} /> {t('completeAndPay')}
                  </button>
                )}
                {/* Assign belongs to the assignment stage only (after Confirmed):
                    assign a worker (dialog) or, if one is already set, just move
                    to Assigned. Once assigned, this disappears - progress with the
                    status buttons and change the operator via Edit. */}
                {booking.status === 'confirmed'
                  && (hasPerm('bookings.assign') || hasPerm('bookings.skip_assignment')) && (
                  <button className="btn btn-primary" disabled={busy} onClick={handleAssignClick}>
                    <User size={15} /> {booking.assigned_to ? t('moveAssigned') : t('common:actions.assign')}
                  </button>
                )}
                {booking.recurrence !== 'none' && (
                  <button className="btn btn-ghost" disabled={busy} onClick={async () => {
                    const n = Number(await prompt({ title: t('generateRecurrences'), label: t('howManyFutureOccurrences'), type: 'number', defaultValue: '4' }));
                    if (!n) return;
                    await bookingsApi.generateRecurrences(id, n);
                    toast.success(`${n} recurrences generated`);
                  }}><RefreshCw size={15} /> {t('generateRecurrences')}</button>
                )}
                {canNoShow && (
                  <button className="btn btn-ghost" disabled={busy} onClick={doNoShow} style={{ color: 'var(--color-warning, #b45309)' }}>
                    <UserX size={15} /> {t('markNoShow')}
                  </button>
                )}
                <button className="btn btn-ghost" disabled={busy} onClick={doCancel} style={{ color: 'var(--color-danger, #dc2626)' }}>
                  <XCircle size={15} /> {t('common:actions.cancel')}
                </button>
              </div>
            </div>
          )}

          <div style={{ height: isStaff && !terminal ? 16 : 0 }} />

          <div className="card">
            <div className="card-header"><h3 className="card-title">{t('bookingLog')}</h3></div>
            <div className="card-body">
              {(booking.status_history || []).length === 0 ? (
                <p className="muted">{t('noActivityYetBookingFreshly')}</p>
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
                              ? (h.note || statusLabel(t, h.to_status))
                              : <>{h.from_status ? `${statusLabel(t, h.from_status)} → ` : ''}{statusLabel(t, h.to_status)}</>}
                          </div>
                          {meta.covered_amount != null && (
                            <div className="muted" style={{ fontSize: 12 }}>
                              {t('covered')} <Money amount={meta.covered_amount} code={meta.currency} />
                              {meta.payable_amount != null && <> · Payable <Money amount={meta.payable_amount} code={meta.currency} /></>}
                            </div>
                          )}
                          {meta.amount != null && (
                            <div className="muted" style={{ fontSize: 12 }}>
                              {t('common:labels.amount')} <Money amount={meta.amount} code={meta.currency} />
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
        onAssigned={(updated) => { setBooking(updated); setAssignOpen(false); toast.success(t('workerAssignedSuccessfully')); }}
        onSkipped={(updated) => { setBooking(updated); setAssignOpen(false); toast.success(t('assignmentSkippedBookingMovedAssigned')); }}
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
        onSaved={(b) => { setDup(null); toast.success(t('bookingDuplicated')); if (b?.id) navigate(`/bookings/${b.id}`); }}
      />

      <BookingFormModal
        open={editOpen}
        editId={booking.id}
        initial={editOpen ? bookingEditInitial(booking) : null}
        lockedExceptNotes={booking.status === 'closed'}
        onClose={() => setEditOpen(false)}
        onSaved={(b) => { setEditOpen(false); setBooking(b); toast.success(t('bookingUpdatedSuccessfully')); }}
      />

      <Modal
        open={confirmDelete}
        onClose={() => { if (!busy) setConfirmDelete(false); }}
        title={t('deleteBooking')}
        size="sm"
        footer={
          <>
            <button className="btn btn-secondary" type="button" disabled={busy}
              onClick={() => setConfirmDelete(false)}>{t('common:actions.cancel')}</button>
            <button className="btn btn-danger" type="button" disabled={busy || !deleteReason}
              onClick={doDelete}>{busy ? t('common:state.deleting') : t('deleteBooking')}</button>
          </>
        }
      >
        <p style={{ marginTop: 0, fontSize: 13.5 }}>
          {t('permanentlyDeleteBooking')} <strong>{booking.reference}</strong> and its history.
          This cannot be undone. A reason is required for the audit trail.
        </p>
        <FormField label={t('reason')}>
          <Select2
            options={deleteReasons.map((r) => ({ value: r, label: r }))}
            value={deleteReason}
            onChange={setDeleteReason}
            placeholder={t('selectReason')}
          />
        </FormField>
        <FormField label={`Note${deleteReason.toLowerCase() === 'other' ? ' *' : ' (optional)'}`}>
          <textarea className="form-textarea" rows={3} value={deleteNote}
            onChange={(e) => setDeleteNote(e.target.value)}
            placeholder={t('addAnyDetailRecord')} />
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
          toast.success(t('bookingCompletedSuccessfully'));
          loadFinance();   // refreshes the panel and pops the invoice/receipt success modal
        }}
      />

      {/* Manual "Generate Invoice" - confirm first (booking not yet completed),
          then the same Invoice & Receipt wizard captures payment up front. */}
      {/* Shown once. The raw token is never stored, so this is the only moment
          anybody can read it; closing without copying means issuing another. */}
      <Modal
        open={Boolean(issuedLink)}
        onClose={() => setIssuedLink(null)}
        title={t('split.issuedLinkTitle')}
        size="sm"
        footer={
          <>
            {/* An explicit button, not only the automatic copy. The automatic
                one fails silently on an insecure origin and in browsers that
                want a gesture they recognise, and a link that exists but was
                never copied is a link nobody can send: the old one has already
                stopped working by then. */}
            <button className="btn btn-secondary" type="button"
              onClick={() => copyIssuedLink()}>
              {linkCopied ? t('split.linkCopied') : t('split.copyLink')}
            </button>
            <button className="btn btn-primary" type="button"
              onClick={() => setIssuedLink(null)}>{t('common:actions.close')}</button>
          </>
        }
      >
        <p style={{ marginTop: 0, fontSize: 13.5 }}>
          {issuedLink?.copied
            ? t('split.issuedLinkCopied', { name: issuedLink?.name })
            : t('split.issuedLinkNotCopied', { name: issuedLink?.name })}
        </p>
        <p style={{
          fontSize: 12.5, wordBreak: 'break-all', margin: 0, padding: '10px 12px',
          borderRadius: 8, background: 'var(--color-surface-2)',
          fontFamily: 'var(--font-mono, monospace)',
        }}>
          {issuedLink?.url}
        </p>
        {/* How long it is good for. A link with no stated deadline is one
            somebody sends on tomorrow. Reissuing does not extend it: the
            arrangement runs out, not the token. */}
        {issuedLink?.expires_at && (
          <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
            {t('split.linkExpires', { when: formatDateTime(issuedLink.expires_at) })}
          </p>
        )}
      </Modal>

      {/* Issuing a link invalidates the one the customer already has, which is
          the point when a link has leaked and a trap when reception is only
          being helpful. So it is said out loud before it happens. */}
      <ConfirmDialog
        open={Boolean(linkFor)}
        title={t('split.issueLinkTitle')}
        message={t('split.issueLinkWarning', {
          name: linkFor?.share?.is_organizer
            ? t('split.organizer')
            : (linkFor?.share?.name || t('split.guest')),
        })}
        confirmLabel={t('split.issueLink')}
        busy={Boolean(issuingShare)}
        onConfirm={() => issueShareLink(linkFor)}
        onClose={() => { if (!issuingShare) setLinkFor(null); }}
      />
      <ConfirmDialog
        open={confirmGenerate}
        title={t('generateInvoiceNow')}
        message={t('serviceBookingHasNotYet')}
        confirmLabel={t('yesGenerate')}
        busy={busy}
        onConfirm={() => { setConfirmGenerate(false); setBillOpen(true); }}
        onClose={() => setConfirmGenerate(false)}
      />
      <CompletionPaymentWizard
        open={billOpen}
        mode="bill"
        booking={booking}
        onClose={() => { setBillOpen(false); setPaymentToConfirm(false); }}
        onChanged={(updated) => setBooking(updated)}   /* redeem/unapply: live sync, keep open */
        onCompleted={(updated) => {
          onBilled(updated);
          if (paymentToConfirm) {
            setPaymentToConfirm(false);
            toast.success(t('confirmedOnPayment'));
          }
        }}
      />
    </>
  );
}

// Salesforce-style "Path": a horizontal chevron progress bar of the booking
// lifecycle. Purely presentational - reflects the current status, no actions.
const PATH_VALUES = ['booked', 'confirmed', 'assigned', 'arrived',
  'in_progress', 'completed', 'closed'];
const pathFlow = (t) => PATH_VALUES.map((value) => ({
  value, label: t(`status.${value}`),
}));
// The two terminal outcomes that sit outside the normal flow.
const pathNegative = (t) => ({
  cancelled: t('status.cancelled'),
  no_show: t('status.no_show'),
});

function BookingStatusPath({ status }) {
  const { t } = useTranslation('bookings');
  const negativeLabel = pathNegative(t)[status];
  const currentIndex = pathFlow(t).findIndex((s) => s.value === status);
  // For a cancelled / no-show booking the normal flow is greyed and a red
  // terminal chevron is appended to make the closed-negative outcome obvious.
  const steps = negativeLabel
    ? [...pathFlow(t).map((s) => ({ ...s, state: 'muted' })),
       { value: status, label: negativeLabel, state: 'negative' }]
    : pathFlow(t).map((s, i) => ({
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
  const { t } = useTranslation('bookings');
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
        toast.error(apiErrorMessage(e, t('unableAssignWorkerPleaseTry')));
      }
    } finally { setBusy(false); }
  }

  async function skip() {
    setBusy(true);
    try {
      const updated = await bookingsApi.skipAssignment(booking.id);
      onSkipped?.(updated);
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableSkipAssignmentPleaseTry')));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      open={open} onClose={onClose} title={t('assignStaff')} size="sm"
      footer={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>{t('common:actions.cancel')}</button>
          {showSkip && (
            <button className="btn btn-ghost" type="button" onClick={skip} disabled={busy}>
              {t('skipAssignment')}
            </button>
          )}
          {conflict ? (
            <button className="btn btn-warning" onClick={() => submit(true)} disabled={busy}>
              {t('assignAnyway')}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => submit(false)} disabled={!worker || busy}>
              {t('common:actions.assign')}
            </button>
          )}
        </>
      }
    >
      <FormField label={t('staffMember')}>
        <Select2
          options={staff.map((u) => ({ value: u.id, label: `${u.full_name || u.email} (${u.role})` }))}
          value={worker}
          onChange={(v) => { setWorker(v); setConflict(null); }}
          placeholder={t('chooseStaffMember')}
        />
      </FormField>
      {facilityOptions.length > 0 && (
        <FormField label={t('common:labels.facility')}
          hint={t('onlyUnitsFreeSlotListed')}>
          <Select2
            options={facilityOptions.map((f) => ({ value: f.id, label: f.name }))}
            value={facility}
            onChange={(v) => { setFacility(v); setConflict(null); }}
            placeholder={t('noSpecificFacility')}
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
          <strong>{t('availabilityWarning')}</strong> {conflict} You can assign anyway - this
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
