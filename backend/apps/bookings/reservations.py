"""Reservation holds: claiming courts while the customer pays.

A booking is Confirmed only once it has been paid for, so something has to
keep the court in between. That used to be the booking row itself, created
unpaid and blocking its slot with no deadline. This module owns that job
instead, with a clock on it.

Three rules shape everything here:

* **Acquisition is one step.** "Which courts are free?" followed by "take
  them" is a race unless nothing else can run between the two. The club/day
  advisory lock in `services._lock_club_day` is what closes that window, and
  it is the same lock booking allocation takes, so a hold and a booking
  cannot both be handed the same court.

* **A hold is all or nothing.** Somebody picking three evening slots wants
  three or none. Reserving two of them and reporting failure would leave a
  court locked for a booking that is not going to happen.

* **The deadline is read, never assumed.** The sweep runs every few minutes,
  so rows sit ACTIVE past their expiry between ticks. Every read here asks
  the clock as well as the status, which is what stops an expired hold
  blocking a court or being paid for.
"""

import secrets
from datetime import datetime, timedelta

from django.db import transaction
from django.utils import timezone

from apps.settings_app.schedule import hold_minutes_for, resolve_booking_policy

from .models import (
    BookingHold, BookingHoldSlot, BookingSource, HoldStatus, PaymentStatus,
)
from .services import _lock_club_day, free_facilities

#: 256 bits of randomness, like a split payment link. Long enough that
#: guessing is not a threat model.
TOKEN_BYTES = 32


class SlotUnavailable(Exception):
    """A requested slot could not be claimed. The message is safe to show.

    Carries the offending slots so the customer can change one time rather
    than start their selection again.
    """

    def __init__(self, message, *, slots=None, code="slot_unavailable"):
        self.slots = slots or []
        self.code = code
        super().__init__(message)


class HoldExpired(Exception):
    """The reservation is gone. Nothing may be paid against it."""

    def __init__(self, message="Your reservation has expired.", code="hold_expired"):
        self.code = code
        super().__init__(message)


def _new_token() -> tuple[str, str]:
    from apps.payments.models import hash_split_token

    raw = secrets.token_urlsafe(TOKEN_BYTES)
    return raw, hash_split_token(raw)


def _slot_end(on_date, at_time, duration_minutes):
    return (datetime.combine(on_date, at_time)
            + timedelta(minutes=duration_minutes)).time()


@transaction.atomic
def acquire(*, club, facility_type, slots, customer=None, created_by=None,
            source=BookingSource.WEBSITE, duration_minutes=None):
    """Claim every requested slot, or none of them.

    `slots` is an iterable of `(date, time)` pairs. Returns
    `(hold, raw_token)`; the raw token exists only in this return, exactly as
    a split payment link does, and is what lets a refresh or a second tab find
    this reservation again.

    Raises `SlotUnavailable` naming the slots that could not be taken.
    """
    slots = sorted(set(slots))
    if not slots:
        raise SlotUnavailable("Choose a time to continue.", code="no_slots")

    duration = (duration_minutes
                or getattr(facility_type, "duration_minutes", None) or 60)

    # One lock per club/day, taken in date order so two multi-date holds can
    # never take the same two locks in opposite orders and deadlock.
    for on_date in sorted({on_date for on_date, _ in slots}):
        _lock_club_day(club.id, on_date)

    # Inside the lock nothing else can claim these courts, so choosing and
    # writing are one step as far as any other request is concerned.
    chosen, unavailable = {}, []
    for on_date, at_time in slots:
        free = free_facilities(on_date, at_time, duration=duration, club=club,
                               facility_type=facility_type)
        # A court already picked for an earlier slot in THIS hold is still
        # free as far as the database knows, but taking it twice for
        # overlapping times would double-book us against ourselves.
        end = _slot_end(on_date, at_time, duration)
        taken_here = {
            fid for (fid, other_date, other_start, other_end) in chosen.values()
            if other_date == on_date and other_start < end and at_time < other_end
        }
        pick = next((f for f in free if f.id not in taken_here), None)
        if pick is None:
            unavailable.append({"date": on_date.isoformat(),
                                "time": at_time.strftime("%H:%M")})
            continue
        chosen[(on_date, at_time)] = (pick.id, on_date, at_time, end)

    if unavailable:
        times = ", ".join(entry["time"] for entry in unavailable)
        raise SlotUnavailable(
            f"{times} is no longer available. Please choose another slot."
            if len(unavailable) == 1
            else f"{times} are no longer available. Please choose another slot.",
            slots=unavailable)

    minutes = hold_minutes_for(PaymentStatus.PENDING, club)
    ceiling = resolve_booking_policy(club)["hold_max_minutes"]
    now = timezone.now()
    raw, digest = _new_token()
    hold = BookingHold.objects.create(
        token_hash=digest, customer=customer, club=club,
        facility_type=facility_type, source=source, created_by=created_by,
        expires_at=now + timedelta(minutes=minutes),
        max_expires_at=now + timedelta(minutes=ceiling),
    )
    BookingHoldSlot.objects.bulk_create([
        BookingHoldSlot(hold=hold, facility_id=facility_id,
                        scheduled_date=on_date, scheduled_time=at_time,
                        end_time=end)
        for facility_id, on_date, at_time, end in chosen.values()
    ])
    _invalidate(hold)
    return hold, raw


