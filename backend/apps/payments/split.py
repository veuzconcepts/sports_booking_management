"""Split payment: settling one booking with several payments.

The rule this module exists to protect: a split never invents money. The
booking's `total_amount` is computed once by the pricing engine (base, add-ons,
rules, promo, loyalty, membership coverage, VAT) and `booking_outstanding()`
says what is still to collect. A split only decides *who pays which slice of
that*, and every single payment re-reads the live outstanding balance before it
takes anything. Repricing the booking, a staff member collecting cash, or a
concurrent friend paying all change the answer safely, because none of them is
trusted from an earlier snapshot.

Security model: a share's payment link is a bearer credential. It is generated
from `secrets`, shown to the organizer once, and stored only as a SHA-256
digest. Holding one authorises exactly two things - read the minimal booking
summary, and pay that one share's assigned amount. It grants no access to the
booking record, the organizer's details, the other participants' contact
details, or any admin API, and it is scoped through the booking, so it can never
reach another organization's data.
"""

import secrets
from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP

from django.conf import settings
from django.db import models, transaction
from django.utils import timezone

from apps.auditlogs.services import log_event, log_system_event
from apps.settings_app.currency import format_currency, money_exponent, quantize_money

from .models import (
    BookingPaymentShare,
    BookingPaymentSplit,
    OPEN_SHARE_STATUSES,
    ShareStatus,
    SplitStatus,
    hash_split_token,
)

# Raw tokens are 256 bits of randomness. Long enough that guessing is not a
# threat model, short enough to paste into a chat message.
TOKEN_BYTES = 32

# A friend may be reminded this many times, and no more often than this. The cap
# exists so the organizer cannot turn the notification system into a nuisance.
MAX_REMINDERS = 3
REMINDER_COOLDOWN_MINUTES = 10


class SplitError(Exception):
    """A split operation was refused. The message is safe to show a customer."""

    def __init__(self, message, *, code=""):
        self.code = code
        super().__init__(message)


# --------------------------------------------------------------------------- #
# Allocation
# --------------------------------------------------------------------------- #
def allocate_equal(total, people: int, currency: str) -> list[Decimal]:
    """Split `total` into `people` shares that sum back to it exactly.

    Dividing in decimal loses money: 100 / 3 is 33.33 three times, which is a
    cent short. So the division is done in whole minor units and the leftover
    units are handed to the LAST shares. SAR 100 between three becomes 33.33,
    33.33, 33.34, and the organizer sees the odd cent land somewhere honest
    rather than vanishing.
    """
    if people < 1:
        raise SplitError("Choose at least one person to split between.",
                         code="invalid_people")
    step = money_exponent(currency)
    total = Decimal(str(total))
    units = int((total / step).to_integral_value(rounding=ROUND_HALF_UP))
    if units < people:
        raise SplitError(
            "The amount is too small to split between that many people.",
            code="amount_too_small")
    base, extra = divmod(units, people)
    return [
        (Decimal(base + (1 if index >= people - extra else 0)) * step)
        for index in range(people)
    ]


def _new_token() -> tuple[str, str]:
    """A fresh link token as (raw, digest). The raw value is returned once."""
    raw = secrets.token_urlsafe(TOKEN_BYTES)
    return raw, hash_split_token(raw)


def share_link(raw_token: str) -> str:
    """The public URL a participant opens. Built from the configured site base."""
    base = str(getattr(settings, "PUBLIC_WEBSITE_URL", "") or "").rstrip("/")
    return f"{base}/pay/split/{raw_token}"


def manage_link(raw_token: str) -> str:
    """The organizer's own progress/management URL."""
    base = str(getattr(settings, "PUBLIC_WEBSITE_URL", "") or "").rstrip("/")
    return f"{base}/pay/split/manage/{raw_token}"


