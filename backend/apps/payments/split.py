"""Split payment: settling a booking, or a whole multi-slot order, with
several payments.

The rule this module exists to protect: a split never invents money. Each
booking's `total_amount` is computed once by the pricing engine (base, add-ons,
rules, promo, loyalty, membership coverage, VAT) and `booking_outstanding()`
says what is still to collect. A split only decides *who pays which slice of
that*, and every single payment re-reads the live outstanding balance before it
takes anything. Repricing the booking, a staff member collecting cash, or a
concurrent friend paying all change the answer safely, because none of them is
trusted from an earlier snapshot.

A split targets either one `Booking` or one `BookingOrder`. An order holds no
money of its own, so an order split still allocates what its BOOKINGS owe: a
share is an amount of the order, and paying it spreads that amount across the
slots in proportion to what each still owes, one payment and one invoice per
slot. That is the confirmed policy, and it is what keeps a later per-slot
refund returning what that slot's payers actually put in.

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


def _lock_bookings(split=None, *, booking=None, order=None):
    """Lock every booking a split collects for, always in the same order.

    A split covers one booking or one multi-slot order. Either way what it
    allocates is money the BOOKINGS own, so every operation works on a list.
    Rows are locked by id so concurrent split operations on overlapping orders
    always take their locks in the same sequence and cannot deadlock, then
    returned chronologically because that is the order a customer reads.
    """
    from apps.bookings.models import Booking

    if split is not None:
        booking, order = split.booking, (split.order if split.order_id else None)
    if booking is not None:
        ids = [booking.pk]
    elif order is not None:
        ids = list(order.bookings.values_list("id", flat=True))
    else:
        raise SplitError("Nothing to collect for.", code="no_target")

    rows = list(Booking.objects.select_for_update().filter(id__in=ids).order_by("id"))
    return sorted(rows, key=lambda b: (b.scheduled_date, b.scheduled_time))


def split_bookings(split):
    """The bookings a split covers, chronologically. No locking: read-only."""
    if split.booking_id:
        return [split.booking]
    return list(split.order.bookings.select_related("club", "facility_type")
                .order_by("scheduled_date", "scheduled_time"))


def collectable_bookings(bookings):
    """The slots a split may still take money for.

    A cancelled slot simply drops out of a multi-slot order rather than
    stopping the whole arrangement: the other slots are still owed.
    """
    from apps.bookings.models import BookingStatus

    live = [b for b in bookings
            if b.status not in (BookingStatus.CANCELLED, BookingStatus.NO_SHOW)]
    if not live:
        raise SplitError("This booking has been cancelled.", code="booking_cancelled")
    return live


def target_outstanding(bookings) -> Decimal:
    """What the slots of a split still owe between them."""
    from apps.bookings.services import booking_outstanding

    return sum((booking_outstanding(b) for b in bookings), Decimal("0"))


def allocate_across(bookings, amount, currency):
    """Settle whole slots with one payment, earliest first.

    Confirmed policy: a share is an amount of the ORDER, and it pays off the
    slots one at a time rather than taking a slice of each. A friend paying 100
    of a 300 order covers the first slot outright; only the slot their money
    runs out on is left part paid.

    This is what makes a multi-slot split readable. Spreading proportionally
    was also correct, but three friends settling three slots produced nine
    payments and nine invoices, left every slot "Partially paid" until the last
    person paid, and gave every slot three payers to unpick at refund time.
    Filling slots gives one payment per slot, one payer per slot, and a slot
    that confirms itself the moment its own payer has paid.

    `bookings` arrives chronologically, so which slot a payment lands on is the
    same on every run and reads the way the customer booked them.

    Returns `[(booking, amount)]`, skipping slots allocated nothing.
    """
    from apps.bookings.services import booking_outstanding

    dues = [booking_outstanding(b) for b in bookings]
    total = sum(dues, Decimal("0"))
    amount = quantize_money(Decimal(str(amount)), currency)
    if total <= 0 or amount <= 0:
        return []
    if amount >= total:
        return [(b, due) for b, due in zip(bookings, dues) if due > 0]

    allocation = []
    remaining = amount
    for booking, due in zip(bookings, dues):
        if remaining <= 0:
            break
        if due <= 0:
            continue
        part = quantize_money(min(due, remaining), currency)
        if part > 0:
            allocation.append((booking, part))
            remaining -= part
    return allocation


def _settle_across(bookings, amount, *, method, card, request, payer_label, notes):
    """Take `amount` across the slots, one payment and invoice per slot.

    Usually one of each: a share settles whole slots, so it takes a second
    payment only where a share runs out partway through a slot.

    NOTE for a real provider: with a card this performs one authorisation per
    slot touched, inside the caller's transaction, because invoices in this
    system are raised per booking and a single payment row spanning several
    bookings would have no invoice it could belong to. The demo provider is
    synchronous and side-effect free, so a rollback costs nothing. Anyone
    wiring a live gateway must move the authorisation outside the transaction
    (as the checkout path already does) or capture once and record the parts.

    Returns the list of payments taken.
    """
    from apps.bookings.services import settle_booking_payment

    allocation = allocate_across(bookings, amount, bookings[0].currency)
    if not allocation:
        # Should be unreachable: the caller has already established that the
        # amount and the outstanding balance are both above zero. Failing
        # loudly here beats an IndexError on the money path if that ever stops
        # being true.
        raise SplitError("There is nothing left to pay on this booking.",
                         code="nothing_due")

    payments = []
    for booking, part in allocation:
        payment, _invoice = settle_booking_payment(
            booking, method=method, amount=part, request=request, card=card,
            payer_label=payer_label, notes=notes)
        payments.append(payment)
    return payments


def _new_token() -> tuple[str, str]:
    """A fresh link token as (raw, digest). The raw value is returned once."""
    raw = secrets.token_urlsafe(TOKEN_BYTES)
    return raw, hash_split_token(raw)


#: Hosts that mean "nobody outside this machine can open the link". A payment
#: link is shared into a group chat, so a loopback address in it is never right
#: however the server was reached.
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1")


def site_url_configured(base: str) -> bool:
    """Is this a website address a friend on another device could actually open?"""
    base = str(base or "").strip()
    if not base:
        return False
    host = base.split("//", 1)[-1].split("/", 1)[0].split(":", 1)[0].strip().lower()
    return host not in _LOCAL_HOSTS


def _site_base() -> str:
    """The public website address every payment link is built from.

    `PUBLIC_WEBSITE_URL` defaults to localhost so a developer needs no
    configuration. On a server that default is a trap rather than a
    convenience: the links are issued, copied into a group chat and simply do
    not resolve, while the court stays held and nobody can pay for it. The
    organizer has no way to tell, because the link looks fine to them.

    So outside DEBUG an unconfigured address refuses the arrangement before
    anything is written. The checkout reports that as an ordinary split
    failure and the booking stays payable the normal way, which is a far
    better outcome than a held court and five dead links.
    """
    base = str(getattr(settings, "PUBLIC_WEBSITE_URL", "") or "").rstrip("/")
    if not settings.DEBUG and not site_url_configured(base):
        raise SplitError(
            "Split payment is unavailable: this site's public web address is "
            "not configured. Please pay for the booking in the usual way.",
            code="site_not_configured")
    return base


def share_link(raw_token: str) -> str:
    """The public URL a participant opens. Built from the configured site base."""
    return f"{_site_base()}/pay/split/{raw_token}"


def manage_link(raw_token: str) -> str:
    """The organizer's own progress/management URL."""
    return f"{_site_base()}/pay/split/manage/{raw_token}"