def resolve(raw_token):
    """The reservation a token refers to, or None.

    Returns the row whatever its state, so a caller can tell "expired" from
    "never existed" and say so. Use `is_live` before letting anything be paid.
    """
    from apps.payments.models import hash_split_token

    if not str(raw_token or "").strip():
        return None
    return (BookingHold.objects
            .filter(token_hash=hash_split_token(raw_token))
            .select_related("club", "facility_type", "customer")
            .prefetch_related("slots")
            .first())


def held_slots(hold):
    """The `(date, time)` pairs this reservation is holding."""
    return {(slot.scheduled_date, slot.scheduled_time) for slot in hold.slots.all()}


def covers(hold, slots) -> bool:
    """Does this reservation actually hold every slot being booked?

    Converting a reservation means "this became that booking", so the two have
    to be about the same courts. Without the check, a token for 7pm could be
    spent on an 8pm booking: the 8pm slot was never reserved, and converting
    would quietly give away the 7pm court the customer had paid attention to.

    A superset is allowed, because a customer who reserved three slots and
    completes two of them has still used the reservation.
    """
    return set(slots) <= held_slots(hold)


def require_live(raw_token):
    """The reservation, or `HoldExpired`.

    The synchronous half of expiry. A sweep every few minutes is not a
    guarantee, so anything about to take money asks here and gets the answer
    from the clock rather than from whether a job has run.
    """
    hold = resolve(raw_token)
    if hold is None:
        raise HoldExpired("This reservation is not valid.", code="invalid_hold")
    if hold.status == HoldStatus.ACTIVE and hold.expires_at <= timezone.now():
        expire(hold)
        raise HoldExpired()
    if not hold.is_live:
        raise HoldExpired()
    return hold


@transaction.atomic
def extend_for_part_payment(hold):
    """Give a part-paid reservation the longer window, once.

    Somebody has actually paid, so the court deserves more time than an
    abandoned checkout gets. Once, though: extending on every share would let
    a group of friends paying a pound at a time hold a Saturday evening court
    all day. `extended_at` records that it has happened, and
    `max_expires_at` caps the result however the rule changes later.
    """
    locked = (BookingHold.objects.select_for_update()
              .filter(pk=hold.pk, status=HoldStatus.ACTIVE).first())
    if locked is None or locked.extended_at is not None:
        return hold

    minutes = hold_minutes_for(PaymentStatus.PARTIALLY_PAID, locked.club)
    extended = timezone.now() + timedelta(minutes=minutes)
    locked.expires_at = min(max(extended, locked.expires_at), locked.max_expires_at)
    locked.extended_at = timezone.now()
    locked.save(update_fields=["expires_at", "extended_at", "updated_at"])
    _invalidate(locked)
    return locked


@transaction.atomic
def convert(hold, *, booking=None, order=None):
    """The payment landed: the booking now holds the court, not the hold.

    Deliberately does not release the slots first. The confirmed booking is
    already blocking them by then, so there is no instant at which the court
    looks free to anybody else.
    """
    locked = (BookingHold.objects.select_for_update()
              .filter(pk=hold.pk).first())
    if locked is None or locked.status != HoldStatus.ACTIVE:
        return hold
    locked.status = HoldStatus.CONVERTED
    locked.booking = booking
    locked.order = order
    locked.ended_at = timezone.now()
    locked.save(update_fields=["status", "booking", "order", "ended_at",
                               "updated_at"])
    _invalidate(locked)
    return locked


def release(hold, *, status=HoldStatus.RELEASED):
    """Give the courts back. Idempotent: only an active hold changes."""
    with transaction.atomic():
        locked = (BookingHold.objects.select_for_update()
                  .filter(pk=hold.pk, status=HoldStatus.ACTIVE).first())
        if locked is None:
            return hold
        locked.status = status
        locked.ended_at = timezone.now()
        locked.save(update_fields=["status", "ended_at", "updated_at"])
        _invalidate(locked)
        return locked


def expire(hold):
    """Release a reservation whose time is up."""
    return release(hold, status=HoldStatus.EXPIRED)


def expire_due(*, now=None):
    """Expire every reservation past its deadline. Returns how many.

    Safe to run repeatedly and safe to run late: it only acts on rows still
    marked active, and the read paths enforce expiry themselves in between.
    """
    now = now or timezone.now()
    due = BookingHold.objects.filter(status=HoldStatus.ACTIVE,
                                     expires_at__lte=now)
    closed = 0
    for hold in due:
        if release(hold, status=HoldStatus.EXPIRED).status == HoldStatus.EXPIRED:
            closed += 1
    return closed


def _invalidate(hold):
    """Availability changed the moment a court was claimed or given back."""
    from . import availability_cache

    availability_cache.invalidate()
