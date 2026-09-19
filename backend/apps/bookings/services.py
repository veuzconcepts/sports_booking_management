"""Slot / availability engine and lifecycle helpers for bookings.

Opening hours come from the club (falling back to the Organization default).
Capacity is resolved per booked FACILITY TYPE: the active `Facility` rows at the
club that can serve that type (a facility with no declared types serves any).
A slot is offered only while at least one of those facilities is free for the
WHOLE interval the booking would occupy - so a 90-minute booking genuinely
blocks the slots it spans, and a facility out for maintenance drops out of
capacity for the period.

Every booking that needs a facility is allocated one at save time
(`allocate_facility`), under a per-club/day lock, with a partial unique
constraint on (facility, date, start) as the last line of defence.
"""

import logging
from datetime import date as date_cls, datetime, time, timedelta
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

logger = logging.getLogger(__name__)

from .models import (
    ACTIVE_STATUSES,
    SLOT_BLOCKING_STATUSES,
    BookingSource,
    PaymentMethod,
    STATUS_TRANSITIONS,
    VERIFIED_BOOKING_STATUSES,
    Booking,
    BookingStatus,
    BookingStatusHistory,
    PaymentStatus,
    RecurrenceRule,
)

# Business-hour defaults (overridable via settings / the Organization profile).
OPEN_HOUR = getattr(settings, "BOOKING_OPEN_HOUR", 8)        # 08:00
CLOSE_HOUR = getattr(settings, "BOOKING_CLOSE_HOUR", 20)     # 20:00
SLOT_MINUTES = getattr(settings, "BOOKING_SLOT_MINUTES", 60)

_DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

_EPOCH = date_cls(2000, 1, 1)


def _as_dt(at_time):
    return datetime.combine(_EPOCH, at_time)


def interval_for(at_time, minutes):
    """The (start, end) times a booking of `minutes` starting at `at_time` holds.

    Returns `None` when it would run past midnight - such a slot is never
    offered, which keeps every stored interval comparable within one day.
    """
    end = _as_dt(at_time) + timedelta(minutes=minutes or 0)
    if end.date() != _EPOCH:
        return None
    return at_time, end.time()


def _overlaps(a_start, a_end, b_start, b_end) -> bool:
    """Half-open interval overlap: [a_start, a_end) vs [b_start, b_end)."""
    return a_start < b_end and b_start < a_end


def _resolve_schedule(on_date, club=None, facility=None):
    """The day's operating pattern, from the one schedule engine.

    Delegates to `apps.settings_app.schedule`, which owns the
    Organization -> Club -> Facility inheritance, recurring breaks and date
    exceptions. This function exists only so the slot engine has a single,
    failure-tolerant entry point: availability must never 500 because a
    schedule document is malformed.
    """
    from apps.settings_app import schedule as sched

    try:
        return sched.resolve_for_date(on_date, club=club, facility=facility)
    except Exception:                                     # pragma: no cover
        logger.exception("schedule resolution failed for %s", on_date)
        return sched.ResolvedDay(
            shifts=[sched.Window(OPEN_HOUR * 60, CLOSE_HOUR * 60)],
            slot_minutes=SLOT_MINUTES,
        )


# --------------------------------------------------------------------------- #
# Capacity: which facilities can serve this booking, and when are they free?
# --------------------------------------------------------------------------- #
def eligible_facilities(club=None, facility_type=None):
    """Active facilities that can host `facility_type`.

    A facility with no declared types is unrestricted, so a single-purpose club
    needs no per-facility setup at all.
    """
    from apps.facilities.models import Facility
    from django.db.models import Count, Q

    qs = Facility.objects.filter(is_active=True, club__is_active=True)
    if club is not None:
        qs = qs.filter(club=club)
    if facility_type is not None:
        qs = qs.annotate(_type_count=Count("facility_types")).filter(
            Q(_type_count=0) | Q(facility_types=facility_type))
    return qs.distinct()


def _day_bookings(on_date, club=None, exclude_booking_id=None):
    """(facility_id, start, end) for every booking holding a facility."""
    qs = Booking.objects.filter(
        scheduled_date=on_date, status__in=SLOT_BLOCKING_STATUSES,
        facility__isnull=False)
    if club is not None:
        qs = qs.filter(club=club)
    if exclude_booking_id:
        qs = qs.exclude(pk=exclude_booking_id)
    return list(qs.values_list("facility_id", "scheduled_time", "end_time"))


def _day_holds(on_date, club=None, exclude_hold_id=None):
    """(facility_id, start, end) for every LIVE reservation on this date.

    Same shape as `_day_bookings`, so a held court drops out of availability
    through the identical path a booked one does rather than through a second
    set of rules that could disagree with it.

    "Live" means active AND not yet past its deadline. The expiry sweep runs
    every few minutes, so between ticks the table holds rows that are still
    marked active but have run out; reading the clock here is what stops one
    of those blocking a court it no longer has any claim to.
    """
    from .models import BookingHoldSlot, HoldStatus

    qs = BookingHoldSlot.objects.filter(
        scheduled_date=on_date,
        hold__status=HoldStatus.ACTIVE,
        hold__expires_at__gt=timezone.now(),
    )
    if club is not None:
        qs = qs.filter(hold__club=club)
    if exclude_hold_id:
        qs = qs.exclude(hold_id=exclude_hold_id)
    return list(qs.values_list("facility_id", "scheduled_time", "end_time"))


def _range_holds(first, last, club=None) -> dict:
    """{date: [(facility_id, start, end)]} for a range, in one query."""
    from .models import BookingHoldSlot, HoldStatus

    qs = BookingHoldSlot.objects.filter(
        scheduled_date__gte=first, scheduled_date__lte=last,
        hold__status=HoldStatus.ACTIVE,
        hold__expires_at__gt=timezone.now(),
    )
    if club is not None:
        qs = qs.filter(hold__club=club)
    grouped = {}
    for on_date, fid, start, end in qs.values_list(
            "scheduled_date", "facility_id", "scheduled_time", "end_time"):
        grouped.setdefault(on_date, []).append((fid, start, end))
    return grouped


def _day_blocks(on_date, club=None):
    """(facility_id, start|None, end|None) for maintenance covering the date."""
    from apps.facilities.models import MaintenanceBlock

    qs = MaintenanceBlock.objects.filter(start_date__lte=on_date, end_date__gte=on_date)
    if club is not None:
        qs = qs.filter(facility__club=club)
    return list(qs.values_list("facility_id", "start_time", "end_time"))


def _facilities_with_own_schedule(on_date, facilities) -> set:
    """Facility ids whose day can differ from their club's.

    Anything else inherits the club exactly, which is what lets the slot engine
    resolve one schedule for a whole venue instead of one per court. The
    facility-scoped exception lookup is a single query for the set.
    """
    from datetime import timedelta as _timedelta

    from apps.settings_app.models import ScheduleException

    distinct = {f.id for f in facilities
                if (f.booking_hours or {}) or f.slot_minutes
                or f.buffer_before_minutes or f.buffer_after_minutes}
    # An overnight shift means the previous date can shape this one, so both
    # dates are considered, exactly as `resolve_for_date` does.
    previous = on_date - _timedelta(days=1)
    ids = [f.id for f in facilities]
    distinct |= set(
        ScheduleException.objects
        .filter(is_active=True, facility_id__in=ids, start_date__lte=on_date)
        .filter(Q(end_date__isnull=True, start_date__gte=previous)
                | Q(end_date__gte=previous))
        .values_list("facility_id", flat=True))
    return distinct


def _merge_windows(windows):
    """Overlapping windows collapsed into the smallest covering set.

    Two courts open 08:00-12:00 and 10:00-18:00 make one bookable 08:00-18:00
    grid, not two overlapping grids that would offer the same 10:00 twice.
    """
    from apps.settings_app import schedule as sched

    ordered = sorted(windows, key=lambda w: (w.start, w.end))
    merged = []
    for window in ordered:
        if merged and window.start <= merged[-1].end:
            if window.end > merged[-1].end:
                merged[-1] = sched.Window(merged[-1].start, window.end)
        else:
            merged.append(sched.Window(window.start, window.end))
    return merged


def slot_period(day, start, end) -> str:
    """The peak/off-peak classification of the shift a slot falls in.

    Read from the day's ORIGINAL shifts rather than the merged grid, because
    merging two adjacent shifts into one bookable window is exactly what would
    lose the boundary between a cold afternoon and a hot evening. A slot that
    straddles two differently classified shifts takes the one it starts in,
    which is the one the customer is booking.
    """
    from apps.settings_app import schedule as sched

    for shift in day.shifts:
        if shift.start <= start < shift.end:
            return shift.period
    return sched.PERIOD_NORMAL


def _covers(day, start, end) -> bool:
    """True when this resolved day has the whole [start, end) window open."""
    from apps.settings_app import schedule as sched

    if not day.is_open:
        return False
    if not any(s.start <= start and end <= s.end for s in day.shifts):
        return False
    return not any(sched.overlaps(start, end, b.start, b.end) for b in day.breaks)


