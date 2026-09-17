"""The one scheduling engine: Organization -> Club -> Facility.

Everything that needs to know "when is this bookable?" resolves it here. The
booking slot engine, the staff roster and the admin API all call into this
module rather than reading `booking_hours` themselves, so there is exactly one
definition of how inheritance, breaks and exceptions combine.

STORAGE
    The weekly pattern is a JSON document on each scope::

        {mon..sun: {closed: bool,
                    shifts: [{open: "HH:MM", close: "HH:MM"}],
                    breaks: [{name, open: "HH:MM", close: "HH:MM"}]}}

    held on `Organization.booking_hours`, `Club.booking_hours` and
    `Facility.booking_hours`. Alongside it each scope carries `slot_minutes`
    and the booking buffers, null/blank meaning "inherit".

INHERITANCE
    Resolution is PER DAY, not per week. A club storing only ``{"thu": ...}``
    overrides Thursday and inherits the rest from the organization; a facility
    storing only ``{"fri": ...}`` overrides Friday and inherits the rest from
    its club. Nothing is ever copied into a child record, so changing the
    organization's Monday moves every scope that has not overridden Monday.

PRIORITY (lowest to highest)
    organization weekly -> club weekly -> facility weekly -> date exception

    A `ScheduleException` covering the date replaces the weekday pattern
    outright (closed, or its own shifts/breaks). Facility maintenance blocks and
    existing bookings are NOT handled here: they remove capacity from individual
    slots rather than changing the operating pattern, and stay in the booking
    slot engine where capacity lives.

OVERNIGHT
    A shift whose close is at or before its open (``18:00-02:00``) runs into the
    following calendar day. `resolve_for_date` returns such a shift split into
    the part that falls on the requested date, so callers never deal with times
    past midnight. See `day_windows`.
"""

from dataclasses import dataclass, field
from datetime import date as date_cls, datetime, time, timedelta

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Q

from .models import BOOKING_DAY_KEYS, Organization, default_booking_hours, normalize_day

# Weekday index (Monday = 0, matching `date.weekday()`) -> JSON key.
DAY_KEYS = BOOKING_DAY_KEYS

SCOPE_ORGANIZATION = "organization"
SCOPE_CLUB = "club"
SCOPE_FACILITY = "facility"

# Used only when nothing at all is configured - a brand-new install.
FALLBACK_SHIFT = (time(8, 0), time(20, 0))
FALLBACK_SLOT_MINUTES = 60

_MIDNIGHT = time(0, 0)
_EPOCH = date_cls(2000, 1, 1)


# --------------------------------------------------------------------------- #
# Small time helpers. Minutes-past-midnight is the working unit: it makes
# overlap and overnight arithmetic obvious, and converts back losslessly.
# --------------------------------------------------------------------------- #
def parse_time(value):
    """'HH:MM' (or 'HH:MM:SS') -> time; None when unusable."""
    if isinstance(value, time):
        return value
    try:
        return time.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def to_minutes(value) -> int | None:
    t = parse_time(value)
    return None if t is None else t.hour * 60 + t.minute


