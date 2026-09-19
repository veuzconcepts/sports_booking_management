"""Booking several time slots as one customer checkout.

This adds no availability logic of its own. Every slot is put through the same
`slot_is_available` the single-slot flow uses, and the same `check_booking_rules`
for lead time, horizon and per-customer caps. What lives here is only the part
that is genuinely new: the rules about a SET of slots (how many, whether they
may span dates, whether they must run back to back), and creating the resulting
bookings atomically.

Two things this module is careful about:

* It never trusts the browser's idea of availability. A selection is revalidated
  in full at submit time, under a lock, because minutes can pass between picking
  a slot and paying for it.
* It reports per slot, not per request. "Something is unavailable" makes a
  customer re-pick everything; "9:00 PM is no longer available" does not.
"""

from datetime import date as date_cls, datetime, time as time_cls, timedelta
from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction

from .models import ACTIVE_STATUSES, Booking, BookingOrder, BookingStatus


class SelectionError(Exception):
    """A selection was refused as a whole. The message is safe to show."""

    def __init__(self, message, *, code="", slots=None):
        self.code = code
        # Per-slot detail, so the UI can mark the offending ones rather than
        # clearing the lot.
        self.slots = slots or []
        super().__init__(message)


def parse_slots(raw):
    """Normalise submitted slots into sorted, de-duplicated (date, time) pairs.

    Sorting is chronological rather than click order, because that is the only
    order in which "are these consecutive?" and the confirmation screen make
    sense. Duplicates are dropped here AND rejected by the database's
    (facility, date, time) unique index, which is the guarantee that matters.
    """
    parsed, seen = [], set()
    for entry in (raw or []):
        if not isinstance(entry, dict):
            raise SelectionError("Those times could not be read.", code="invalid_slots")
        try:
            on_date = date_cls.fromisoformat(str(entry.get("date")))
            at_time = time_cls.fromisoformat(str(entry.get("time")))
        except (ValueError, TypeError):
            raise SelectionError("Those times could not be read.", code="invalid_slots")
        key = (on_date, at_time)
        if key in seen:
            continue
        seen.add(key)
        parsed.append(key)
    parsed.sort()
    return parsed


def _slot_end(on_date, at_time, duration):
    return (datetime.combine(on_date, at_time) + timedelta(minutes=duration)).time()


def check_selection_shape(slots, rules, *, duration):
    """The rules about the SET: count, dates, adjacency.

    Availability is a separate question and is checked on its own, because a
    selection can be perfectly well shaped and still have lost a slot to
    somebody else in the meantime.
    """
    problems = []
    count = len(slots)

    if count == 0:
        raise SelectionError("Choose a time to continue.", code="no_slots")

    if not rules["allow_multiple_slots"] and count > 1:
        raise SelectionError(
            "Only one time slot can be booked at a time here.",
            code="multiple_not_allowed")

    minimum = rules["min_slots_per_booking"]
    maximum = rules["max_slots_per_booking"]
    if count < minimum:
        problems.append(
            f"Select at least {minimum} time slots to continue.")
    if count > maximum:
        problems.append(
            f"You can select up to {maximum} time slots for this booking.")

    dates = {on_date for on_date, _ in slots}
    if len(dates) > 1 and not rules["allow_multiple_dates"]:
        problems.append("All of your times must be on the same date.")

    if rules["require_consecutive_slots"] and count > 1:
        if len(dates) > 1:
            problems.append(
                "Back-to-back times must all be on the same date.")
        else:
            for previous, current in zip(slots, slots[1:]):
                if _slot_end(previous[0], previous[1], duration) != current[1]:
                    problems.append(
                        "Your times must run back to back with no gaps.")
                    break

    if problems:
        raise SelectionError(" ".join(problems), code="selection_invalid")


def check_selection_availability(slots, *, club, facility_type, duration,
                                 exclude_booking_ids=None, exclude_hold_id=None):
    """Ask the availability engine about every slot, and report each one.

    Returns the list of slots that are NO LONGER bookable, each with the
    detail a customer needs to fix their selection. An empty list means the
    whole selection is currently free.

    Capacity is counted across the selection too: picking the same hour twice
    is caught by de-duplication, but two different slots can still compete for
    the last free court on a busy evening, and only the engine knows that.
    """
    from . import services as booking_services

    unavailable = []
    for on_date, at_time in slots:
        free = booking_services.slot_is_available(
            on_date, at_time, club=club, facility_type=facility_type,
            duration=duration,
            # The customer's own reservation is what they are checking out
            # against, so it must not report their own slots as taken.
            exclude_hold_id=exclude_hold_id,
        )
        if not free:
            unavailable.append({
                "date": on_date.isoformat(),
                "time": at_time.strftime("%H:%M"),
                "end": _slot_end(on_date, at_time, duration).strftime("%H:%M"),
            })
    return unavailable