# --------------------------------------------------------------------------- #
# Creation
# --------------------------------------------------------------------------- #
@transaction.atomic
def create_split(booking, participants, *, request=None, expires_in_minutes=None):
    """Arrange a split over a booking's outstanding balance.

    `participants` is an ordered list of dicts: `amount` (required), plus the
    optional `name`, `email`, `phone` and `is_organizer`. Amounts must add up to
    exactly what the booking still owes - the caller may have used
    `allocate_equal`, or the organizer may have typed custom figures, but either
    way the sum is checked against the backend's own outstanding balance rather
    than anything the browser reported.

    Returns `(split, links)` where `links` maps each share id to its raw token.
    Those raw values exist only in this return: after it, only digests remain.
    """
    from apps.bookings.models import Booking
    from apps.bookings.services import booking_outstanding

    # Lock the booking first, and everywhere else in this module, so concurrent
    # split and payment operations always take their locks in the same order and
    # cannot deadlock against each other.
    booking = Booking.objects.select_for_update().get(pk=booking.pk)
    _assert_booking_collectable(booking)

    outstanding = booking_outstanding(booking)
    if outstanding <= 0:
        raise SplitError("This booking is already paid in full.", code="nothing_due")

    existing = (BookingPaymentSplit.objects
                .select_for_update()
                .filter(booking=booking, status=SplitStatus.ACTIVE)
                .first())
    if existing is not None:
        if existing.is_expired:
            _expire(existing, request=request)
        else:
            raise SplitError(
                "This booking already has a split payment in progress.",
                code="split_exists")

    cleaned = _clean_participants(participants, booking.currency)
    _assert_allocation_matches(cleaned, outstanding, booking.currency)

    minutes = int(expires_in_minutes or getattr(settings, "SPLIT_PAYMENT_MINUTES", 60))
    raw_organizer, organizer_digest = _new_token()
    split = BookingPaymentSplit.objects.create(
        booking=booking,
        organizer=booking.customer,
        currency=booking.currency,
        amount_allocated=quantize_money(outstanding, booking.currency),
        organizer_token_hash=organizer_digest,
        expires_at=timezone.now() + timedelta(minutes=minutes),
    )

    links = {"organizer": raw_organizer}
    for position, entry in enumerate(cleaned):
        raw, digest = _new_token()
        share = BookingPaymentShare.objects.create(
            split=split, position=position, amount=entry["amount"],
            participant_name=entry["name"], participant_email=entry["email"],
            participant_phone=entry["phone"], is_organizer=entry["is_organizer"],
            token_hash=digest,
        )
        links[share.id] = raw

    _audit(request, "split_created", split, {
        "shares": len(cleaned),
        "allocated": str(split.amount_allocated),
        "expires_at": split.expires_at.isoformat(),
    })
    return split, links


def _clean_participants(participants, currency):
    """Validate and normalise the requested allocation. Never trusts the input."""
    rows = list(participants or [])
    if not rows:
        raise SplitError("Add at least one person to split with.", code="no_participants")
    cap = int(getattr(settings, "SPLIT_PAYMENT_MAX_SHARES", 20))
    if len(rows) > cap:
        raise SplitError(f"A booking can be split between at most {cap} people.",
                         code="too_many_shares")
    if sum(1 for r in rows if r.get("is_organizer")) > 1:
        raise SplitError("Only one share can be yours.", code="duplicate_organizer")

    cleaned = []
    for row in rows:
        try:
            amount = quantize_money(Decimal(str(row.get("amount"))), currency)
        except (TypeError, ValueError, ArithmeticError):
            raise SplitError("Enter a valid amount for every person.",
                             code="invalid_amount")
        if amount <= 0:
            raise SplitError("Every share must be more than zero.",
                             code="invalid_amount")
        email = str(row.get("email") or "").strip()[:254]
        cleaned.append({
            "amount": amount,
            "name": str(row.get("name") or "").strip()[:120],
            "email": email,
            "phone": str(row.get("phone") or "").strip()[:32],
            "is_organizer": bool(row.get("is_organizer")),
        })
    return cleaned


def _assert_allocation_matches(cleaned, target, currency):
    """The allocation must account for the target amount exactly.

    Not "at least" and not "at most": a short allocation would leave a booking
    nobody has agreed to finish paying, and an over-allocation would invite an
    overpayment the outstanding-balance guard would then have to reject halfway
    through, after some friends had already paid.
    """
    allocated = quantize_money(sum((r["amount"] for r in cleaned), Decimal("0")), currency)
    target = quantize_money(target, currency)
    if allocated != target:
        raise SplitError(
            "The shares must add up to "
            f"{format_currency(target, currency)} (they currently add up to "
            f"{format_currency(allocated, currency)}).",
            code="allocation_mismatch")