def _pad(start, end, before, after):
    """Widen [start, end) by the configured buffers, clamped to the day."""
    if not before and not after:
        return start, end
    lo = max(0, (start.hour * 60 + start.minute) - before)
    hi = min(24 * 60 - 1, (end.hour * 60 + end.minute) + after)
    return time(lo // 60, lo % 60), time(hi // 60, hi % 60)


def _taken_ids(bookings, blocks, start, end, *, buffer_before=0, buffer_after=0):
    """Facility ids unavailable for [start, end) given prefetched rows.

    Buffers widen the EXISTING bookings rather than the window being tested, so
    a 15-minute changeover leaves exactly one 15-minute gap between two
    bookings instead of thirty.
    """
    taken = set()
    for fid, b_start, b_end in bookings:
        if b_start is None:
            continue
        held_start, held_end = _pad(b_start, b_end or b_start, buffer_before, buffer_after)
        if _overlaps(start, end, held_start, held_end):
            taken.add(fid)
    for fid, m_start, m_end in blocks:
        if m_start is None or m_end is None:          # all-day block
            taken.add(fid)
        elif _overlaps(start, end, m_start, m_end):
            taken.add(fid)
    return taken


def free_facilities(on_date, at_time, *, duration=None, club=None, facility_type=None,
                    exclude_booking_id=None, exclude_hold_id=None):
    """Facilities free for the whole interval this booking would occupy.

    `duration` defaults to the facility type's own duration, so asking for a
    90-minute court at 10:00 checks 10:00-11:30, not just the 10:00 slot.
    """
    if duration is None:
        duration = getattr(facility_type, "duration_minutes", None) or SLOT_MINUTES
    window = interval_for(at_time, duration)
    if window is None:                                # would run past midnight
        return []
    start, end = window

    candidates = list(eligible_facilities(club=club, facility_type=facility_type))
    if not candidates:
        return []
    taken = _taken_ids(
        _day_bookings(on_date, club=club, exclude_booking_id=exclude_booking_id)
        + _day_holds(on_date, club=club, exclude_hold_id=exclude_hold_id),
        _day_blocks(on_date, club=club),
        start, end,
    )
    # A facility that is not open for this window cannot take the booking, even
    # though nothing is booked in it. Without this the slot grid and the save
    # path disagreed: the website correctly hid a morning slot at an
    # evening-only court, and the booking endpoint accepted it anyway.
    #
    # Same inheritance shortcut as the slot engine: only facilities that can
    # actually differ from their club are resolved individually.
    start_minutes = start.hour * 60 + start.minute
    end_minutes = start_minutes + duration
    open_now = [f for f in candidates if f.id not in taken]
    if not open_now:
        return []
    distinct = _facilities_with_own_schedule(on_date, open_now)
    shared_day = _resolve_schedule(on_date, club=club or open_now[0].club)
    free = []
    for f in open_now:
        fday = (_resolve_schedule(on_date, club=f.club, facility=f)
                if f.id in distinct else shared_day)
        if _covers(fday, start_minutes, end_minutes):
            free.append(f)
    return free


def capacity_for(on_date=None, at_time=None, club=None, facility_type=None) -> int:
    """How many bookings of this type can run concurrently at this club.

    This is the number of facilities that COULD serve the type (before existing
    bookings), which is what a capacity figure means to an operator. Use
    `free_facilities` for what is actually still open at a given time.
    """
    return eligible_facilities(club=club, facility_type=facility_type).count()


# Backwards-compatible alias used by older call sites.
_capacity_for = capacity_for


def available_slots(on_date, club=None, facility_type=None, facility=None) -> list[dict]:
    """The day's bookable slots with remaining capacity.

    The operating pattern is resolved once through the schedule engine
    (Organization -> Club -> Facility, then any date exception), then every slot
    is answered from prefetched rows so the whole day costs a fixed number of
    queries. Each entry:
    {"time", "end", "capacity", "booked", "available"}.

    A slot is omitted when it is in the past (for today, in the ORGANIZATION's
    timezone), when the booking would run past the shift's close or past
    midnight, or when it would overlap a break.
    """
    day = _resolve_schedule(on_date, club=club, facility=facility)

    interval = day.slot_minutes or SLOT_MINUTES
    duration = getattr(facility_type, "duration_minutes", None) or interval
    candidates = list(eligible_facilities(club=club, facility_type=facility_type))
    if facility is not None:
        candidates = [f for f in candidates if f.id == facility.id]
    if not candidates:
        return []

    # A court claimed by a live reservation is as unavailable as a booked one.
    bookings = (_day_bookings(on_date, club=club)
                + _day_holds(on_date, club=club))
    blocks = _day_blocks(on_date, club=club)

    # Every eligible facility's OWN operating day.
    #
    # A facility only differs from its club when it stores its own hours or slot
    # length, or when a special date names it specifically. Everything else
    # inherits, so those facilities reuse ONE resolution: resolving per facility
    # would turn a fixed-cost day into a query per court.
    # When no specific facility was asked for, `day` IS the club's day, so it
    # is reused rather than resolved a second time.
    shared_day = day if facility is None else _resolve_schedule(on_date, club=club)
    own_day = {}
    if candidates:
        distinct = _facilities_with_own_schedule(on_date, candidates)
        for f in candidates:
            own_day[f.id] = (_resolve_schedule(on_date, club=club, facility=f)
                             if f.id in distinct else shared_day)

    return _build_slots(on_date, day=day, own_day=own_day, bookings=bookings,
                        blocks=blocks, interval=interval, duration=duration)


def _build_slots(on_date, *, day, own_day, bookings, blocks, interval, duration,
                 now=None):
    """The slot grid for one date, from data the caller has already loaded.

    Separated from `available_slots` so a whole month can be summarised
    without re-reading the schedule, the facilities, the bookings and the
    maintenance blocks once per day. Both callers run this same code, so a
    date can never be described differently by the calendar and by the slot
    list.
    """
    from apps.settings_app import schedule as sched

    day_minutes = 24 * 60

    # The grid is the union of the hours the facilities that can serve this
    # booking actually keep, not the club's alone. A court with its own evening
    # schedule has to offer its evening, and must not offer the club's morning
    # when it is shut - which is what produced a whole day of slots labelled
    # "fully booked" at a venue that simply was not open yet.
    shifts = _merge_windows(
        [w for fday in own_day.values() if fday.is_open for w in fday.shifts])
    if not shifts:
        return []                                   # closed, or fully excepted

    # Resolved once by a range caller and passed in: reading the clock asks
    # the Organization for its timezone, which is a query, and a month of days
    # would otherwise ask thirty times for the same answer.
    now = now or sched.local_now()
    is_today = on_date == now.date()
    now_minutes = now.hour * 60 + now.minute

    slots = []
    seen = set()
    for shift in shifts:
        cursor = shift.start
        # A shift running past midnight only yields slots up to midnight here;
        # the remainder belongs to the next date, where the schedule engine
        # hands it back as that date's opening window.
        last = min(shift.end, day_minutes)
        while cursor < last:
            at_time = sched.from_minutes(cursor)
            label = f"{at_time.hour:02d}:{at_time.minute:02d}"
            window = interval_for(at_time, duration)
            runs_over = window is None or cursor + duration > shift.end
            in_break = any(sched.overlaps(cursor, cursor + duration, b.start, b.end)
                           for b in day.breaks)
            is_past = is_today and cursor <= now_minutes
            if not (is_past or runs_over or in_break) and label not in seen:
                seen.add(label)
                slot_start, slot_end = window
                # Being shut is not the same as being booked. A facility that
                # does not open for this window simply is not part of the
                # slot's capacity; counting it as "booked" was what told
                # customers a free evening court was fully reserved.
                open_ids = {
                    fid for fid, fday in own_day.items()
                    if _covers(fday, cursor, cursor + duration)
                }
                if not open_ids:
                    cursor += interval
                    continue                        # nothing here can serve it
                taken = _taken_ids(
                    bookings, blocks, slot_start, slot_end,
                    buffer_before=day.buffer_before, buffer_after=day.buffer_after,
                ) & open_ids
                capacity = len(open_ids)
                booked = len(taken)
                slots.append({
                    "time": label,
                    "end": slot_end.strftime("%H:%M"),
                    "capacity": capacity,
                    "booked": booked,
                    "available": max(0, capacity - booked),
                    # Classification only. It never changes a price by itself;
                    # a pricing rule has to ask for it.
                    "period": slot_period(day, cursor, cursor + duration),
                })
            cursor += interval
    slots.sort(key=lambda s: s["time"])
    return slots


# Why a date cannot be booked. The public UI shows one plain "unavailable"
# state; these exist so support and tests can tell the cases apart.
DATE_CLOSED = "closed"
DATE_HOLIDAY = "holiday"
DATE_FULL = "fully_booked"
DATE_PAST = "past"
DATE_OUTSIDE_WINDOW = "outside_window"
DATE_RULES = "rules"


def date_is_bookable(slots, rules) -> bool:
    """Whether this date's free slots can actually form a valid booking.

    Section 15: "at least one free slot" is not the question. A facility that
    demands two back-to-back slots cannot be booked on a date offering one
    isolated gap, and offering that date would send the customer to a slot
    list they cannot complete.

    What counts as enough depends on the same rules the submit path enforces:

    * one slot per booking, or a floor of one: any free slot will do;
    * a floor above one with back-to-back required: that many CONSECUTIVE free
      slots must exist on this date, because the engine refuses a consecutive
      run that spans dates;
    * a floor above one with other dates allowed: one free slot is enough, the
      rest can come from another date;
    * a floor above one confined to a single date: that many free slots must
      exist here, though they need not be adjacent.
    """
    free = [s for s in slots if s["available"] > 0]
    if not free:
        return False

    minimum = max(1, int(rules.get("min_slots_per_booking") or 1))
    if minimum <= 1 or not rules.get("allow_multiple_slots"):
        return True

    if rules.get("require_consecutive_slots"):
        return _longest_consecutive_run(free) >= minimum
    if rules.get("allow_multiple_dates"):
        return True
    return len(free) >= minimum


def _longest_consecutive_run(free_slots) -> int:
    """The most back-to-back free slots on one date.

    "Back to back" means one slot's end IS the next one's start, which is the
    same test `multi_slot.check_selection_shape` applies.
    """
    ordered = sorted(free_slots, key=lambda s: s["time"])
    best = run = 1
    for previous, current in zip(ordered, ordered[1:]):
        run = run + 1 if previous["end"] == current["time"] else 1
        best = max(best, run)
    return best


def date_availability_summary(first, last, *, club=None, facility_type=None,
                              facility=None) -> dict:
    """`{iso date: {available, slot_count, reason}}` for a whole date range.

    So the calendar can grey out a date before the customer clicks it, without
    one request or one query per day. Every date is answered by the SAME slot
    engine the booking path uses: the schedule chain, exceptions, breaks,
    maintenance, live bookings, capacity, duration and the booking window all
    apply exactly as they would at submit time.

    This is a UX optimisation and nothing more. A date reported available here
    is still revalidated in full when a slot is chosen and again when the
    booking is saved.

    Cost is fixed rather than per day: the facilities, the whole range of
    bookings, the maintenance blocks and the schedule chain are each read once.
    """
    from apps.settings_app import schedule as sched

    from . import availability_cache

    if last < first:
        return {}

    cached = availability_cache.get(first, last, club=club,
                                    facility_type=facility_type, facility=facility)
    if cached is not None:
        return cached

    rules = resolve_booking_slot_rules(club=club, facility_type=facility_type)
    window = booking_window(club)
    earliest = date_cls.fromisoformat(window["earliest_date"])
    latest = date_cls.fromisoformat(window["latest_date"]) if window["latest_date"] else None
    now = sched.local_now()
    today = now.date()

    candidates = list(eligible_facilities(club=club, facility_type=facility_type))
    if facility is not None:
        candidates = [f for f in candidates if f.id == facility.id]

    summary = {}
    if not candidates:
        cursor = first
        while cursor <= last:
            summary[cursor.isoformat()] = _unbookable(DATE_CLOSED)
            cursor += timedelta(days=1)
        availability_cache.set(first, last, summary, club=club,
                               facility_type=facility_type, facility=facility)
        return summary

    # Customer-visible discounts that could land anywhere in the range, read
    # once from the pricing engine rather than per date.
    from apps.facilities import pricing

    club_id = getattr(club, "id", None)
    category_ids = (list(facility_type.categories.values_list("id", flat=True))
                    if facility_type is not None else [])
    offer_rules = pricing.offer_candidates(
        first, last, facility_type=facility_type, club_id=club_id)

    bookings_by_date = _range_bookings(first, last, club=club)
    holds_by_date = _range_holds(first, last, club=club)
    blocks = _range_blocks(first, last, club=club)
    club_days = sched.resolve_for_range(first, last, club=club, facility=facility)
    # Only facilities that can actually differ from their club are resolved
    # separately, the same shortcut the single-day path takes.
    distinct = _facilities_with_own_schedule_in_range(first, last, candidates)
    facility_days = {
        f.id: sched.resolve_for_range(first, last, club=club, facility=f)
        for f in candidates if f.id in distinct
    }

    duration = getattr(facility_type, "duration_minutes", None)
    cursor = first
    while cursor <= last:
        key = cursor.isoformat()
        day = club_days[cursor]
        if cursor < today or cursor < earliest:
            summary[key] = _unbookable(DATE_PAST if cursor < today
                                       else DATE_OUTSIDE_WINDOW)
        elif latest is not None and cursor > latest:
            summary[key] = _unbookable(DATE_OUTSIDE_WINDOW)
        else:
            own_day = {f.id: facility_days.get(f.id, {}).get(cursor, day)
                       for f in candidates}
            slots = _build_slots(
                cursor, day=day, own_day=own_day,
                bookings=(bookings_by_date.get(cursor, [])
                          + holds_by_date.get(cursor, [])),
                blocks=_blocks_on(blocks, cursor),
                interval=day.slot_minutes or SLOT_MINUTES,
                duration=duration or day.slot_minutes or SLOT_MINUTES,
                now=now,
            )
            free = sum(1 for s in slots if s["available"] > 0)
            if date_is_bookable(slots, rules):
                summary[key] = {"available": True, "slot_count": free, "reason": "",
                                # Availability first, offer second. A discount
                                # badge on a date nobody can book would be an
                                # advert for a disappointment.
                                "offer": pricing.date_offer(
                                    cursor, offer_rules, facility_type=facility_type,
                                    category_ids=category_ids, club_id=club_id)}
            elif not day.is_open:
                summary[key] = _unbookable(
                    DATE_HOLIDAY if day.exception else DATE_CLOSED)
            elif slots and free == 0:
                summary[key] = _unbookable(DATE_FULL)
            elif free:
                # Slots exist but not enough of them to satisfy the floor or
                # the back-to-back rule.
                summary[key] = _unbookable(DATE_RULES, slot_count=free)
            else:
                summary[key] = _unbookable(DATE_CLOSED)
        cursor += timedelta(days=1)

    availability_cache.set(first, last, summary, club=club,
                           facility_type=facility_type, facility=facility)
    return summary


def _unbookable(reason, slot_count=0):
    return {"available": False, "slot_count": slot_count, "reason": reason}


def _range_bookings(first, last, club=None) -> dict:
    """{date: [(facility_id, start, end)]} for the range, in one query."""
    qs = Booking.objects.filter(
        scheduled_date__gte=first, scheduled_date__lte=last,
        status__in=SLOT_BLOCKING_STATUSES, facility__isnull=False)
    if club is not None:
        qs = qs.filter(club=club)
    grouped = {}
    for on_date, fid, start, end in qs.values_list(
            "scheduled_date", "facility_id", "scheduled_time", "end_time"):
        grouped.setdefault(on_date, []).append((fid, start, end))
    return grouped


def _range_blocks(first, last, club=None) -> list:
    """Maintenance overlapping the range, in one query, with its own dates so
    each day can take the slice that covers it."""
    from apps.facilities.models import MaintenanceBlock

    qs = MaintenanceBlock.objects.filter(start_date__lte=last, end_date__gte=first)
    if club is not None:
        qs = qs.filter(facility__club=club)
    return list(qs.values_list("facility_id", "start_time", "end_time",
                               "start_date", "end_date"))


def _blocks_on(blocks, on_date) -> list:
    return [(fid, start, end) for fid, start, end, first, last in blocks
            if first <= on_date <= last]


def _facilities_with_own_schedule_in_range(first, last, facilities) -> set:
    """Facility ids whose day can differ from their club's, anywhere in the
    range. One query for the whole range rather than one per date."""
    from apps.settings_app.models import ScheduleException

    distinct = {f.id for f in facilities
                if (f.booking_hours or {}) or f.slot_minutes
                or f.buffer_before_minutes or f.buffer_after_minutes}
    previous = first - timedelta(days=1)
    ids = [f.id for f in facilities]
    distinct |= set(
        ScheduleException.objects
        .filter(is_active=True, facility_id__in=ids, start_date__lte=last)
        .filter(Q(end_date__isnull=True, start_date__gte=previous)
                | Q(end_date__gte=previous))
        .values_list("facility_id", flat=True))
    return distinct


def next_available_date(after, *, club=None, facility_type=None, facility=None,
                        horizon_days=120):
    """The first bookable date on or after `after`, or None within the horizon.

    Searched a month at a time through `date_availability_summary`, so finding
    a date three months out costs three range queries rather than ninety.
    Bounded by the booking window, because a date the policy would refuse is
    not an answer.
    """
    window = booking_window(club)
    latest = date_cls.fromisoformat(window["latest_date"]) if window["latest_date"] else None
    limit = after + timedelta(days=horizon_days)
    if latest is not None and latest < limit:
        limit = latest

    cursor = after
    while cursor <= limit:
        chunk_end = min(cursor + timedelta(days=30), limit)
        summary = date_availability_summary(
            cursor, chunk_end, club=club, facility_type=facility_type,
            facility=facility)
        for key in sorted(summary):
            if summary[key]["available"]:
                return date_cls.fromisoformat(key)
        cursor = chunk_end + timedelta(days=1)
    return None


def public_availability(on_date, club=None, facility_type=None, facility=None) -> dict:
    """Customer-facing availability for one date: bookable slots, whether the
    day is open, plus a per-weekday open/closed map for the date strip.

    The weekday map comes from the same `effective_week` the admin screens
    render, so the website strip and the Effective Schedule table can never
    disagree about which days are open.
    """
    from apps.settings_app import schedule as sched
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    day = _resolve_schedule(on_date, club=club, facility=facility)

    # Which of the day's times a customer-visible discount actually covers.
    # Read once for the date and narrowed per slot, so a discount that runs
    # only in the morning marks only the morning.
    from apps.facilities import pricing

    club_id = getattr(club, "id", None)
    category_ids = (list(facility_type.categories.values_list("id", flat=True))
                    if facility_type is not None else [])
    offer_rules = pricing.offer_candidates(
        on_date, on_date, facility_type=facility_type, club_id=club_id)

    slots = []
    for s in available_slots(on_date, club=club, facility_type=facility_type,
                             facility=facility):
        hour, minute = (int(part) for part in s["time"].split(":"))
        slots.append({
            "time": s["time"], "end": s["end"], "available": s["available"],
            "period": s.get("period", "normal"),
            "offer": pricing.slot_offer(
                on_date, time(hour, minute), offer_rules,
                facility_type=facility_type, category_ids=category_ids,
                club_id=club_id) if offer_rules else None,
        })

    week = sched.effective_week(club=club, facility=facility)
    weekdays = {key: {"closed": bool(cfg["closed"])} for key, cfg in week.items()}

    return {
        "date": on_date.isoformat(),
        "closed": not day.is_open,
        "slot_minutes": day.slot_minutes,
        "time_format_24h": org.time_format_24h,
        "timezone": org.timezone,
        "weekdays": weekdays,
        "slots": slots,
        # How many of those slots one booking may hold here. The wizard needs
        # this to know whether to offer multi-select at all; it is resolved by
        # the backend, never worked out in the browser.
        "slot_rules": resolve_booking_slot_rules(club=club,
                                                 facility_type=facility_type),
        # Why the day looks the way it does, for the website's "closed" notice.
        "exception": day.exception,
        "breaks": [{"open": sched.fmt(b.start_time), "close": sched.fmt(b.end_time)}
                   for b in day.breaks],
    }


def resolve_booking_slot_rules(club=None, facility_type=None) -> dict:
    """The slot rules a customer booking an ACTIVITY may rely on.

    The website picks a club and an activity, never a named facility: which
    court actually serves the booking is decided by the allocator at save time.
    So the offer is the most permissive of what the eligible facilities allow,
    and the order is then re-checked against the facility each slot really
    landed on (`facility_rule_breaches`).

    Offering the strictest instead would be wrong in the common case: a club
    with one court capped at a single slot and another allowing ten would stop
    offering multi-slot altogether, even though every slot could have gone to
    the second court.
    """
    facilities = list(eligible_facilities(club=club, facility_type=facility_type))
    if not facilities:
        return resolve_slot_rules(club=club)

    best = None
    for facility in facilities:
        rules = resolve_slot_rules(club=facility.club, facility=facility)
        if best is None:
            best = dict(rules)
            continue
        best["allow_multiple_slots"] = (best["allow_multiple_slots"]
                                        or rules["allow_multiple_slots"])
        best["allow_multiple_dates"] = (best["allow_multiple_dates"]
                                        or rules["allow_multiple_dates"])
        # "Must be back to back" is a restriction, so the permissive union
        # only keeps it when every candidate insists on it.
        best["require_consecutive_slots"] = (best["require_consecutive_slots"]
                                             and rules["require_consecutive_slots"])
        best["min_slots_per_booking"] = min(best["min_slots_per_booking"],
                                            rules["min_slots_per_booking"])
        best["max_slots_per_booking"] = max(best["max_slots_per_booking"],
                                            rules["max_slots_per_booking"])

    if not best["allow_multiple_slots"]:
        best["min_slots_per_booking"] = 1
        best["max_slots_per_booking"] = 1
        best["allow_multiple_dates"] = False
    return best


def facility_rule_breaches(bookings) -> list:
    """Slot rules broken once the allocator has chosen the actual facilities.

    `resolve_booking_slot_rules` offers the union of what the candidates allow,
    because the facility is unknown while the customer is choosing. This is the
    other half of that bargain: after allocation, each facility's own rules are
    checked against the slots it really received, so a permissive neighbour can
    never be used to overfill a court that caps itself.

    Returns human-readable reasons, empty when the allocation is sound.
    """
    from collections import defaultdict

    by_facility = defaultdict(list)
    for booking in bookings:
        if booking.facility_id:
            by_facility[booking.facility].append(booking)

    reasons = []
    for facility, rows in by_facility.items():
        rules = resolve_slot_rules(club=facility.club, facility=facility)
        count = len(rows)
        if count > 1 and not rules["allow_multiple_slots"]:
            reasons.append(
                f"{facility.name} can only take one time slot per booking.")
            continue
        if count > rules["max_slots_per_booking"]:
            reasons.append(
                f"{facility.name} allows up to "
                f"{rules['max_slots_per_booking']} time slots per booking.")
        dates = {row.scheduled_date for row in rows}
        if len(dates) > 1 and not rules["allow_multiple_dates"]:
            reasons.append(
                f"{facility.name} needs all of your times on the same date.")
    return reasons


def slot_is_available(on_date, at_time, club=None, facility_type=None,
                      duration=None, exclude_pk=None, exclude_hold_id=None) -> bool:
    """True when at least one eligible facility is free for the whole interval.

    `exclude_hold_id` is the customer's OWN reservation. Without it the hold
    they are checking out against would report their own slot as taken.
    """
    return bool(free_facilities(
        on_date, at_time, duration=duration, club=club, facility_type=facility_type,
        exclude_booking_id=exclude_pk, exclude_hold_id=exclude_hold_id))


# --------------------------------------------------------------------------- #
# Booking rules: when a slot may be booked, and when it may still be cancelled
# --------------------------------------------------------------------------- #
def _actor_or_none(request):
    """The signed-in user behind a request, or None.

    A payment can now arrive from the public website, where `request.user` is an
    AnonymousUser. That is not a `User` row, so handing it to a FK raises; a
    guest payment simply has no staff actor.
    """
    user = getattr(request, "user", None)
    return user if getattr(user, "is_authenticated", False) else None


class PaymentDeclined(Exception):
    """An online authorisation was refused by the provider.

    Carries the failed `Payment` so the caller can record the attempt against
    whatever it was settling (a split share, a checkout) without re-querying.
    """

    def __init__(self, message, *, payment=None):
        self.payment = payment
        super().__init__(message)


class BookingRuleViolation(Exception):
    """A booking breaks the club's booking policy. Carries the reasons."""

    def __init__(self, reasons):
        self.reasons = list(reasons)
        super().__init__(" ".join(self.reasons))


# Multi-slot settings inherit field by field; everything older on BookingPolicy
# replaces its parent wholesale. See the model for why the two differ.
MULTI_SLOT_FIELDS = (
    "allow_multiple_slots",
    "allow_multiple_dates",
    "require_consecutive_slots",
    "min_slots_per_booking",
    "max_slots_per_booking",
)

# What a fresh install does before anybody configures anything: one slot at a
# time, exactly as the product behaved before multi-slot existed.
MULTI_SLOT_DEFAULTS = {
    "allow_multiple_slots": False,
    "allow_multiple_dates": False,
    "require_consecutive_slots": False,
    "min_slots_per_booking": 1,
    "max_slots_per_booking": 1,
}


def policy_chain(club=None, facility=None):
    """The policy rows that apply, most specific first.

    A facility implies its club even when the caller did not pass one, so a
    facility is never resolved against the wrong club's rules - the same rule
    the schedule engine follows.
    """
    from .models import BookingPolicy

    if facility is not None and club is None:
        club = facility.club

    chain = []
    if facility is not None:
        own = BookingPolicy.objects.filter(facility=facility).first()
        if own is not None:
            chain.append(own)
    if club is not None:
        own = BookingPolicy.objects.filter(club=club).first()
        if own is not None:
            chain.append(own)
    chain.append(_default_policy())
    return chain


def _default_policy():
    """The organization row, created on first access like `Organization.get_solo`."""
    from .models import BookingPolicy

    default = BookingPolicy.objects.filter(is_default=True).first()
    if default is None:
        default, _created = BookingPolicy.objects.get_or_create(
            is_default=True, defaults={"club": None, "facility": None})
    return default


def resolve_policy(club=None, facility=None):
    """The policy row in force - the most specific one that exists.

    Unchanged for the older fields: a club (or now a facility) row replaces its
    parent wholesale. Use `resolve_slot_rules` for the multi-slot settings,
    which inherit individually.
    """
    return policy_chain(club, facility)[0]


def resolve_slot_rules(club=None, facility=None) -> dict:
    """The effective multi-slot rules, merged down the chain.

    Each setting is taken from the most specific row that actually states it,
    so a court can cap itself at two slots without restating its club's lead
    time and cancellation window.

    Returns plain values, never None, so every caller gets a usable answer:

        {"allow_multiple_slots", "allow_multiple_dates",
         "require_consecutive_slots", "min_slots_per_booking",
         "max_slots_per_booking"}
    """
    rules = dict(MULTI_SLOT_DEFAULTS)
    # Least specific first, so the more specific row overwrites it.
    for policy in reversed(policy_chain(club, facility)):
        for field in MULTI_SLOT_FIELDS:
            value = getattr(policy, field, None)
            if value is not None:
                rules[field] = value

    # A cap below the floor would make every booking impossible, and a floor of
    # zero is meaningless. Normalise rather than trusting the stored numbers.
    rules["min_slots_per_booking"] = max(1, int(rules["min_slots_per_booking"] or 1))
    rules["max_slots_per_booking"] = max(1, int(rules["max_slots_per_booking"] or 1))
    if not rules["allow_multiple_slots"]:
        rules["min_slots_per_booking"] = 1
        rules["max_slots_per_booking"] = 1
        rules["allow_multiple_dates"] = False
    rules["max_slots_per_booking"] = max(
        rules["max_slots_per_booking"], rules["min_slots_per_booking"])
    return rules



# --------------------------------------------------------------------------- #
# Abandoned online checkouts
# --------------------------------------------------------------------------- #
#: How long a booking may hold a court while its customer is paying online.
#: Long enough to find a card and type it, short enough that a busy evening is
#: not lost to somebody who closed the tab.
PAYMENT_WINDOW_MINUTES = getattr(settings, "BOOKING_PAYMENT_WINDOW_MINUTES", 15)


def awaiting_online_payment(booking) -> bool:
    """Is this booking still waiting for money the customer promised online?

    One definition, used by two rules that have to agree. `expire_unpaid_bookings`
    releases the court when this stays true past the window; the confirmation gate
    refuses to call the booking Confirmed while it is true. If they ever disagreed
    a booking could be confirmed at the same moment its slot was being handed to
    somebody else.

    Deliberately narrow, and false whenever we are not sure:

    * a blank payment method means we never recorded an intent, so there is
      nothing to wait for;
    * cash is pay-at-venue: the money is due at the door, not now;
    * anything already part paid, covered or settled is somebody's real booking.
    """
    if booking.payment_status != PaymentStatus.PENDING:
        return False
    method = booking.payment_method or ""
    if not method or method == PaymentMethod.CASH:
        return False
    return booking_amount_paid(booking) <= 0



def expire_unpaid_bookings(*, now=None) -> int:
    """Release slots held by online checkouts that were never completed.

    This is deliberately narrow. A booking is only released when ALL of these
    are true, because every one of them rules out a booking somebody is
    relying on:

    * the customer chose to pay online, and we recorded that at checkout.
      A blank method is never expired: not knowing is a reason to leave it
      alone, not a reason to cancel somebody's court;
    * NOT "pay at venue". A cash booking is a real reservation the club
      agreed to hold, and expiring it would be the club breaking its word;
    * no money has been taken, not even partly;
    * no split payment arrangement exists. Split expiry is inert by confirmed
      policy, and a half-collected split must be resolved by a person;
    * still in the opening status. Anything staff have touched is theirs;
    * the payment window has passed.

    Returns how many were released. Safe to run repeatedly and safe to run
    late: it only ever acts on bookings still matching all of the above.
    """
    from apps.payments.models import BookingPaymentSplit, SplitStatus

    now = now or timezone.now()
    cutoff = now - timedelta(minutes=PAYMENT_WINDOW_MINUTES)

    candidates = (
        Booking.objects
        .filter(
            status=BookingStatus.BOOKED,
            payment_status=PaymentStatus.PENDING,
            created_at__lt=cutoff,
            source=BookingSource.WEBSITE,
        )
        # Not cash, and not unknown.
        .exclude(payment_method=PaymentMethod.CASH)
        .exclude(payment_method="")
        .select_related("club", "facility_type")
    )

    released = 0
    for booking in candidates:
        with transaction.atomic():
            locked = (Booking.objects.select_for_update()
                      .filter(pk=booking.pk, status=BookingStatus.BOOKED,
                              payment_status=PaymentStatus.PENDING)
                      .first())
            if locked is None:
                continue                      # somebody got there first
            # Re-read the shared rule under the lock. The queryset above is a
            # pre-filter; this is the decision.
            if not awaiting_online_payment(locked):
                continue                      # paid, or never ours to release
            if BookingPaymentSplit.objects.filter(
                    booking=locked, status=SplitStatus.ACTIVE).exists():
                continue                      # friends are still paying
            if locked.order_id and BookingPaymentSplit.objects.filter(
                    order_id=locked.order_id, status=SplitStatus.ACTIVE).exists():
                continue

            locked.status = BookingStatus.CANCELLED
            locked.cancelled_at = now
            locked.cancellation_reason = "Payment not completed in time"
            locked.save(update_fields=["status", "cancelled_at",
                                       "cancellation_reason", "updated_at"])
            record_booking_event(
                locked,
                "Released automatically - online payment was not completed "
                f"within {PAYMENT_WINDOW_MINUTES} minutes.",
                event="payment_window_expired",
                meta={"window_minutes": PAYMENT_WINDOW_MINUTES},
            )
            released += 1
    return released

def booking_window(club=None, now=None):
    """The bookable window a customer may choose from, for the date picker.

    Returns {"earliest_date", "earliest_start", "latest_date", "min_lead_minutes",
    "max_advance_days"}. `latest_date` is None when unlimited.
    """
    policy = resolve_policy(club)
    now = now or timezone.localtime()
    earliest = policy.earliest_start(now)
    latest = policy.latest_date(now)
    return {
        "earliest_date": earliest.date().isoformat(),
        "earliest_start": earliest.isoformat(),
        "latest_date": latest.isoformat() if latest else None,
        "min_lead_minutes": policy.min_lead_minutes,
        "max_advance_days": policy.max_advance_days,
        "cancellation_cutoff_hours": policy.cancellation_cutoff_hours,
    }


def _slot_start(on_date, at_time):
    """The timezone-aware moment a slot begins."""
    start = datetime.combine(on_date, at_time)
    if timezone.is_naive(start):
        start = timezone.make_aware(start, timezone.get_current_timezone())
    return start


def check_booking_rules(*, club, on_date, at_time, customer=None, staff_booking=False,
                        now=None, exclude_booking_id=None):
    """Reasons this booking breaks the club's policy. Empty list = allowed.

    `staff_booking=True` marks an admin-created booking, which is exempt unless
    the policy opts in with `enforce_for_staff` - reception must be able to take
    a walk-in for the next ten minutes.
    """
    policy = resolve_policy(club)
    if staff_booking and not policy.enforce_for_staff:
        return []

    now = now or timezone.localtime()
    reasons = []
    start = _slot_start(on_date, at_time)

    # --- Lead time --------------------------------------------------------
    if start < policy.earliest_start(now):
        if policy.min_lead_minutes >= 120 and policy.min_lead_minutes % 60 == 0:
            notice = f"{policy.min_lead_minutes // 60} hours"
        else:
            notice = f"{policy.min_lead_minutes} minutes"
        reasons.append(
            f"Bookings need at least {notice} notice."
            if policy.min_lead_minutes else "That time has already passed.")

    # --- Booking horizon --------------------------------------------------
    latest = policy.latest_date(now)
    if latest is not None and on_date > latest:
        reasons.append(
            f"Bookings can only be made up to {policy.max_advance_days} days ahead "
            f"(until {latest.isoformat()}).")

    # --- Per-customer limits ---------------------------------------------
    if customer is not None:
        live = Booking.objects.filter(customer=customer, status__in=ACTIVE_STATUSES)
        if exclude_booking_id:
            live = live.exclude(pk=exclude_booking_id)

        if policy.max_active_bookings_per_customer:
            upcoming = live.filter(scheduled_date__gte=now.date()).count()
            if upcoming >= policy.max_active_bookings_per_customer:
                reasons.append(
                    f"You already hold {upcoming} upcoming bookings, which is the "
                    f"maximum of {policy.max_active_bookings_per_customer}.")

        if policy.max_bookings_per_customer_per_day:
            same_day = live.filter(scheduled_date=on_date).count()
            if same_day >= policy.max_bookings_per_customer_per_day:
                reasons.append(
                    f"You already have {same_day} bookings on "
                    f"{on_date.isoformat()}, which is the daily maximum of "
                    f"{policy.max_bookings_per_customer_per_day}.")

    return reasons


def enforce_booking_rules(**kwargs):
    """`check_booking_rules`, raising `BookingRuleViolation` on any breach."""
    reasons = check_booking_rules(**kwargs)
    if reasons:
        raise BookingRuleViolation(reasons)
    return True


def cancellation_state(booking, now=None):
    """Whether the CUSTOMER may still cancel, and until when.

    Staff are never blocked - a member who phones in is cancelled by reception
    regardless of the cutoff, which is the point of having staff.
    """
    policy = resolve_policy(booking.club)
    deadline = policy.cancellation_deadline(booking)
    now = now or timezone.localtime()
    terminal = booking.status not in ACTIVE_STATUSES
    return {
        "deadline": deadline.isoformat() if deadline else None,
        "cutoff_hours": policy.cancellation_cutoff_hours,
        "customer_can_cancel": (not terminal) and (deadline is None or now < deadline),
    }


class CancellationTooLate(Exception):
    """The customer cancellation cutoff for this booking has passed."""


def enforce_cancellation_window(booking, *, actor_is_customer, now=None):
    """Raise `CancellationTooLate` when a customer cancels past the cutoff."""
    if not actor_is_customer:
        return True
    state = cancellation_state(booking, now=now)
    if not state["customer_can_cancel"] and state["deadline"]:
        raise CancellationTooLate(
            f"This booking can no longer be cancelled online - the cutoff was "
            f"{resolve_policy(booking.club).cancellation_cutoff_hours} hours before "
            f"the start time. Please contact the club.")
    return True


class FacilityUnavailable(Exception):
    """No eligible facility is free for the requested interval."""


def _lock_club_day(club_id, on_date) -> None:
    """Hold an exclusive lock on one club's day for the rest of the transaction.

    Allocation reads "which courts are free?" and then writes a booking. Those
    two steps have to be one step as far as any other booking is concerned, or
    two customers are both told the same court is free.

    A PostgreSQL advisory lock is used rather than row locks because the thing
    being protected does not exist yet: it is the absence of a conflicting
    booking. Advisory locks need no table, cover an empty day exactly as well
    as a busy one, and are released automatically when the transaction ends,
    including on rollback, so a crash cannot leave a club unbookable.

    The key is (club, date) so two clubs, or two days at one club, never wait
    on each other. Anything other than PostgreSQL falls back to the ordinary
    row locks, which is weaker but is not a configuration this project runs.
    """
    from django.db import connection

    if connection.vendor != "postgresql":
        list(Booking.objects.select_for_update()
             .filter(club_id=club_id, scheduled_date=on_date,
                     status__in=SLOT_BLOCKING_STATUSES)
             .values_list("id", flat=True))
        return

    # Two 32-bit keys: the club, and the date as a day number. Both are well
    # inside int4, so neither needs hashing and the pair stays legible in
    # `pg_locks` when somebody is diagnosing a wait.
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s, %s)",
                       [int(club_id), int(on_date.toordinal())])