# --------------------------------------------------------------------------- #
# Creation
# --------------------------------------------------------------------------- #
@transaction.atomic
def create_split(target, participants, *, request=None, expires_in_minutes=None):
    """Arrange a split over the outstanding balance of a booking or an order.

    `target` is a `Booking` (one slot) or a `BookingOrder` (a multi-slot
    checkout). In both cases the money belongs to the bookings; the order is
    only the thread that ties them together.

    `participants` is an ordered list of dicts: `amount` (required), plus the
    optional `name`, `email`, `phone` and `is_organizer`. Amounts must add up to
    exactly what is still owed - the caller may have used `allocate_equal`, or
    the organizer may have typed custom figures, but either way the sum is
    checked against the backend's own outstanding balance rather than anything
    the browser reported.

    Returns `(split, links)` where `links` maps each share id to its raw token.
    Those raw values exist only in this return: after it, only digests remain.
    """
    from apps.bookings.models import BookingOrder

    # First, before a row exists: an arrangement whose links cannot resolve is
    # worse than no arrangement, because it holds the court either way.
    _site_base()

    is_order = isinstance(target, BookingOrder)
    # Lock the bookings first, and everywhere else in this module, so concurrent
    # split and payment operations always take their locks in the same order and
    # cannot deadlock against each other.
    bookings = collectable_bookings(
        _lock_bookings(order=target) if is_order else _lock_bookings(booking=target))
    currency = bookings[0].currency

    outstanding = target_outstanding(bookings)
    if outstanding <= 0:
        raise SplitError("This booking is already paid in full.", code="nothing_due")

    scope = {"order": target} if is_order else {"booking": target}
    existing = (BookingPaymentSplit.objects
                .select_for_update()
                .filter(status=SplitStatus.ACTIVE, **scope)
                .first())
    if existing is not None:
        if existing.is_expired:
            _expire(existing, request=request)
        else:
            raise SplitError(
                "This booking already has a split payment in progress.",
                code="split_exists")

    cleaned = _clean_participants(participants, currency)
    _assert_allocation_matches(cleaned, outstanding, currency)

    minutes = int(expires_in_minutes or getattr(settings, "SPLIT_PAYMENT_MINUTES", 60))
    raw_organizer, organizer_digest = _new_token()
    split = BookingPaymentSplit.objects.create(
        organizer=target.customer,
        currency=currency,
        amount_allocated=quantize_money(outstanding, currency),
        organizer_token_hash=organizer_digest,
        expires_at=timezone.now() + timedelta(minutes=minutes),
        **scope,
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
    _timeline(
        split,
        f"Split payment arranged between {len(cleaned)} people - "
        f"{format_currency(split.amount_allocated, currency)} to collect",
        event="split_created", bookings=bookings, request=request,
        meta={"shares": len(cleaned), "allocated": str(split.amount_allocated),
              "expires_at": split.expires_at.isoformat()})
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
        _timeline(
            share.split,
            f"A split payment attempt was refused - "
            f"{share.display_name}'s share is still outstanding",
            event="split_share_failed", request=request,
            meta={"share": share.id})


@transaction.atomic
def _pay_share_locked(raw_token, *, card=None, method="card", request=None):
    """The locked critical section. See `pay_share` for why it is separate."""
    from apps.bookings.services import PaymentDeclined, slot_is_available

    share = resolve_share(raw_token)
    if share is None:
        raise SplitError("This payment link is not valid.", code="invalid_link")

    # Consistent lock order: bookings, then split, then share.
    bookings = _lock_bookings(share.split)
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

    bookings = collectable_bookings(bookings)

    # Availability stays the authoritative gate right up to the money moving: if
    # a facility can no longer serve one of these slots, we must not collect for
    # it. `exclude_pk` asks the real question - is there still capacity for me,
    # not counting myself.
    for booking in bookings:
        if not slot_is_available(
                booking.scheduled_date, booking.scheduled_time, club=booking.club,
                facility_type=booking.facility_type,
                duration=booking.duration_minutes, exclude_pk=booking.pk):
            raise SplitError(
                "That slot is no longer available. Please contact the club.",
                code="slot_unavailable")

    currency = bookings[0].currency
    outstanding = target_outstanding(bookings)
    if outstanding <= 0:
        # Somebody else covered the balance first. Do not charge them.
        _settle_if_complete(split, bookings, request=request)
        raise SplitError("This payment is no longer required.", code="not_required")

    # Never more than the share was assigned, and never more than is owed. The
    # second bound is what makes a stale link harmless after the booking was
    # repriced down or partly settled elsewhere.
    amount = min(quantize_money(share.amount, currency), outstanding)

    payer = share.participant_name or ("Organizer" if share.is_organizer else "Guest")
    try:
        payments = _settle_across(
            bookings, amount, method=method, card=card, request=request,
            payer_label=payer, notes=f"Split payment share #{share.id}")
    except PaymentDeclined as exc:
        # Unwind to release the locks, then record the attempt outside.
        raise _Declined(str(exc), share_id=share.id) from exc
    # A share is one participant's commitment, so it points at the first of the
    # payments it produced. Settling whole slots means that is normally the
    # only one; a share that runs out partway through a slot produces a second,
    # tied to it by the same payer label and note, with its own invoice.
    payment = payments[0]

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
        "payments": [p.reference for p in payments], "slots": len(payments),
        "payer": payer,
    })
    settled = split.shares.filter(status=ShareStatus.PAID).count()
    total_shares = split.shares.count()
    _timeline(
        split,
        f"{payer} paid their share - {format_currency(amount, currency)} "
        f"({settled} of {total_shares} paid)",
        event="split_share_paid", bookings=bookings, request=request,
        meta={"amount": str(amount), "share": share.id, "payer": payer,
              "paid_shares": settled, "total_shares": total_shares})
    _settle_if_complete(split, bookings, request=request)
    return share, payment