def _assert_booking_collectable(booking):
    """Refuse to arrange or take split money on a booking that is not live."""
    from apps.bookings.models import BookingStatus

    if booking.status in (BookingStatus.CANCELLED, BookingStatus.NO_SHOW):
        raise SplitError("This booking has been cancelled.", code="booking_cancelled")


# --------------------------------------------------------------------------- #
# Reading a link
# --------------------------------------------------------------------------- #
def resolve_share(raw_token):
    """The share a payment link refers to, or None.

    Lookup is by digest, so a stolen database never yields a working link.
    """
    if not raw_token:
        return None
    return (BookingPaymentShare.objects
            .select_related("split", "split__booking", "split__booking__club",
                            "split__booking__facility_type")
            .filter(token_hash=hash_split_token(raw_token))
            .first())


def resolve_split(raw_organizer_token):
    """The split an organizer management link refers to, or None."""
    if not raw_organizer_token:
        return None
    return (BookingPaymentSplit.objects
            .select_related("booking", "booking__club", "booking__facility_type")
            .prefetch_related("shares")
            .filter(organizer_token_hash=hash_split_token(raw_organizer_token))
            .first())


# --------------------------------------------------------------------------- #
# Payment
# --------------------------------------------------------------------------- #
def pay_share(raw_token, *, card=None, method="card", request=None):
    """Settle one participant's share.

    Wrapping the whole thing in one transaction would be wrong in a way that is
    easy to miss: a declined card raises, the transaction unwinds, and the record
    that anybody ever tried to pay unwinds with it. So the guards and the charge
    run inside a transaction (which is what makes double payment and overpayment
    impossible), and a refusal is recorded afterwards, in its own transaction,
    once that one has rolled back.

    The concurrency story, which is the whole difficulty of this feature: two
    friends can hit their links in the same millisecond. Both transactions lock
    the booking row first, so they serialise; whichever gets there second
    re-reads the share status (rejecting a second payment for the same share)
    and re-reads the booking's outstanding balance (so the total collected can
    never exceed what is owed). Nothing is trusted from before the lock.
    """
    try:
        return _pay_share_locked(raw_token, card=card, method=method, request=request)
    except _Declined as exc:
        _record_declined_attempt(exc.share_id, request=request)
        raise SplitError(str(exc), code="declined") from exc


class _Declined(Exception):
    """Internal: the provider refused, and the caller must unwind first."""

    def __init__(self, message, *, share_id):
        self.share_id = share_id
        super().__init__(message)


def _record_declined_attempt(share_id, *, request=None):
    """Note the refusal after the payment transaction has rolled back.

    Runs in its own transaction, so it survives. The link is deliberately left
    intact: the payer should be able to try a different card.
    """
    with transaction.atomic():
        share = (BookingPaymentShare.objects.select_for_update()
                 .filter(pk=share_id).first())
        if share is None or share.status == ShareStatus.PAID:
            return
        share.status = ShareStatus.FAILED
        share.last_failure_code = "declined"
        share.save(update_fields=["status", "last_failure_code", "updated_at"])
        _audit(request, "split_share_failed", share.split, {"share": share.id})