def allocate_facility(booking, *, commit=True, exclude_hold_id=None):
    """Pick a facility for `booking` and pin it to the booking.

    Server-side allocation: the customer books a TYPE, we choose the unit. Runs
    inside a transaction that locks the club's bookings for that day first, so
    two concurrent bookings cannot be handed the same court; the partial unique
    constraint on (facility, date, start) is the backstop if that lock is ever
    bypassed. Raises `FacilityUnavailable` when nothing is free.

    A booking that already names a facility keeps it (staff override), but the
    choice is still validated as eligible and free.
    """
    if not booking.facility_type_id or not booking.facility_type.facility_required:
        return None
    if booking.club_id is None:
        return None

    with transaction.atomic():
        # Serialise allocation for this club/day.
        #
        # This used to be a SELECT FOR UPDATE over the day's existing bookings,
        # which does not do the job: row locks only cover rows that are already
        # there, so an empty day locked nothing at all, and PostgreSQL at READ
        # COMMITTED has no gap locks to stop a concurrent INSERT either. Two
        # customers could both be told a court was free and both get it. The
        # unique index caught that only when the two start times were
        # identical; a 19:00 two-hour booking and a 20:00 one-hour booking are
        # different rows, and both were accepted.
        _lock_club_day(booking.club_id, booking.scheduled_date)

        free = free_facilities(
            booking.scheduled_date, booking.scheduled_time,
            duration=booking.duration_minutes, club=booking.club,
            facility_type=booking.facility_type, exclude_booking_id=booking.pk,
            # The reservation this booking is being created FROM must not
            # block it. Every other live hold still does.
            exclude_hold_id=exclude_hold_id,
        )
        if booking.facility_id:
            chosen = next((f for f in free if f.id == booking.facility_id), None)
            if chosen is None:
                raise FacilityUnavailable(
                    f"{booking.facility.name} is not available at that time.")
        else:
            chosen = free[0] if free else None
            if chosen is None:
                label = booking.facility_type.name
                raise FacilityUnavailable(
                    f"No {label} is free at that time. Please choose another slot.")
            booking.facility = chosen
            if commit and booking.pk:
                booking.save(update_fields=["facility", "updated_at"])
        return chosen