def validate_selection(slots, *, club, facility_type, customer=None,
                       staff_booking=False, rules=None, exclude_hold_id=None):
    """Everything that must be true before a selection may be paid for.

    Shape first, then the booking policy, then availability, because telling
    somebody "that is one slot too many" is more useful than telling them a
    slot they were going to remove anyway is taken.
    """
    from . import services as booking_services

    duration = getattr(facility_type, "duration_minutes", None) or 60
    # Resolved across the facilities that could serve this activity, because
    # the customer has not chosen one; see `resolve_booking_slot_rules`.
    rules = rules or booking_services.resolve_booking_slot_rules(
        club=club, facility_type=facility_type)

    check_selection_shape(slots, rules, duration=duration)

    # The club's own booking window and per-customer caps, per slot, using the
    # same check the single-slot flow runs.
    for on_date, at_time in slots:
        reasons = booking_services.check_booking_rules(
            club=club, on_date=on_date, at_time=at_time,
            customer=customer, staff_booking=staff_booking)
        if reasons:
            raise SelectionError(" ".join(reasons), code="rules")

    unavailable = check_selection_availability(
        slots, club=club, facility_type=facility_type, duration=duration,
        exclude_hold_id=exclude_hold_id)
    if unavailable:
        times = ", ".join(f"{s['time']}" for s in unavailable)
        raise SelectionError(
            f"{times} is no longer available. Please update your selection."
            if len(unavailable) == 1
            else f"{times} are no longer available. Please update your selection.",
            code="slot_unavailable", slots=unavailable)
    return rules


def allocate_discount(amounts, discount):
    """Split one order-level discount across slots, in proportion to price.

    Proportional rather than equal, because slots are not equally priced: a
    peak evening costs more than an afternoon, and an equal split would leave
    the cheap slot with a negative net once it was refunded. The remainder is
    handed out a minor unit at a time so the parts always add back to the whole.
    """
    total = sum(amounts, Decimal("0"))
    if total <= 0 or discount <= 0:
        return [Decimal("0.000") for _ in amounts]

    step = Decimal("0.001")                      # the models store 3 decimals
    units_total = int((discount / step).to_integral_value(rounding=ROUND_HALF_UP))
    raw = [(amount / total) * units_total for amount in amounts]
    floors = [int(value) for value in raw]
    leftover = units_total - sum(floors)
    # Largest fractional part first, so the cent lands where it is most owed.
    order = sorted(range(len(raw)), key=lambda i: raw[i] - floors[i], reverse=True)
    for index in order[:leftover]:
        floors[index] += 1
    return [Decimal(units) * step for units in floors]