@transaction.atomic
def _pay_share_locked(raw_token, *, card=None, method="card", request=None):
    """The locked critical section. See `pay_share` for why it is separate."""
    from apps.bookings.models import Booking
    from apps.bookings.services import (
        PaymentDeclined, booking_outstanding, settle_booking_payment,
        slot_is_available,
    )

    share = resolve_share(raw_token)
    if share is None:
        raise SplitError("This payment link is not valid.", code="invalid_link")

    # Consistent lock order: booking, then split, then share.
    booking = Booking.objects.select_for_update().get(pk=share.split.booking_id)
    split = BookingPaymentSplit.objects.select_for_update().get(pk=share.split_id)
    share = BookingPaymentShare.objects.select_for_update().get(pk=share.pk)
    share.split = split

    if split.status != SplitStatus.ACTIVE:
        raise SplitError("This split payment is no longer active.",
                         code="split_closed")
    if split.is_expired:
        _expire(split, request=request)
        raise SplitError("This payment link has expired.", code="expired")
    if share.status == ShareStatus.PAID:
        raise SplitError("This share has already been paid.", code="already_paid")
    if share.status not in OPEN_SHARE_STATUSES:
        raise SplitError("This payment link is no longer valid.", code="invalid_link")

    _assert_booking_collectable(booking)

    # Availability stays the authoritative gate right up to the money moving: if
    # the facility can no longer serve this booking, we must not collect for it.
    # `exclude_pk` asks the real question - is there still capacity for me, not
    # counting myself.
    if not slot_is_available(
            booking.scheduled_date, booking.scheduled_time, club=booking.club,
            facility_type=booking.facility_type, duration=booking.duration_minutes,
            exclude_pk=booking.pk):
        raise SplitError(
            "That slot is no longer available. Please contact the club.",
            code="slot_unavailable")

    outstanding = booking_outstanding(booking)
    if outstanding <= 0:
        # Somebody else covered the balance first. Do not charge them.
        _settle_if_complete(split, booking, request=request)
        raise SplitError("This payment is no longer required.", code="not_required")

    # Never more than the share was assigned, and never more than is owed. The
    # second bound is what makes a stale link harmless after the booking was
    # repriced down or partly settled elsewhere.
    amount = min(quantize_money(share.amount, booking.currency), outstanding)

    payer = share.participant_name or ("Organizer" if share.is_organizer else "Guest")
    try:
        payment, _invoice = settle_booking_payment(
            booking, method=method, amount=amount, request=request, card=card,
            payer_label=payer,
            notes=f"Split payment share #{share.id}")
    except PaymentDeclined as exc:
        # Unwind to release the locks, then record the attempt outside.
        raise _Declined(str(exc), share_id=share.id) from exc

    share.status = ShareStatus.PAID
    share.payment = payment
    share.paid_at = timezone.now()
    share.last_failure_code = ""
    # A settled share's link has done its job. Destroying the token here is what
    # makes "the share is paid" and "the link stops working" the same event.
    share.token_hash = None
    share.save(update_fields=["status", "payment", "paid_at", "last_failure_code",
                              "token_hash", "updated_at"])

    _audit(request, "split_share_paid", split, {
        "share": share.id, "amount": str(amount), "payment": payment.reference,
        "payer": payer,
    })
    _settle_if_complete(split, booking, request=request)
    return share, payment


def _settle_if_complete(split, booking, *, request=None):
    """Close the arrangement once the booking owes nothing.

    Driven by the booking's outstanding balance rather than by counting paid
    shares, so an organizer who settles the remainder directly, or a staff member
    who takes the balance at the counter, closes the split just as correctly as
    the last friend paying would.
    """
    from apps.bookings.services import booking_outstanding

    if split.status != SplitStatus.ACTIVE:
        return split
    if booking_outstanding(booking) > 0:
        return split

    split.status = SplitStatus.COMPLETED
    split.completed_at = timezone.now()
    split.save(update_fields=["status", "completed_at", "updated_at"])
    # Every link that is still out there stops working now, whether or not its
    # holder ever used it.
    _revoke_open_shares(split, ShareStatus.CANCELLED)
    _audit(request, "split_completed", split,
           {"paid": str(split.paid_total)})
    return split


def _revoke_open_shares(split, status):
    """Close every unpaid share and destroy its token."""
    split.shares.filter(status__in=OPEN_SHARE_STATUSES).update(
        status=status, token_hash=None, updated_at=timezone.now())


# --------------------------------------------------------------------------- #
# Organizer actions
# --------------------------------------------------------------------------- #
@transaction.atomic
def pay_remaining(split, *, card=None, method="card", request=None):
    """The organizer settles whatever is still owed on the booking.

    This is an ordinary payment against the booking, not a special case: it goes
    through the same settle path, is bounded by the same outstanding balance, and
    closes the split through the same completion check.
    """
    from apps.bookings.models import Booking
    from apps.bookings.services import (
        PaymentDeclined, booking_outstanding, settle_booking_payment,
    )

    booking = Booking.objects.select_for_update().get(pk=split.booking_id)
    split = BookingPaymentSplit.objects.select_for_update().get(pk=split.pk)
    _assert_booking_collectable(booking)

    outstanding = booking_outstanding(booking)
    if outstanding <= 0:
        _settle_if_complete(split, booking, request=request)
        raise SplitError("This booking is already paid in full.", code="nothing_due")

    try:
        payment, _invoice = settle_booking_payment(
            booking, method=method, amount=outstanding, request=request, card=card,
            payer_label="Organizer", notes="Split payment: remaining balance")
    except PaymentDeclined as exc:
        raise SplitError(str(exc), code="declined") from exc

    # The organizer's own unpaid share (if any) is covered by this payment, so
    # it must not stay open and payable through its link.
    _revoke_open_shares(split, ShareStatus.CANCELLED)
    _audit(request, "split_remaining_paid", split,
           {"amount": str(outstanding), "payment": payment.reference})
    _settle_if_complete(split, booking, request=request)
    return payment