# --------------------------------------------------------------------------- #
# Lifecycle
# --------------------------------------------------------------------------- #
def can_transition(current: str, target: str) -> bool:
    return target in STATUS_TRANSITIONS.get(current, set())


@transaction.atomic
def transition_booking(booking: Booking, target: str, *, actor=None, note="", request=None) -> Booking:
    """Apply a guarded status transition and record history.

    On completion, finance is finalised automatically (invoice + receipt) so no
    manual step is needed. Raises ValueError on an illegal transition.
    """
    current = booking.status
    if current == target:
        return booking
    if not can_transition(current, target):
        raise ValueError(
            f"Cannot move booking from '{current}' to '{target}'."
        )
    # Revalidate subscription coverage BEFORE the completion gate: a held unit that
    # was consumed elsewhere makes this booking chargeable, so the gate then
    # correctly requires payment instead of completing it free.
    if target == BookingStatus.COMPLETED:
        from apps.payments.services import revalidate_booking_coverage
        reval = revalidate_booking_coverage(booking, request=request)
        if reval:
            record_booking_event(
                booking, "Subscription no longer available - booking is now chargeable",
                actor=actor, event="coverage_revalidated",
                meta={"source": event_source(actor), "membership": reval["membership"],
                      "from_amount": reval["from_amount"], "to_amount": reval["to_amount"],
                      "currency": booking.currency})
    _validate_confirmation_gate(booking, target)
    _validate_completion_gate(booking, target)

    booking.status = target
    if target == BookingStatus.COMPLETED:
        booking.completed_at = timezone.now()
    elif target == BookingStatus.CANCELLED:
        booking.cancelled_at = timezone.now()
        if note:
            booking.cancellation_reason = note[:255]
    booking.save()

    BookingStatusHistory.objects.create(
        booking=booking,
        from_status=current,
        to_status=target,
        changed_by=actor,
        note=note[:255],
        event="status_change",
        meta={"source": event_source(actor), "from": current, "to": target},
    )
    _refresh_history_cache(booking)

    # A confirmed booking (or any later status) implicitly verifies the customer
    # — a real, staff-confirmed visit. Idempotent: only the first one flips them.
    if booking.customer_id and target in VERIFIED_BOOKING_STATUSES:
        from apps.customers.models import VerificationMethod
        from apps.customers.services import verify_customer
        verify_customer(booking.customer, method=VerificationMethod.BOOKING_CONFIRMED,
                        actor=actor, request=request)

    # Membership usage: deduct on completion; restore if the visit didn't happen.
    if target == BookingStatus.COMPLETED:
        from apps.payments.services import consume_for_booking
        consume_for_booking(booking, request=request)
        snap = booking.coverage_snapshot
        if snap:
            record_booking_event(
                booking, "Membership usage deducted on completion", actor=actor,
                event="usage_deducted",
                meta={"membership": snap.get("membership_number"),
                      "covered": snap.get("covered_lines"),
                      "covered_amount": snap.get("covered_amount"),
                      "currency": snap.get("currency")})
        invoice = finalize_booking_finance(booking, request=request)
        if invoice is not None:
            record_booking_event(
                booking, f"Invoice generated - {invoice.number}", actor=actor,
                event="invoice_generated",
                meta={"invoice": invoice.number, "amount": str(invoice.total),
                      "currency": invoice.currency})
        else:
            record_booking_event(
                booking, "Invoice skipped - no payable amount", actor=actor,
                event="invoice_skipped",
                meta={"reason": booking.get_payment_status_display()})
    elif target in (BookingStatus.CANCELLED, BookingStatus.NO_SHOW):
        from apps.payments.services import restore_for_booking
        restore_for_booking(booking, request=request)
        if booking.coverage_snapshot:
            record_booking_event(
                booking, "Membership usage restored", actor=actor,
                event="usage_restored",
                meta={"membership": booking.coverage_snapshot.get("membership_number")})
        # Loyalty: reverse any earned points + return any redeemed points (fail-safe).
        try:
            from apps.loyalty.services import reverse_loyalty_for_cancellation
            reverse_loyalty_for_cancellation(booking, actor=actor, request=request)
        except Exception:  # pragma: no cover - loyalty must never break the lifecycle
            logger.exception("loyalty reversal failed for booking %s", booking.id)
    return booking