def _settle_if_complete(split, bookings, *, request=None):
    """Close the arrangement once every slot it covers owes nothing.

    Driven by the outstanding balances rather than by counting paid shares, so
    an organizer who settles the remainder directly, or a staff member who
    takes the balance at the counter, closes the split just as correctly as the
    last friend paying would.
    """
    if split.status != SplitStatus.ACTIVE:
        return split
    if target_outstanding(bookings) > 0:
        return split

    # Close it with a CONDITIONAL update rather than trusting the instance.
    # One payment now reaches here twice: `settle_booking_payment` closes any
    # settled arrangement through `close_if_settled`, and the share path calls
    # this again afterwards holding an object whose in-memory status is still
    # ACTIVE. Deciding from that stale attribute wrote the completion, and its
    # Booking Log entry, a second time.
    closed_at = timezone.now()
    if not (BookingPaymentSplit.objects
            .filter(pk=split.pk, status=SplitStatus.ACTIVE)
            .update(status=SplitStatus.COMPLETED, completed_at=closed_at,
                    updated_at=closed_at)):
        split.refresh_from_db()
        return split
    split.status = SplitStatus.COMPLETED
    split.completed_at = closed_at
    # Every link that is still out there stops working now, whether or not its
    # holder ever used it.
    _revoke_open_shares(split, ShareStatus.CANCELLED)
    _audit(request, "split_completed", split,
           {"paid": str(split.paid_total)})
    _timeline(
        split,
        "Split payment complete - every slot is paid for",
        event="split_completed", bookings=bookings, request=request,
        meta={"paid": str(split.paid_total)})
    return split