@transaction.atomic
def cancel_share(split, share_id, *, request=None):
    """Drop an unpaid participant, leaving their amount unallocated.

    A paid share is never touched: the money is real and the invoice exists.
    """
    share = (BookingPaymentShare.objects.select_for_update()
             .filter(split=split, pk=share_id).first())
    if share is None:
        raise SplitError("That share was not found.", code="not_found")
    if share.status == ShareStatus.PAID:
        raise SplitError("A share that has already been paid cannot be cancelled.",
                         code="already_paid")
    share.status = ShareStatus.CANCELLED
    share.token_hash = None
    share.save(update_fields=["status", "token_hash", "updated_at"])
    _audit(request, "split_share_cancelled", split, {"share": share.id})
    return share


@transaction.atomic
def add_shares(split, participants, *, request=None):
    """Allocate the currently unallocated balance to new participants.

    The check is against what the booking still owes minus what is already
    allocated to open shares, so adding people can never push the arrangement
    past the booking total no matter how the organizer got here.
    """
    from apps.bookings.models import Booking
    from apps.bookings.services import booking_outstanding

    booking = Booking.objects.select_for_update().get(pk=split.booking_id)
    split = BookingPaymentSplit.objects.select_for_update().get(pk=split.pk)
    if split.status != SplitStatus.ACTIVE:
        raise SplitError("This split payment is no longer active.", code="split_closed")
    if split.is_expired:
        _expire(split, request=request)
        raise SplitError("This split payment has expired.", code="expired")

    unallocated = quantize_money(
        booking_outstanding(booking) - split.open_total, booking.currency)
    if unallocated <= 0:
        raise SplitError("Every part of the balance is already allocated.",
                         code="nothing_unallocated")

    cleaned = _clean_participants(participants, booking.currency)
    cap = int(getattr(settings, "SPLIT_PAYMENT_MAX_SHARES", 20))
    if split.shares.exclude(status=ShareStatus.CANCELLED).count() + len(cleaned) > cap:
        raise SplitError(f"A booking can be split between at most {cap} people.",
                         code="too_many_shares")
    _assert_allocation_matches(cleaned, unallocated, booking.currency)

    start = (split.shares.aggregate(top=models.Max("position"))["top"] or 0) + 1
    links, created = {}, []
    for offset, entry in enumerate(cleaned):
        raw, digest = _new_token()
        share = BookingPaymentShare.objects.create(
            split=split, position=start + offset, amount=entry["amount"],
            participant_name=entry["name"], participant_email=entry["email"],
            participant_phone=entry["phone"], token_hash=digest,
        )
        links[share.id] = raw
        created.append(share)
    _audit(request, "split_shares_added", split, {"shares": len(created)})
    return created, links


@transaction.atomic
def regenerate_share_token(split, share_id, *, request=None):
    """Issue a fresh link for an unpaid share, invalidating the previous one.

    This exists because raw tokens are never stored: the organizer sees a link
    once, and if they lose it before sharing there is no way to look it up. A
    rotation is the honest recovery, and it is also the safe answer when a link
    was pasted somewhere it should not have been - the old one stops working the
    moment the new one is minted.
    """
    share = (BookingPaymentShare.objects.select_for_update()
             .filter(split=split, pk=share_id).first())
    if share is None:
        raise SplitError("That share was not found.", code="not_found")
    if share.status == ShareStatus.PAID:
        raise SplitError("That share has already been paid.", code="already_paid")
    if share.status not in OPEN_SHARE_STATUSES:
        raise SplitError("That share is no longer payable.", code="not_payable")
    raw, digest = _new_token()
    share.token_hash = digest
    share.save(update_fields=["token_hash", "updated_at"])
    _audit(request, "split_share_link_reissued", split, {"share": share.id})
    return share, raw