def _validate_confirmation_gate(booking, target):
    """A website checkout that chose to pay online is not Confirmed until it pays.

    Confirmed means the club has committed the court. Saying that while the
    money is still outstanding is how a booking ends up looking settled at the
    same moment `expire_unpaid_bookings` is about to release its slot, so the
    two rules read the same predicate.

    Only that one case is refused. Pay-at-venue, admin and walk-in bookings,
    part-paid bookings, covered and zero-value bookings, and anything whose
    payment method was never recorded all confirm exactly as before: staff
    committing a court in person is a decision, not an oversight.
    """
    if target != BookingStatus.CONFIRMED:
        return
    if booking.source != BookingSource.WEBSITE:
        return
    if awaiting_online_payment(booking):
        raise ValueError(
            "This booking is still awaiting its online payment and cannot be "
            "confirmed yet.")


def check_confirmable(booking):
    """Raise if this booking could not be confirmed right now.

    For callers that write something else first and would have to undo it if
    the confirmation were refused. A booking already past Pending is not being
    confirmed, so it passes.
    """
    if booking.status == BookingStatus.BOOKED:
        _validate_confirmation_gate(booking, BookingStatus.CONFIRMED)


def _validate_completion_gate(booking, target):
    """Enforce the completion/closure business rules (spec #6/#12):
    - Completed: a payment must be recorded (paid payment or booking marked Paid)
      - zero-value bookings are exempt.
    - Closed: a live invoice must exist for a payable booking.
    Cancelled / No-show are not gated (they are separate terminal states).
    """
    from decimal import Decimal

    if target == BookingStatus.COMPLETED:
        # Owe = the still-outstanding amount (full price minus what's already been
        # collected across this booking's payments). A field-level PAID (walk-in /
        # admin-marked) also counts as settled.
        owed = booking_outstanding(booking) > 0
        settled = booking.payment_status == PaymentStatus.PAID
        if owed and not settled:
            raise ValueError("Record the payment before marking this booking Completed.")
    elif target == BookingStatus.CLOSED:
        from apps.payments.models import Invoice, InvoiceStatus
        # A live invoice is required only for payable bookings (zero-value
        # bookings never raise one).
        if booking.total_amount and Decimal(booking.total_amount) > 0:
            live_invoice = (
                Invoice.objects.filter(booking=booking)
                .exclude(status__in=[InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED])
                .exists()
            )
            if not live_invoice:
                raise ValueError("An invoice must exist before this booking can be closed.")