def close_if_settled(booking, *, request=None):
    """Close any live arrangement over this booking once nothing is owed.

    `settle_booking_payment` is the one place any payment is recorded, and it
    knew nothing about splits. So an admin taking the remaining balance at the
    desk left the arrangement ACTIVE with every unpaid link still live: the
    friends were not double charged, because paying a share re-reads the
    balance and refuses, but they met an unexplained refusal instead of a link
    that had simply finished its job, and the customer progress page still
    showed money outstanding.

    Idempotent and silent when there is no split, which is almost every
    booking.
    """
    scope = models.Q(booking=booking)
    if booking.order_id:
        scope |= models.Q(order_id=booking.order_id)
    splits = (BookingPaymentSplit.objects
              .filter(scope, status=SplitStatus.ACTIVE)
              .select_for_update())
    for split in splits:
        _settle_if_complete(split, collectable_bookings(_lock_bookings(split)),
                            request=request)


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
    from apps.bookings.services import PaymentDeclined

    bookings = _lock_bookings(split)
    split = BookingPaymentSplit.objects.select_for_update().get(pk=split.pk)
    bookings = collectable_bookings(bookings)

    outstanding = target_outstanding(bookings)
    if outstanding <= 0:
        _settle_if_complete(split, bookings, request=request)
        raise SplitError("This booking is already paid in full.", code="nothing_due")

    try:
        payments = _settle_across(
            bookings, outstanding, method=method, card=card, request=request,
            payer_label="Organizer", notes="Split payment: remaining balance")
    except PaymentDeclined as exc:
        raise SplitError(str(exc), code="declined") from exc

    # The organizer's own unpaid share (if any) is covered by this payment, so
    # it must not stay open and payable through its link.
    _revoke_open_shares(split, ShareStatus.CANCELLED)
    _audit(request, "split_remaining_paid", split,
           {"amount": str(outstanding), "payment": payments[0].reference,
            "payments": [p.reference for p in payments]})
    _timeline(
        split,
        f"Organizer paid the remaining balance - "
        f"{format_currency(outstanding, split.currency)}",
        event="split_remaining_paid", bookings=bookings, request=request,
        meta={"amount": str(outstanding), "payment": payments[0].reference})
    _settle_if_complete(split, bookings, request=request)
    return payments[0]


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
    _timeline(
        split,
        f"{share.display_name}'s share was cancelled - "
        f"{format_currency(share.amount, split.currency)} is unallocated",
        event="split_share_cancelled", request=request,
        meta={"share": share.id, "amount": str(share.amount)})
    return share