@transaction.atomic
def create_order(*, customer, club, facility_type, slots, addons=None,
                 promo_input="", notes="", source="website", request=None,
                 staff_booking=False, booking_type="advance",
                 exclude_hold_id=None):
    """Turn a validated selection into one order and one booking per slot.

    Atomic by construction: every booking, the facility allocation behind it and
    the promo redemption all happen in one transaction, so a customer can never
    end up owning two thirds of what they tried to buy. If the last slot is
    taken by somebody else a moment before this runs, the whole thing unwinds.

    Availability is rechecked HERE, inside the transaction, rather than trusting
    the check the caller already did: the gap between choosing a slot and paying
    for it is measured in minutes, and the database's unique index on
    (facility, date, time) is the final word either way.
    """
    from rest_framework.exceptions import ValidationError as DRFValidationError

    from . import services as booking_services
    from apps.promotions.services import (
        compute_discount, get_active_promo, record_redemption, validate_for_booking,
    )

    from .serializers import BookingCreateSerializer

    duration = getattr(facility_type, "duration_minutes", None) or 60
    addon_ids = list(addons or [])

    still_taken = check_selection_availability(
        slots, club=club, facility_type=facility_type, duration=duration,
        exclude_hold_id=exclude_hold_id)
    if still_taken:
        times = ", ".join(entry["time"] for entry in still_taken)
        raise SelectionError(
            f"{times} is no longer available. Please update your selection."
            if len(still_taken) == 1
            else f"{times} are no longer available. Please update your selection.",
            code="slot_unavailable", slots=still_taken)

    order = BookingOrder.objects.create(
        customer=customer, club=club, facility_type=facility_type,
        currency=getattr(facility_type, "currency", None) or _order_currency(),
        source=source,
        created_by=_actor(request),
    )

    bookings = []
    for on_date, at_time in slots:
        payload = {
            "booking_type": booking_type,
            "source": source,
            "customer": customer.id,
            "facility_type": facility_type.id,
            "club": club.id,
            "add_ons": addon_ids,
            "scheduled_date": on_date.isoformat(),
            "scheduled_time": at_time.strftime("%H:%M"),
            "customer_notes": notes,
        }
        serializer = BookingCreateSerializer(
            data=payload,
            context={"request": request, "exclude_hold_id": exclude_hold_id})
        try:
            serializer.is_valid(raise_exception=True)
            booking = serializer.save()
        except DRFValidationError as exc:
            # One slot failing takes the whole order with it, which is the point.
            raise SelectionError(
                f"{at_time.strftime('%H:%M')} could not be booked. "
                "Please update your selection.",
                code="slot_rejected",
                slots=[{"date": on_date.isoformat(),
                        "time": at_time.strftime("%H:%M"),
                        "detail": str(exc.detail)[:200]}]) from exc
        booking.order = order
        booking.save(update_fields=["order", "updated_at"])
        bookings.append(booking)

    # The customer chose an activity, not a court, so the offer was the union
    # of what the eligible facilities allow. Now that the allocator has picked
    # real ones, check each against its own rules. Still inside the
    # transaction, so a breach unwinds the whole order.
    breaches = booking_services.facility_rule_breaches(bookings)
    if breaches:
        raise SelectionError(" ".join(breaches), code="facility_rules")

    if promo_input:
        _apply_order_promo(order, bookings, promo_input, customer=customer,
                           facility_type=facility_type, request=request,
                           get_active_promo=get_active_promo,
                           validate_for_booking=validate_for_booking,
                           compute_discount=compute_discount,
                           record_redemption=record_redemption)

    return order, bookings


def _apply_order_promo(order, bookings, code, *, customer, facility_type, request,
                       get_active_promo, validate_for_booking, compute_discount,
                       record_redemption):
    """Redeem one promo against the ORDER, then share it out across the slots.

    A promo carries limits that only make sense once per checkout: a usage
    count, a per-customer cap, a minimum order value and a maximum discount.
    Running it per booking would spend a redemption per slot, test the minimum
    against a single slot instead of the order, and apply the cap as many times
    as there are slots. So it is validated and computed once, here, and the
    resulting money is allocated back to the slots in proportion to their price
    so that refunding one slot later still returns the right net amount.

    A promo the order does not qualify for is skipped silently rather than
    failing the booking: the customer asked for a discount, not for their
    reservation to be refused.
    """
    from apps.promotions.services import PromoError

    try:
        promo = get_active_promo(code)
    except PromoError:
        return
    if promo is None:
        return

    subtotal = sum((Decimal(str(b.total_amount or 0)) for b in bookings), Decimal("0"))
    try:
        validate_for_booking(
            promo, subtotal=subtotal, customer_id=customer.id,
            facility_type_id=facility_type.id if facility_type else None)
    except PromoError:
        # Checked once against the ORDER total, which is the figure the promo's
        # minimum and per-customer limits are written about.
        return

    discount = compute_discount(promo, subtotal)
    if discount <= 0:
        return

    shares = allocate_discount(
        [Decimal(str(b.total_amount or 0)) for b in bookings], discount)
    for booking, share in zip(bookings, shares):
        booking.promo_code = promo
        booking.compute_pricing(promo_discount_override=share)
        booking.save()

    # One redemption for one checkout. Recorded against the first slot because
    # the ledger is per booking; the order reference ties them together.
    record_redemption(promo, bookings[0], discount, user=_actor(request))


def _order_currency():
    from apps.settings_app.currency import get_default_currency
    return get_default_currency()


def _actor(request):
    user = getattr(request, "user", None)
    return user if getattr(user, "is_authenticated", False) else None