# --------------------------------------------------------------------------- #
# Financial-integrity truth: derive a booking's settlement from real Payment /
# Invoice rows, never from the (drift-prone) booking.payment_status field. These
# are the single source of truth for "is this booking financially settled?" and
# gate every coverage change so a paid booking can never also become covered.
# --------------------------------------------------------------------------- #
# Coverage can no longer change once the booking reaches any of these states.
_COVERAGE_LOCKED_STATUSES = {
    BookingStatus.COMPLETED, BookingStatus.CLOSED,
    BookingStatus.CANCELLED, BookingStatus.NO_SHOW,
}


def booking_amount_paid(booking) -> Decimal:
    """Amount billed & collected toward this booking = the gross total of its LIVE
    invoices (each created paid) plus any captured payment WITHOUT an invoice (a raw
    charge). Refunds are a SEPARATE reversal shown as Returns — they do NOT reduce
    this, so a partial refund (the invoice stays live as 'partially refunded') never
    creates a phantom 'still to collect'. A fully-refunded invoice goes dead and drops
    out, so the booking correctly reads unpaid again."""
    from django.db.models import Sum
    from apps.payments.models import Invoice, InvoiceStatus, Payment, PaymentStatus as PayStatus
    invoiced = (Invoice.objects
                .filter(booking=booking,
                        status__in=[InvoiceStatus.PAID, InvoiceStatus.PARTIALLY_REFUNDED])
                .aggregate(s=Sum("total"))["s"]) or Decimal("0")
    # Captured payments not represented by an invoice (raw charge without generate).
    orphan = (Payment.objects
              .filter(booking=booking, invoice__isnull=True,
                      status__in=[PayStatus.PAID, PayStatus.PARTIALLY_REFUNDED])
              .aggregate(s=Sum("amount"))["s"]) or Decimal("0")
    return Decimal(invoiced) + Decimal(orphan)


def booking_outstanding(booking) -> Decimal:
    """What is still to COLLECT: the booking total minus what's already been invoiced
    & paid (never negative). A refund doesn't increase this — only un-billed charges
    (e.g. add-ons added after payment) do."""
    total = Decimal(str(booking.total_amount or 0))
    return max(Decimal("0"), total - booking_amount_paid(booking))