@transaction.atomic
def add_shares(split, participants, *, request=None):
    """Allocate the currently unallocated balance to new participants.

    The check is against what the booking still owes minus what is already
    allocated to open shares, so adding people can never push the arrangement
    past the booking total no matter how the organizer got here.
    """
    bookings = _lock_bookings(split)
    split = BookingPaymentSplit.objects.select_for_update().get(pk=split.pk)
    if split.status != SplitStatus.ACTIVE:
        raise SplitError("This split payment is no longer active.", code="split_closed")
    if split.is_expired:
        _expire(split, request=request)
        raise SplitError("This split payment has expired.", code="expired")

    bookings = collectable_bookings(bookings)
    currency = bookings[0].currency
    unallocated = quantize_money(
        target_outstanding(bookings) - split.open_total, currency)
    if unallocated <= 0:
        raise SplitError("Every part of the balance is already allocated.",
                         code="nothing_unallocated")

    cleaned = _clean_participants(participants, currency)
    cap = int(getattr(settings, "SPLIT_PAYMENT_MAX_SHARES", 20))
    if split.shares.exclude(status=ShareStatus.CANCELLED).count() + len(cleaned) > cap:
        raise SplitError(f"A booking can be split between at most {cap} people.",
                         code="too_many_shares")
    _assert_allocation_matches(cleaned, unallocated, currency)

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
    _timeline(
        split,
        f"{len(created)} more people were added to the split payment",
        event="split_shares_added", bookings=bookings, request=request,
        meta={"shares": len(created)})
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
    _timeline(
        split,
        f"A new payment link was issued for {share.display_name}'s share",
        event="split_share_link_reissued", request=request,
        meta={"share": share.id})
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
    # Says what did NOT happen, because that is the part people get wrong:
    # cancelling the arrangement refunds nobody by confirmed policy.
    _timeline(
        split,
        f"Split payment cancelled - {format_currency(collected, split.currency)} "
        f"already collected stays on the booking, nothing refunded",
        event="split_cancelled", request=request,
        meta={"collected": str(collected)})
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
    _timeline(
        split,
        f"Split payment deadline passed - "
        f"{format_currency(split.paid_total, split.currency)} collected, links "
        f"closed. Nothing refunded and no slot released",
        event="split_expired", request=request,
        meta={"collected": str(split.paid_total)})
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
def _timeline(split, note, *, event, bookings=None, request=None, meta=None):
    """Put a split event on every slot's own Booking Log.

    `_audit` records these against the ORDER, which is the right home for the
    arrangement but the wrong place to look: staff open a SLOT, and its
    timeline used to say only "payment recorded" with no hint that three
    people were paying for it, who still owed, or by when.

    Written to every slot the split covers, because who has paid and how long
    is left are facts about the whole arrangement, and staff may open any one
    of the slots to ask.

    The Booking Log renders the note and `meta.amount`; everything else is
    structured detail for whoever reads the record later, so the note has to
    stand on its own.
    """
    # `_actor_or_none` rather than `request.user`: a friend paying through a
    # link is anonymous, which is not a User row and cannot go on a foreign key.
    from apps.bookings.services import _actor_or_none, record_booking_event

    actor = _actor_or_none(request)
    rows = split_bookings(split) if bookings is None else bookings
    payload = {"split": split.id, "currency": split.currency}
    if split.order_id:
        payload["order"] = split.order.reference
    if meta:
        payload.update(meta)
    for booking in rows:
        record_booking_event(booking, note, actor=actor, event=event, meta=payload)


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
        "order": split.order.reference if split.order_id else None,
        "currency": split.currency,
    }
    if extra:
        payload.update(extra)
    # A multi-slot split is about the order, so the timeline hangs off that
    # rather than off whichever slot happened to be first.
    subject = (("booking", split.booking_id) if split.booking_id
               else ("booking_order", split.order_id))
    if request is None:
        log_system_event(event, payload, subject=subject)
    else:
        log_event(request, event, payload, subject=subject)