def from_minutes(total: int) -> time:
    """Minutes past midnight -> time, wrapping past 24h back into the day."""
    total %= 24 * 60
    return time(total // 60, total % 60)


def fmt(value) -> str:
    t = parse_time(value)
    return "" if t is None else f"{t.hour:02d}:{t.minute:02d}"


def spans_midnight(open_t, close_t) -> bool:
    """True when this window runs into the next calendar day.

    `close == open` means a full 24 hours, not a zero-length window - a facility
    open around the clock is written ``00:00-00:00``.
    """
    o, c = to_minutes(open_t), to_minutes(close_t)
    return o is not None and c is not None and c <= o


def overlaps(a_start, a_end, b_start, b_end) -> bool:
    """Half-open overlap on minute values: [a_start, a_end) vs [b_start, b_end)."""
    return a_start < b_end and b_start < a_end


# --------------------------------------------------------------------------- #
# The resolved shape callers work with
# --------------------------------------------------------------------------- #
@dataclass
class Window:
    """One operating or break period, in minutes past midnight of its own day.

    `end` may exceed 24*60 for an overnight window, so the pair always satisfies
    `start < end` and ordinary interval maths works without special cases.
    """

    start: int
    end: int

    @property
    def start_time(self) -> time:
        return from_minutes(self.start)

    @property
    def end_time(self) -> time:
        return from_minutes(self.end)

    @property
    def minutes(self) -> int:
        return self.end - self.start

    def as_pair(self) -> tuple[time, time]:
        return self.start_time, self.end_time


@dataclass
class ResolvedDay:
    """The effective operating pattern for one date at one scope."""

    closed: bool = False
    shifts: list[Window] = field(default_factory=list)
    breaks: list[Window] = field(default_factory=list)
    slot_minutes: int = FALLBACK_SLOT_MINUTES
    buffer_before: int = 0
    buffer_after: int = 0
    # Where the weekday pattern came from, for the "Inherited / Custom" badge.
    source: str = SCOPE_ORGANIZATION
    # Name of the ScheduleException in force, when one replaced the weekday.
    exception: str | None = None

    @property
    def is_open(self) -> bool:
        return not self.closed and bool(self.shifts)


# --------------------------------------------------------------------------- #
# Reading a stored week
# --------------------------------------------------------------------------- #
def normalized_week(raw) -> dict:
    """Coerce a raw weekly dict into a full, normalized seven-day week."""
    raw = raw or {}
    return {d: normalize_day(raw.get(d)) for d in DAY_KEYS}


def day_key(on_date) -> str:
    return DAY_KEYS[on_date.weekday()]


def _chain(club=None, facility=None, *, org=None):
    """The scopes to consult, most specific first, each as (name, weekly, obj).

    A facility implies its club even when the caller did not pass one, so a
    facility is never resolved against the wrong club's hours. Pass `org` to
    reuse an already-loaded row: a single resolution asks several questions of
    the same chain and must not re-read the organization for each.
    """
    org = org or Organization.get_solo()
    if facility is not None and club is None:
        club = facility.club

    chain = []
    if facility is not None:
        chain.append((SCOPE_FACILITY, getattr(facility, "booking_hours", None) or {}, facility))
    if club is not None:
        chain.append((SCOPE_CLUB, getattr(club, "booking_hours", None) or {}, club))
    chain.append((SCOPE_ORGANIZATION, org.booking_hours or default_booking_hours(), org))
    return chain


def _day_from_chain(chain, key) -> tuple[dict, str]:
    for scope, weekly, _obj in chain:
        cfg = (weekly or {}).get(key)
        if cfg is not None:
            return normalize_day(cfg), scope
    return {"closed": False, "shifts": [], "breaks": []}, SCOPE_ORGANIZATION


def _slot_minutes_from_chain(chain) -> tuple[int, str]:
    for scope, _weekly, obj in chain:
        value = getattr(obj, "slot_minutes", None)
        if value:
            return int(value), scope
    return FALLBACK_SLOT_MINUTES, SCOPE_ORGANIZATION


def _buffers_from_chain(chain) -> tuple[int, int]:
    for _scope, _weekly, obj in chain:
        before = getattr(obj, "buffer_before_minutes", None)
        after = getattr(obj, "buffer_after_minutes", None)
        if before or after:
            return int(before or 0), int(after or 0)
    return 0, 0


def resolve_day_config(key, club=None, facility=None) -> tuple[dict, str]:
    """The winning config for one weekday, and which scope supplied it."""
    return _day_from_chain(_chain(club, facility), key)


def resolve_slot_minutes(club=None, facility=None) -> tuple[int, str]:
    """Slot interval and the scope that set it. Zero/None means inherit."""
    return _slot_minutes_from_chain(_chain(club, facility))


def resolve_buffers(club=None, facility=None) -> tuple[int, int]:
    """(before, after) buffer minutes, from the most specific scope that sets
    either. Buffers are taken as a pair so a facility cannot inherit half of
    one rule and half of another."""
    return _buffers_from_chain(_chain(club, facility))


# --------------------------------------------------------------------------- #
# Turning a stored day into windows
# --------------------------------------------------------------------------- #
def _windows(entries) -> list[Window]:
    """Parse [{open, close}] into sorted, valid windows. Invalid rows drop out;
    validation is the serializer's job, this must never raise mid-booking."""
    out = []
    for item in entries or []:
        start = to_minutes(item.get("open"))
        end = to_minutes(item.get("close"))
        if start is None or end is None:
            continue
        if end <= start:
            end += 24 * 60          # overnight, or a 24-hour day when equal
        out.append(Window(start, end))
    out.sort(key=lambda w: w.start)
    return out


def day_windows(cfg) -> tuple[list[Window], list[Window]]:
    """(shifts, breaks) for a normalized day config."""
    nd = normalize_day(cfg)
    if nd["closed"]:
        return [], []
    return _windows(nd["shifts"]), _windows(nd["breaks"])


def resolve_for_date(on_date, club=None, facility=None, *,
                     include_previous_overnight=True) -> ResolvedDay:
    """The effective operating pattern for a specific date.

    Applies, in order: the weekday pattern from the most specific scope, then
    any `ScheduleException` covering the date (which replaces it outright).

    When `include_previous_overnight` is set, the tail of the previous day's
    overnight shift is folded in as a window starting at 00:00, so a club open
    ``18:00-02:00`` genuinely offers slots at 00:30 the following morning.

    Costs two queries regardless of how much is configured: one for the
    organization row, one covering both dates' exceptions.
    """
    previous = on_date - timedelta(days=1)
    chain = _chain(club, facility)
    exceptions = _exceptions_between(previous, on_date, club, facility)

    slot_minutes, _ = _slot_minutes_from_chain(chain)
    before, after = _buffers_from_chain(chain)

    def config_for(date_value):
        """(day config, source, exception) for one date."""
        found = exceptions.get(date_value)
        if found is not None:
            return found.as_day_config(), found.scope, found
        cfg, source = _day_from_chain(chain, day_key(date_value))
        return cfg, source, None

    cfg, source, exception = config_for(on_date)
    shifts, breaks = day_windows(cfg)

    if exception is not None:
        return ResolvedDay(
            closed=bool(cfg.get("closed")) or not shifts,
            shifts=shifts, breaks=breaks,
            slot_minutes=exception.slot_minutes or slot_minutes,
            buffer_before=before, buffer_after=after,
            source=source, exception=exception.name,
        )

    if include_previous_overnight:
        prev_cfg, _prev_source, _prev_exc = config_for(previous)
        tail_shifts, tail_breaks = _rebase_overnight(prev_cfg)
        shifts = sorted(shifts + tail_shifts, key=lambda w: w.start)
        breaks = sorted(breaks + tail_breaks, key=lambda w: w.start)

    # Closed means "nothing can be booked", which is decided by the windows that
    # survived - not by the day's own flag. A day marked closed still honours the
    # tail of the previous night's overnight session: the venue really is open,
    # it simply starts no new session of its own.
    return ResolvedDay(
        closed=not shifts,
        shifts=shifts, breaks=breaks,
        slot_minutes=slot_minutes,
        buffer_before=before, buffer_after=after,
        source=source,
    )


def _rebase_overnight(prev_cfg) -> tuple[list[Window], list[Window]]:
    """The part of a previous day's config that spills past midnight, rebased
    onto the following date: 18:00-02:00 yesterday becomes 00:00-02:00 today.
    """
    shifts, breaks = day_windows(prev_cfg)
    day = 24 * 60

    def rebase(windows):
        return [Window(max(0, w.start - day), w.end - day)
                for w in windows if w.end > day]

    return rebase(shifts), rebase(breaks)


# --------------------------------------------------------------------------- #
# Exceptions (special dates). Imported lazily: this module is imported from
# model modules, and ScheduleException lives alongside them.
# --------------------------------------------------------------------------- #
def _exceptions_between(first, last, club=None, facility=None, *,
                        exclude_id=None) -> dict:
    """{date: winning exception} for each date in [first, last], in ONE query.

    `exclude_id` answers "what would apply if this row were not there?", which
    is what the removal preview needs in order to warn before a special date is
    deleted.
    """
    from .models import ScheduleException

    if facility is not None and club is None:
        club = facility.club

    queryset = (
        ScheduleException.objects
        .filter(is_active=True, start_date__lte=last)
        .filter(Q(end_date__isnull=True, start_date__gte=first)
                | Q(end_date__gte=first))
        .for_scope(club, facility)
    )
    if exclude_id:
        queryset = queryset.exclude(pk=exclude_id)
    rows = list(queryset)
    if not rows:
        return {}

    rank = {SCOPE_FACILITY: 0, SCOPE_CLUB: 1, SCOPE_ORGANIZATION: 2}
    rows.sort(key=lambda r: (rank[r.scope], -r.id))

    out = {}
    cursor = first
    while cursor <= last:
        for row in rows:                       # already most-specific-first
            if row.covers(cursor):
                out[cursor] = row
                break
        cursor += timedelta(days=1)
    return out


def _exception_for(on_date, club=None, facility=None):
    """The most specific enabled exception covering `on_date`, or None."""
    return _exceptions_between(on_date, on_date, club, facility).get(on_date)


# --------------------------------------------------------------------------- #
# Effective week, for the admin "Effective Schedule" preview
# --------------------------------------------------------------------------- #
def effective_week(club=None, facility=None) -> dict:
    """Each weekday's resolved config plus the scope it came from.

    This is what the Club and Facility screens render as the read-only
    "Effective Schedule" table, so the badge shown to an admin and the pattern
    used by the booking engine can never disagree.
    """
    chain = _chain(club, facility)          # one organization read for the week
    out = {}
    for key in DAY_KEYS:
        cfg, source = _day_from_chain(chain, key)
        nd = normalize_day(cfg)
        out[key] = {
            "closed": nd["closed"],
            "shifts": [{"open": fmt(s["open"]), "close": fmt(s["close"])}
                       for s in nd["shifts"]],
            "breaks": [{"name": b.get("name") or "", "open": fmt(b.get("open")),
                        "close": fmt(b.get("close"))} for b in nd["breaks"]],
            "source": source,
            "overnight": any(spans_midnight(s.get("open"), s.get("close"))
                             for s in nd["shifts"]),
        }
    return out


def scope_label(source, club=None, facility=None) -> str:
    """Human wording for an inheritance badge."""
    if source == SCOPE_FACILITY:
        return getattr(facility, "name", "Facility")
    if source == SCOPE_CLUB:
        return getattr(club, "name", None) or getattr(
            getattr(facility, "club", None), "name", "Club")
    return "Organization"


# --------------------------------------------------------------------------- #
# Validation. Used by every serializer that accepts a weekly schedule, so the
# organization, club, facility and staff screens all enforce the same rules.
# --------------------------------------------------------------------------- #
class ScheduleValidationError(DjangoValidationError):
    """Invalid weekly schedule. `.message_dict` is keyed by weekday."""


def validate_week(raw, *, allow_overnight=True, require_shift_when_open=True,
                  require_complete_week=False) -> dict:
    """Validate and clean a weekly schedule.

    Only the weekdays PRESENT in `raw` are checked and returned, which is what a
    club or facility override is. Pass `require_complete_week` for the
    organization, which is the base everything else falls back to and therefore
    cannot leave a day undefined.

    Rules, reported per day so the UI can mark the offending row:
      - every shift and break needs two parseable times;
      - a zero-length shift is rejected (08:00-08:00 means 24 hours, and is
        only accepted as the day's only shift);
      - shifts may not overlap or repeat;
      - a break must sit inside an operating shift, and breaks may not overlap;
      - an open day must have at least one shift.

    Returns the cleaned week. Raises `ScheduleValidationError` on the first
    problem found for each day.
    """
    raw = raw or {}
    errors: dict[str, str] = {}
    cleaned: dict[str, dict] = {}
    day = 24 * 60

    if require_complete_week:
        missing = [k for k in DAY_KEYS if k not in raw]
        if missing:
            raise ScheduleValidationError(
                {k: "Set hours for this day, or mark it closed." for k in missing})

    for key in [k for k in DAY_KEYS if k in raw]:
        nd = normalize_day(raw.get(key))
        if nd["closed"]:
            cleaned[key] = {"closed": True, "shifts": [], "breaks": []}
            continue

        shifts, bad = [], None
        for sh in nd["shifts"]:
            start, end = to_minutes(sh.get("open")), to_minutes(sh.get("close"))
            if start is None or end is None:
                bad = "Enter a valid start and end time."
                break
            if end == start:
                # 00:00-00:00 (or any equal pair) = open around the clock.
                if len(nd["shifts"]) > 1:
                    bad = "A 24-hour shift cannot be combined with another shift."
                    break
                shifts.append(Window(start, start + day))
                continue
            if end < start and not allow_overnight:
                bad = "This schedule cannot run past midnight."
                break
            shifts.append(Window(start, end if end > start else end + day))

        if bad:
            errors[key] = bad
            continue
        if not shifts:
            # A roster treats "open with no shifts" as simply not working; a
            # venue must say so explicitly, or an empty day would silently
            # close the club.
            if require_shift_when_open:
                errors[key] = "Add at least one shift, or mark the day closed."
                continue
            cleaned[key] = {"closed": True, "shifts": [], "breaks": []}
            continue

        shifts.sort(key=lambda w: w.start)
        clash = None
        for i in range(1, len(shifts)):
            prev, cur = shifts[i - 1], shifts[i]
            if cur.start == prev.start and cur.end == prev.end:
                clash = "Remove the duplicate shift."
                break
            if cur.start < prev.end:
                clash = "Shifts on the same day must not overlap."
                break
        # An overnight shift must not wrap round into the day's first shift.
        if clash is None and len(shifts) > 1 and shifts[-1].end > day + shifts[0].start:
            clash = "The overnight shift runs into the next day's first shift."
        if clash:
            errors[key] = clash
            continue

        breaks, bad_break = [], None
        for br in nd["breaks"]:
            start, end = to_minutes(br.get("open")), to_minutes(br.get("close"))
            if start is None or end is None:
                bad_break = "Enter a valid break start and end time."
                break
            if end <= start:
                end += day
            if end - start >= day:
                bad_break = "A break cannot cover the whole day."
                break
            window = Window(start, end)
            if not any(s.start <= window.start and window.end <= s.end for s in shifts):
                bad_break = "A break must fall inside the operating hours."
                break
            breaks.append((window, br.get("name") or ""))

        if bad_break:
            errors[key] = bad_break
            continue

        breaks.sort(key=lambda pair: pair[0].start)
        for i in range(1, len(breaks)):
            if breaks[i][0].start < breaks[i - 1][0].end:
                errors[key] = "Breaks on the same day must not overlap."
                break
        if key in errors:
            continue

        cleaned[key] = {
            "closed": False,
            "shifts": [{"open": fmt(w.start_time),
                        "close": fmt(from_minutes(w.end))} for w in shifts],
            "breaks": [{"name": name, "open": fmt(w.start_time),
                        "close": fmt(from_minutes(w.end))} for w, name in breaks],
        }

    if errors:
        raise ScheduleValidationError(errors)
    return cleaned


def validate_partial_week(raw, **kwargs) -> dict:
    """Validate an OVERRIDE. An empty dict is valid and means "inherit
    everything", which is how a scope is returned to its parent's schedule."""
    kwargs.pop("require_complete_week", None)
    return validate_week(raw or {}, **kwargs)


# --------------------------------------------------------------------------- #
# Timezone. Availability is a wall-clock question: "is it past 9am at the club?"
# --------------------------------------------------------------------------- #
def organization_timezone():
    """The configured Organization timezone as a tzinfo, UTC if unusable."""
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    name = (Organization.get_solo().timezone or "").strip()
    if not name:
        return ZoneInfo("UTC")
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def local_now() -> datetime:
    """'Now' in the organization's own timezone.

    Django's `TIME_ZONE` is UTC and is deliberately left that way so stored
    timestamps stay unambiguous; availability instead asks this, so a club in
    Asia/Dubai stops offering the 08:00 slot at 08:00 local rather than at
    08:00 UTC.
    """
    from django.utils import timezone as dj_timezone

    return dj_timezone.now().astimezone(organization_timezone())


def drf_validate_week(raw, *, partial: bool, **kwargs) -> dict:
    """`validate_week` for DRF serializers, re-raised as a field error.

    `partial=True` checks and stores only the weekdays actually present, which
    is what a club or facility override is: the days it does not mention keep
    inheriting from the parent.
    """
    from rest_framework import serializers as drf

    if partial:
        runner, kwargs = validate_partial_week, kwargs
    else:
        runner = validate_week
        kwargs.setdefault("require_complete_week", True)
    try:
        return runner(raw, **kwargs)
    except ScheduleValidationError as exc:
        raise drf.ValidationError(
            {day: msgs[0] if isinstance(msgs, (list, tuple)) else msgs
             for day, msgs in exc.message_dict.items()}) from exc


def validate_slot_minutes(value, *, allow_blank=True):
    """A slot interval must be a positive number of minutes that divides the
    hour sensibly. Custom values are allowed: the engine only needs > 0."""
    from rest_framework import serializers as drf

    if value in (None, ""):
        if allow_blank:
            return None
        raise drf.ValidationError("Choose a slot duration.")
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        raise drf.ValidationError("Enter the slot duration in minutes.") from None
    if minutes <= 0:
        raise drf.ValidationError("The slot duration must be more than zero minutes.")
    if minutes > 24 * 60:
        raise drf.ValidationError("The slot duration cannot exceed 24 hours.")
    return minutes


# --------------------------------------------------------------------------- #
# Protecting bookings that already exist
# --------------------------------------------------------------------------- #
# Bookings a customer is actually holding. Cancelled, completed and no-show
# rows cannot be stranded by a schedule change, so they are never reported.
LIVE_BOOKING_STATUSES = ["booked", "confirmed", "assigned", "arrived", "in_progress"]


def _live_bookings(dates, club=None, facility=None, *, limit=50):
    from apps.bookings.models import Booking

    qs = Booking.objects.filter(
        scheduled_date__in=list(dates), status__in=LIVE_BOOKING_STATUSES)
    if facility is not None:
        qs = qs.filter(facility=facility)
    elif club is not None:
        qs = qs.filter(club=club)
    return qs.select_related("club", "facility", "customer").order_by(
        "scheduled_date", "scheduled_time")[:limit + 1]


def _stranding_reason(booking, day) -> str | None:
    """Why `day` would no longer allow `booking`, or None if it still fits."""
    start = to_minutes(booking.scheduled_time)
    if start is None:
        return None
    end = to_minutes(booking.end_time) or start + (booking.duration_minutes or 0)

    inside = any(s.start <= start and end <= s.end for s in day.shifts)
    in_break = any(overlaps(start, end, b.start, b.end) for b in day.breaks)
    if day.closed or not day.shifts:
        return "closed"
    if in_break:
        return "break"
    return None if inside else "outside hours"


def _affected_row(booking, reason) -> dict:
    return {
        "id": booking.id,
        "reference": booking.reference,
        "date": booking.scheduled_date.isoformat(),
        "time": fmt(booking.scheduled_time),
        "customer": (booking.customer.full_name if booking.customer_id
                     else booking.walk_in_name or "Walk-in"),
        "club": booking.club.name if booking.club_id else "",
        "facility": booking.facility.name if booking.facility_id else "",
        "reason": reason,
    }


def bookings_outside_schedule(dates, club=None, facility=None, *, limit=50):
    """Live bookings on `dates` that the CURRENT schedule would no longer allow.

    Changing business hours must never quietly strip a booking a customer is
    holding, so every write that narrows availability calls this and reports
    what it would orphan. It only reports: cancelling or moving a booking stays
    an explicit, permissioned action.
    """
    affected = []
    cache: dict = {}
    for booking in _live_bookings(dates, club, facility, limit=limit):
        key = (booking.scheduled_date, booking.club_id, booking.facility_id)
        if key not in cache:
            cache[key] = resolve_for_date(
                booking.scheduled_date, club=booking.club, facility=booking.facility)
        reason = _stranding_reason(booking, cache[key])
        if reason:
            affected.append(_affected_row(booking, reason))
    return affected


def exception_impact(start, end, *, club=None, facility=None,
                     day_config=None, exclude_id=None, limit=50):
    """Live bookings a special date would strand, measured BEFORE it is saved.

    `day_config` is the proposed pattern (`{closed, shifts, breaks}`) that would
    apply on every date in the range. Passing None instead asks the opposite
    question, "what breaks if this row goes away?", and resolves each date
    normally with `exclude_id` left out.

    Nothing here writes, and the answer is only ever shown to someone already
    allowed to manage that scope's schedule. An administrator is told what a
    closure would cost before choosing to save it, which is the difference
    between an informed decision and a silent one.
    """
    dates = dates_in(start, end)
    if not dates:
        return []

    proposed = None
    if day_config is not None:
        shifts, breaks = day_windows(day_config)
        proposed = ResolvedDay(
            closed=bool(day_config.get("closed")) or not shifts,
            shifts=shifts, breaks=breaks,
            slot_minutes=FALLBACK_SLOT_MINUTES, buffer_before=0, buffer_after=0,
            source=SCOPE_ORGANIZATION,
        )

    affected = []
    cache: dict = {}
    for booking in _live_bookings(dates, club, facility, limit=limit):
        if proposed is not None:
            day = proposed
        else:
            key = (booking.scheduled_date, booking.club_id, booking.facility_id)
            if key not in cache:
                cache[key] = _resolve_without(
                    booking.scheduled_date, booking.club, booking.facility, exclude_id)
            day = cache[key]
        reason = _stranding_reason(booking, day)
        if reason:
            affected.append(_affected_row(booking, reason))
    return affected


def _resolve_without(on_date, club, facility, exclude_id) -> ResolvedDay:
    """`resolve_for_date` as it would read with one exception row removed."""
    exception = _exceptions_between(
        on_date, on_date, club, facility, exclude_id=exclude_id).get(on_date)
    if exception is not None:
        cfg = exception.as_day_config()
    else:
        cfg, _source = resolve_day_config(day_key(on_date), club, facility)
    shifts, breaks = day_windows(cfg)
    return ResolvedDay(
        closed=bool(cfg.get("closed")) or not shifts,
        shifts=shifts, breaks=breaks,
        slot_minutes=FALLBACK_SLOT_MINUTES, buffer_before=0, buffer_after=0,
        source=SCOPE_ORGANIZATION,
    )


def dates_in(start, end=None, *, cap=370):
    """Every date in an inclusive range, capped so a typo cannot walk forever."""
    end = end or start
    out, cursor = [], start
    while cursor <= end and len(out) < cap:
        out.append(cursor)
        cursor += timedelta(days=1)
    return out