def booking_line_breakdown(booking, *, addons=None, tax_rate=None):
    """Read-only per-line VAT breakdown for a booking, reconstructed from its frozen
    price snapshot (base_amount, add-ons, discount_amount, promo_discount,
    applied_rules) — it never re-evaluates pricing rules. Pass `addons` (a list of
    AddOn objects) to price an unsaved/transient booking (e.g. a live quote) whose
    M2M isn't set yet; otherwise the booking's own add-ons are used.

    Returns a list of lines, each a dict:
        {label, quantity, gross, discount, net, tax, total, tax_inclusive}
    `gross` is the catalogue price, `discount` the discount allocated to the line
    (its own item discount plus a proportional share of rule/promo discounts),
    `net` the VAT-exclusive taxable amount, `tax` the line VAT and `total` the line
    total (incl. VAT). Each line is taxed by ITS OWN inclusive/exclusive mode — so a
    mixed booking is correct — and the lines sum to booking.total_amount / VAT to
    booking.tax_amount (the largest line absorbs any sub-cent rounding remainder).

    Pass `tax_rate` (e.g. the invoice's frozen rate) to render faithfully against a
    historical document; otherwise the current default VAT rate is used.
    """
    from apps.settings_app.currency import round_money

    cur = booking.currency

    def q(v):
        return round_money(Decimal(str(v)), cur)

    rate = Decimal(str(tax_rate)) if tax_rate is not None else Booking._resolve_tax_rate()

    applied = booking.applied_rules or []
    def _amt(r):
        return Decimal(str(r.get("amount", 0)))
    rule_discount = sum((-_amt(r) for r in applied if _amt(r) < 0), Decimal("0"))
    taxable_surcharge = sum((_amt(r) for r in applied
                             if _amt(r) > 0 and r.get("tax_applicable", False)), Decimal("0"))
    nontaxable_surcharge = sum((_amt(r) for r in applied
                                if _amt(r) > 0 and not r.get("tax_applicable", False)), Decimal("0"))
    promo_discount = Decimal(str(booking.promo_discount or 0))
    # Catalogue item discount = total discount minus the rule + promo discounts.
    item_discount = max(Decimal("0"),
                        Decimal(str(booking.discount_amount or 0)) - rule_discount - promo_discount)

    # Add-ons a subscription covered are excluded from the billable lines.
    covered_labels = {ln.get("label") for ln in (booking.coverage_snapshot or {}).get("covered_lines", [])
                      if ln.get("kind") == "addon"}

    base_amount = Decimal(str(booking.base_amount or 0))
    lines = []   # [label, gross, taxable_amount (post item-discount), inclusive]
    if base_amount > 0 and (booking.facility_type_id or booking.facility_category_id):
        svc_label = (booking.facility_type.name if booking.facility_type_id
                     else booking.facility_category.name if booking.facility_category_id else "FacilityCategory")
        svc_incl = bool(getattr(booking.facility_type, "tax_inclusive", False)) if booking.facility_type_id else False
        lines.append([svc_label, base_amount, base_amount - item_discount, svc_incl])
    addon_iter = addons if addons is not None else booking.add_ons.all()
    for a in addon_iter:
        if a.name in covered_labels:
            continue
        price = Decimal(str(a.price))
        lines.append([a.name, price, price, bool(getattr(a, "tax_inclusive", False))])

    gross_taxable = sum((ln[2] for ln in lines), Decimal("0"))
    net_target = max(Decimal("0"),
                     gross_taxable - rule_discount - promo_discount + taxable_surcharge)
    factor = (net_target / gross_taxable) if gross_taxable > 0 else Decimal("0")

    out = []
    for label, gross, taxable, incl in lines:
        line_net_spend = taxable * factor                     # this line's taxable spend
        line_discount = (gross - taxable) + (taxable - line_net_spend)   # item + allocated
        if incl:
            net = line_net_spend / (Decimal("1") + rate) if rate else line_net_spend
            tax = line_net_spend - net
            total = line_net_spend
        else:
            tax = line_net_spend * rate
            total = line_net_spend + tax
        out.append({"label": label, "quantity": 1, "gross": q(gross),
                    "discount": q(line_discount), "net": q(total - tax),
                    "tax": q(tax), "total": q(total), "tax_inclusive": incl})
    if nontaxable_surcharge > 0:
        out.append({"label": "Surcharge (no VAT)", "quantity": 1,
                    "gross": q(nontaxable_surcharge), "discount": q(0),
                    "net": q(nontaxable_surcharge), "tax": q(0),
                    "total": q(nontaxable_surcharge), "tax_inclusive": False})

    # Reconcile any sub-cent rounding to the booking's frozen totals: nudge the
    # largest line so the VAT and totals shown add up exactly.
    if out:
        big = max(range(len(out)), key=lambda i: out[i]["total"])
        out[big]["tax"] = q(out[big]["tax"] + (q(booking.tax_amount) - sum((l["tax"] for l in out), Decimal("0"))))
        out[big]["total"] = q(out[big]["total"] + (q(booking.total_amount) - sum((l["total"] for l in out), Decimal("0"))))
        out[big]["net"] = q(out[big]["total"] - out[big]["tax"])
    return out


def booking_checkout_summary(booking, *, addons=None, tax_rate=None):
    """Customer-facing order summary for the website checkout, in the enterprise B2C
    convention: every line price is shown VAT-INCLUSIVE, then
        Subtotal − discounts (+ surcharges) = Total,
    with the contained VAT disclosed ("Includes VAT"). This ALWAYS reconciles, even
    when items mix VAT-inclusive and VAT-exclusive modes. Read-only (built from the
    frozen snapshot via booking_line_breakdown).

    Returns: {currency, items[{label, amount}], items_subtotal, adjustments[{label,
    adjustment?, amount, kind}], total, vat_amount, vat_percent, prices_include_vat}.
    """
    from apps.settings_app.currency import round_money

    cur = booking.currency

    def q(v):
        return round_money(Decimal(str(v)), cur)

    rate = Decimal(str(tax_rate)) if tax_rate is not None else Booking._resolve_tax_rate()

    lines = booking_line_breakdown(booking, addons=addons, tax_rate=rate)

    # Each line at its VAT-inclusive list (pre-discount) price — the figure the
    # customer recognises and pays.
    items, subtotal_incl = [], Decimal("0")
    for ln in lines:
        gross = Decimal(str(ln["gross"]))
        list_incl = gross if ln["tax_inclusive"] else q(gross * (Decimal("1") + rate))
        subtotal_incl += list_incl
        items.append({"label": ln["label"], "amount": str(list_incl)})
    subtotal_incl = q(subtotal_incl)

    total = q(booking.total_amount)
    discount_amount = Decimal(str(booking.discount_amount or 0))
    surcharge_amount = Decimal(str(booking.surcharge_amount or 0))
    # Scale every catalogue adjustment into VAT-inclusive terms so the lines below
    # reconcile exactly: Subtotal − discounts + surcharges = Total.
    stored_signed = surcharge_amount - discount_amount
    needed_signed = total - subtotal_incl
    scale = (needed_signed / stored_signed) if stored_signed != 0 else Decimal("0")

    applied = booking.applied_rules or []
    promo_discount = Decimal(str(booking.promo_discount or 0))
    rule_discount = sum((-Decimal(str(r.get("amount", 0))) for r in applied
                         if Decimal(str(r.get("amount", 0))) < 0), Decimal("0"))
    item_discount = max(Decimal("0"), discount_amount - rule_discount - promo_discount)

    adjustments = []
    if item_discount > 0:
        adjustments.append({"label": "Discount", "amount": str(q(item_discount * scale)),
                            "kind": "discount"})
    for r in applied:
        amt = Decimal(str(r.get("amount", 0)))
        if amt == 0:
            continue
        adjustments.append({
            "label": r.get("name") or "Adjustment",
            "adjustment": r.get("adjustment"),
            "amount": str(q(abs(amt) * scale)),
            "kind": "discount" if amt < 0 else "surcharge",
        })
    if promo_discount > 0:
        code = booking.promo_code.code if booking.promo_code_id else ""
        adjustments.append({"label": f"Coupon {code}".strip(),
                            "amount": str(q(promo_discount * scale)), "kind": "coupon"})

    # Absorb any sub-cent rounding so Subtotal − discounts + surcharges == Total.
    if adjustments:
        shown = Decimal("0")
        for a in adjustments:
            shown += Decimal(a["amount"]) * (Decimal("-1") if a["kind"] != "surcharge" else Decimal("1"))
        drift = (subtotal_incl + shown) - total
        if drift != 0:
            big = max(range(len(adjustments)), key=lambda i: Decimal(adjustments[i]["amount"]))
            sign = Decimal("-1") if adjustments[big]["kind"] != "surcharge" else Decimal("1")
            adjustments[big]["amount"] = str(q(Decimal(adjustments[big]["amount"]) + sign * drift))

    return {
        "currency": cur,
        "items": items,
        "items_subtotal": str(subtotal_incl),
        "adjustments": adjustments,
        "total": str(total),
        "vat_amount": str(q(booking.tax_amount)),
        "vat_percent": float(rate * 100),
        "prices_include_vat": True,
    }


def booking_has_live_invoice(booking) -> bool:
    """A non-dead (Issued/Paid/partially-refunded) invoice exists for this booking."""
    from apps.payments.models import Invoice, InvoiceStatus
    return Invoice.objects.filter(booking=booking).exclude(
        status__in=[InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED]).exists()


def booking_payment_taken(booking) -> bool:
    """True when real money has been captured against this booking — a PAID (or
    partially-refunded, i.e. still-held) Payment or Invoice exists. Excludes fully
    REFUNDED/CANCELLED documents, so an explicit reversal correctly un-locks it."""
    from apps.payments.models import (
        Invoice, InvoiceStatus, Payment, PaymentStatus as PayStatus)
    if Payment.objects.filter(
            booking=booking,
            status__in=[PayStatus.PAID, PayStatus.PARTIALLY_REFUNDED]).exists():
        return True
    return Invoice.objects.filter(
        booking=booking,
        status__in=[InvoiceStatus.PAID, InvoiceStatus.PARTIALLY_REFUNDED]).exists()


def coverage_change_locked(booking) -> str | None:
    """Reason a subscription redeem/unapply must be refused, or None if allowed.
    Subscription coverage is a PRE-INVOICE action: once a booking is finalised, has
    captured payment, OR has any live invoice, coverage is frozen (changing it would
    desync the issued document). Invoices are never auto-cancelled here."""
    if booking.status in _COVERAGE_LOCKED_STATUSES:
        return ("This booking is finalised - its subscription coverage can no "
                "longer be changed.")
    if (booking.payment_status in (PaymentStatus.PAID, PaymentStatus.PARTIALLY_PAID)
            or booking_payment_taken(booking) or booking_has_live_invoice(booking)):
        return ("This booking already has a payment or invoice - its subscription "
                "coverage can no longer be changed.")
    return None


def pricing_change_locked(booking) -> str | None:
    """Reason the booking's PRICE can no longer be changed (promo apply/remove, etc.),
    or None if still mutable. Pricing stays adjustable while there's an unpaid balance
    (a promo can discount the outstanding amount); it freezes only once the booking is
    finalised or fully paid — there's then nothing left to discount."""
    if booking.status in _COVERAGE_LOCKED_STATUSES:
        return "This booking is finalised - its pricing can no longer be changed."
    if booking_amount_paid(booking) > 0 and booking_outstanding(booking) <= 0:
        return ("This booking is fully paid - its pricing can no longer be changed. "
                "Issue a refund to make a correction.")
    return None