@transaction.atomic
def cancel_split(split, *, request=None):
    """Cancel the arrangement and stop every outstanding link.

    Money that has already been collected is deliberately left alone. Refunds on
    a split booking go per payer, through the credit note flow, honouring the
    organization's approval setting; a customer-triggered cancel must not make
    that decision for them.
    """
    split = BookingPaymentSplit.objects.select_for_update().get(pk=split.pk)
    if split.status != SplitStatus.ACTIVE:
        raise SplitError("This split payment is no longer active.", code="split_closed")
    collected = split.paid_total
    split.status = SplitStatus.CANCELLED
    split.cancelled_at = timezone.now()
    split.save(update_fields=["status", "cancelled_at", "updated_at"])
    _revoke_open_shares(split, ShareStatus.CANCELLED)
    _audit(request, "split_cancelled", split, {"collected": str(collected)})
    return split


def _expire(split, *, request=None):
    """Close an arrangement whose deadline has passed.

    Deliberately has NO financial consequence, and that is the confirmed policy,
    not a placeholder (see "Split payment: confirmed financial policy" in
    CLAUDE.md). Collected money stays collected, the booking keeps its status,
    and nothing is refunded or released. The links stop working; a human decides
    the rest with the existing cancellation and credit note tools.
    """
    if split.status != SplitStatus.ACTIVE:
        return split
    split.status = SplitStatus.EXPIRED
    split.save(update_fields=["status", "updated_at"])
    _revoke_open_shares(split, ShareStatus.EXPIRED)
    _audit(request, "split_expired", split, {"collected": str(split.paid_total)})
    return split


def expire_due_splits(*, now=None):
    """Close every arrangement past its deadline. Returns how many were closed.

    Safe to run repeatedly and safe to run late: expiry is idempotent because it
    only ever acts on splits still marked active.
    """
    now = now or timezone.now()
    due = (BookingPaymentSplit.objects
           .filter(status=SplitStatus.ACTIVE, expires_at__lte=now)
           .prefetch_related("shares"))
    closed = 0
    for split in due:
        with transaction.atomic():
            locked = (BookingPaymentSplit.objects.select_for_update()
                      .filter(pk=split.pk, status=SplitStatus.ACTIVE).first())
            if locked is None:
                continue
            _expire(locked)
            closed += 1
    return closed


@transaction.atomic
def record_reminder(split, share_id):
    """Note that a participant was reminded, enforcing the rate limit.

    Returns the share. Raises when the organizer is reminding too often, which is
    the only thing standing between "helpful nudge" and "a friend being spammed".
    """
    share = (BookingPaymentShare.objects.select_for_update()
             .filter(split=split, pk=share_id).first())
    if share is None:
        raise SplitError("That share was not found.", code="not_found")
    if share.status not in OPEN_SHARE_STATUSES:
        raise SplitError("That share does not need a reminder.", code="not_pending")
    if share.reminder_count >= MAX_REMINDERS:
        raise SplitError("You have already sent the maximum number of reminders.",
                         code="reminder_limit")
    if share.last_reminder_at and (
            timezone.now() - share.last_reminder_at
            < timedelta(minutes=REMINDER_COOLDOWN_MINUTES)):
        raise SplitError(
            f"Please wait {REMINDER_COOLDOWN_MINUTES} minutes before reminding again.",
            code="reminder_cooldown")
    share.reminder_count += 1
    share.last_reminder_at = timezone.now()
    share.save(update_fields=["reminder_count", "last_reminder_at", "updated_at"])
    return share


# --------------------------------------------------------------------------- #
# Audit
# --------------------------------------------------------------------------- #
def _audit(request, event, split, extra=None):
    """Record a split event. Never includes a token, raw or hashed.

    Splits are driven from two places: a public HTTP request (a friend paying)
    and a scheduled job (expiry), which has no request at all. Each goes to the
    helper built for it, so an expiry sweep still leaves a trail instead of
    silently dropping its events.
    """
    payload = {
        "split": split.id,
        "booking": split.booking.reference if split.booking_id else None,
        "currency": split.currency,
    }
    if extra:
        payload.update(extra)
    subject = ("booking", split.booking_id)
    if request is None:
        log_system_event(event, payload, subject=subject)
    else:
        log_event(request, event, payload, subject=subject)