def sync_booking_payment_status(booking, *, save=True):
    """Reconcile booking.payment_status with the Payment/Invoice ledger so the field
    can't drift from reality. Derived purely from rows: fully paid => PAID, part
    paid => PARTIALLY_PAID, nothing paid => PENDING (or COVERED / NO_PAYMENT_REQUIRED
    for a 0-payable booking). Unlike Booking.sync_payment_status this CAN step down
    (e.g. a refund that removed all captured money, or add-ons that raised the total
    above what was paid)."""
    total = Decimal(str(booking.total_amount or 0))
    paid = booking_amount_paid(booking)
    if total <= 0:
        new_status = (PaymentStatus.COVERED if booking.coverage_snapshot
                      else PaymentStatus.NO_PAYMENT_REQUIRED)
    elif paid <= 0:
        new_status = PaymentStatus.PENDING
    elif paid >= total:
        new_status = PaymentStatus.PAID
    else:
        new_status = PaymentStatus.PARTIALLY_PAID
    if booking.payment_status != new_status:
        booking.payment_status = new_status
        if save:
            booking.save(update_fields=["payment_status", "updated_at"])
    return booking.payment_status


@transaction.atomic
def settle_booking_payment(booking, *, method, amount=None, reference="", notes="",
                           request=None, card=None, payer_label=""):
    """Take a payment and raise its paid invoice + receipt for a booking — the one
    path used by manual 'Generate Invoice & Pay', Complete & Pay, the customer
    checkout and each split-payment share.

    Charges the current OUTSTANDING by default (or an explicit `amount`, which may
    not exceed it). Each call maps one payment to one invoice covering only that
    increment, so later add-ons bill the delta with a fresh invoice and nothing is
    ever double-charged or duplicated. Returns (payment, invoice).

    `card` turns this into a real online authorisation through the configured
    provider instead of recording money already collected; a refusal raises
    ValueError carrying the provider's reason, and nothing is written. Keeping
    both modes here is deliberate: there must be exactly one place that decides
    how much may be taken against a booking and what documents that produces.

    `payer_label` names who actually handed the money over when that is not the
    booking's own customer (a friend settling their split share). It is recorded
    on the audit trail only - the Payment still belongs to the booking's customer,
    because the invoice is raised against the booking."""
    from apps.payments import services as pay
    from apps.payments.models import PaymentStatus as PayStatus
    from apps.settings_app.currency import format_currency

    outstanding = booking_outstanding(booking)
    charge = Decimal(str(amount)) if amount is not None else outstanding
    if charge <= 0:
        raise ValueError("This booking is already fully paid - no payment is due.")
    if charge > outstanding:
        raise ValueError(
            f"Amount exceeds the outstanding balance ({format_currency(outstanding, booking.currency)}).")

    if card is not None:
        payment = pay.charge(
            booking.customer, charge, method, booking=booking, request=request,
            card=card)
        if payment.status != PayStatus.PAID:
            # The provider refused. The caller gets the reason to show the payer;
            # the failed Payment row stays as the audit trail of the attempt.
            raise PaymentDeclined(payment.failure_reason
                                  or "The payment could not be completed.",
                                  payment=payment)
    else:
        payment = pay.record_manual_payment(
            customer=booking.customer, amount=charge, method=method, booking=booking,
            reference=reference, notes=notes, request=request)
    invoice = pay.create_invoice(
        booking=booking, payment=payment, amount=charge, request=request)
    sync_booking_payment_status(booking)
    record_booking_event(
        booking, f"Payment recorded - {method} {format_currency(charge, booking.currency)}"
                 f" (Invoice {invoice.number})",
        actor=_actor_or_none(request), event="payment_recorded",
        meta={"invoice": invoice.number, "amount": str(charge),
              "method": method, "currency": booking.currency,
              "payer": payer_label or None,
              "amount_paid": str(booking_amount_paid(booking)),
              "outstanding": str(booking_outstanding(booking))})
    return payment, invoice


def event_source(actor):
    """Who/what drove an action, for the Booking Log: Admin / Staff / Customer /
    System (no actor). Derived from the actor's role."""
    from apps.accounts.models import Role
    if actor is None:
        return "System"
    role = getattr(actor, "role", None)
    if role in (Role.SUPER_ADMIN, Role.ADMIN):
        return "Admin"
    if role == Role.CUSTOMER:
        return "Customer"
    return "Staff"


def record_booking_event(booking, note, *, actor=None, event="", meta=None):
    """Append a non-transition activity entry to the booking timeline (from==to
    current status) - e.g. coverage, payment and invoice events - so the
    full booking journey is visible alongside status transitions. `meta` holds
    structured detail (amounts, old→new); `source` is always recorded."""
    data = {"source": event_source(actor)}
    if meta:
        data.update(meta)
    BookingStatusHistory.objects.create(
        booking=booking, from_status=booking.status, to_status=booking.status,
        changed_by=actor, note=(note or "")[:255], event=event or "", meta=data,
    )
    _refresh_history_cache(booking)


def _refresh_history_cache(booking: Booking) -> None:
    """Drop a stale prefetched `status_history` so a re-serialize of this same
    instance (e.g. in the action's response) reflects the row we just added.
    The caller often holds the booking from a `prefetch_related` queryset, whose
    cache wouldn't otherwise include the new transition."""
    cache = getattr(booking, "_prefetched_objects_cache", None)
    if cache:
        cache.pop("status_history", None)


def finalize_booking_finance(booking: Booking, *, request=None):
    """Auto-finance a completed booking: ensure its invoice exists, and issue the
    receipt when the booking is paid. Idempotent and safe to re-run (e.g. on
    reopen → complete). Refunds remain available afterwards via a credit note.

    Respects the booking's payment status — the invoice is always raised, but the
    receipt is only issued once the booking is marked Paid (or a paid payment is
    on file). Works for customer and walk-in (B2C) bookings alike.
    """
    from decimal import Decimal

    from apps.payments import services as pay
    from apps.payments.models import Invoice, InvoiceStatus, Payment
    from apps.payments.models import PaymentStatus as PayStatus

    if not booking.total_amount or Decimal(booking.total_amount) <= 0:
        return None

    dead = [InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED]
    invoice = (Invoice.objects.filter(booking=booking)
               .exclude(status__in=dead).order_by("-issued_at").first())
    paid_payment = (Payment.objects
                    .filter(booking=booking, status=PayStatus.PAID).first())

    if invoice is None:
        link = (Payment.objects
                .filter(booking=booking, status=PayStatus.PAID, invoice__isnull=True)
                .first())
        invoice = pay.create_invoice(booking=booking, payment=link, request=request)

    # Settle + receipt if the booking is paid but the invoice isn't yet.
    booking_paid = booking.payment_status == PaymentStatus.PAID or paid_payment is not None
    if invoice.status == InvoiceStatus.ISSUED and booking_paid:
        pay.mark_invoice_paid(invoice, paid_payment, request=request)
    # Loyalty: award points for the completed + paid booking (idempotent, fail-safe).
    if booking_paid:
        try:
            from apps.loyalty.services import award_loyalty_for_booking
            actor = getattr(request, "user", None) if request is not None else None
            award_loyalty_for_booking(booking, actor=actor, request=request)
        except Exception:  # pragma: no cover - loyalty must never break finance
            logger.exception("loyalty award failed for booking %s", booking.id)
    return invoice


_TERMINAL = {BookingStatus.COMPLETED, BookingStatus.CANCELLED, BookingStatus.NO_SHOW}


@transaction.atomic
def reopen_booking(booking: Booking, *, actor=None, note="", request=None) -> Booking:
    """Revert a terminal booking (completed/cancelled/no-show) to its prior
    active status — an authorised correction for a mistaken close.

    Bypasses the forward-transition guard by design. Raises ValueError if the
    booking isn't in a terminal state.
    """
    current = booking.status
    if current not in _TERMINAL:
        raise ValueError("Only completed, cancelled, or no-show bookings can be reopened.")

    # Restore the status held just before it became terminal, else a sane default.
    last = booking.status_history.order_by("-created_at").first()
    target = last.from_status if last else ""
    if target in ("", *_TERMINAL):
        target = (BookingStatus.IN_PROGRESS if current == BookingStatus.COMPLETED
                  else BookingStatus.BOOKED)

    booking.status = target
    if current == BookingStatus.COMPLETED:
        booking.completed_at = None
    elif current == BookingStatus.CANCELLED:
        booking.cancelled_at = None
        booking.cancellation_reason = ""
    booking.save()

    BookingStatusHistory.objects.create(
        booking=booking,
        from_status=current,
        to_status=target,
        changed_by=actor,
        note=(note[:255] or "Reopened"),
    )
    _refresh_history_cache(booking)

    # Un-completing a booking returns any membership usage it had consumed.
    from apps.payments.services import restore_for_booking
    restore_for_booking(booking, request=request)
    # Re-derive payment status from the (still-standing) invoice/payment rows — a
    # reopened booking must reflect real money, not silently reset to pending.
    sync_booking_payment_status(booking)
    return booking


# --------------------------------------------------------------------------- #
# Recurrence
# --------------------------------------------------------------------------- #
RECURRENCE_DELTA = {
    RecurrenceRule.WEEKLY: timedelta(days=7),
    RecurrenceRule.FORTNIGHTLY: timedelta(days=14),
}


@transaction.atomic
def generate_recurrences(booking: Booking, occurrences: int) -> list[Booking]:
    """Clone a booking forward N times on its recurrence cadence.

    Children copy the catalogue selection + price snapshot and point back at the
    parent. Returns the created children.
    """
    delta = RECURRENCE_DELTA.get(booking.recurrence)
    if not delta or occurrences < 1:
        return []

    children = []
    base_date = booking.scheduled_date
    addons = list(booking.add_ons.all())
    for i in range(1, occurrences + 1):
        child = Booking(
            customer=booking.customer,
            facility_category=booking.facility_category,
            facility_type=booking.facility_type,
            club=booking.club,
            facility=booking.facility,
            scheduled_date=base_date + delta * i,
            scheduled_time=booking.scheduled_time,
            duration_minutes=booking.duration_minutes,
            currency=booking.currency,
            base_amount=booking.base_amount,
            addons_amount=booking.addons_amount,
            discount_amount=booking.discount_amount,
            tax_amount=booking.tax_amount,
            total_amount=booking.total_amount,
            recurrence=RecurrenceRule.NONE,
            parent_booking=booking,
            customer_notes=booking.customer_notes,
            created_by=booking.created_by,
        )
        child.save()
        if addons:
            child.add_ons.set(addons)
        children.append(child)
    return children
