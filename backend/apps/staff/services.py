"""Staff weekly shift schedule — resolution + validation.

The employee schedule reuses the business-hours JSON shape and the ONE schedule
engine in `apps.settings_app.schedule`. An employee's own `shift_hours` is a
complete week and wins outright when set; otherwise the club/organization
pattern is resolved by that engine, so a roster and the slot engine can never
disagree about when a venue is open.
"""

from datetime import time

from rest_framework import serializers

from apps.settings_app import schedule as sched
from apps.settings_app.models import BOOKING_DAY_KEYS, normalize_day


def staff_subject(user):
    """Audit subject ("staff", id) for a user that has a staff profile, else None.
    Lets cross-module events (account/role/assignment changes) appear on the
    employee's Activity Log without forking the audit system."""
    if user is None or not getattr(user, "pk", None):
        return None
    from .models import StaffProfile
    sid = StaffProfile.objects.filter(user=user).values_list("id", flat=True).first()
    return ("staff", sid) if sid else None


def normalized_week(raw):
    """Coerce a raw weekly dict into a full, normalized week (all 7 days)."""
    raw = raw or {}
    return {d: normalize_day(raw.get(d)) for d in BOOKING_DAY_KEYS}


def _week_from_effective(club=None):
    """The schedule engine's effective week, in the roster's day shape."""
    return {key: normalize_day(cfg)
            for key, cfg in sched.effective_week(club=club).items()}


def resolve_staff_schedule(staff):
    """Return ``(week, source)`` using the Employee -> Club -> Organization
    fallback. ``source`` is one of "employee" / "club" / "organization".

    Only the employee's own row is a whole-week override; below that the shared
    schedule engine resolves PER DAY, so an employee at a club that overrides
    only Friday still follows the organization Monday to Thursday.
    """
    emp = staff.shift_hours or {}
    if emp:
        return normalized_week(emp), "employee"

    club = staff.base_club
    if club is not None and (getattr(club, "booking_hours", None) or {}):
        return _week_from_effective(club), "club"
    return _week_from_effective(club), "organization"


def club_week(staff):
    """The club's effective weekly schedule, for display + 'copy from club'."""
    return _week_from_effective(staff.base_club)


def organization_week():
    """The organization's weekly schedule, for display + 'copy from'."""
    return _week_from_effective()


def _parse(hhmm):
    """'HH:MM' -> time, or None when invalid."""
    try:
        return time.fromisoformat(hhmm)
    except (TypeError, ValueError):
        return None


def validate_shift_hours(raw):
    """Validate + clean a weekly employee schedule.

    Delegates to the shared schedule validator so a roster and a venue's
    business hours are held to the same rules, and re-raises as a DRF error
    keyed by weekday. The one roster-specific difference: an "open" day with no
    shifts means the employee simply is not working, rather than an error.
    """
    try:
        return sched.validate_week(raw, require_shift_when_open=False)
    except sched.ScheduleValidationError as exc:
        raise serializers.ValidationError(
            {day: msgs[0] if isinstance(msgs, (list, tuple)) else msgs
             for day, msgs in exc.message_dict.items()}) from exc


# --------------------------------------------------------------------------- #
# Assignment availability (shift schedule + facility status)
# --------------------------------------------------------------------------- #
# Enforced at every point that puts a staff member (or facility) on a booking:
# the booking `assign` action and the club-transfer reassignment plan. A staff
# member is assignable only when scheduled to work then (effective Employee ->
# Club -> Organization schedule), is marked available, has an active account, and
# is not already on an overlapping booking; a facility must be active, belong to
# the booking's club, and be free at that time.

def schedule_covers(staff_profile, on_date, at_time) -> bool:
    """True when the worker's effective weekly schedule has an open shift that
    covers ``at_time`` on ``on_date``'s weekday (and that day is not closed)."""
    week, _src = resolve_staff_schedule(staff_profile)
    day = week.get(BOOKING_DAY_KEYS[on_date.weekday()]) or {}
    if day.get("closed"):
        return False
    for sh in day.get("shifts", []):
        o, c = _parse(sh.get("open")), _parse(sh.get("close"))
        if o and c and o <= at_time < c:
            return True
    return False


def _slots_overlap(on_date, t1, dur1, t2, dur2) -> bool:
    """Whether [t1, t1+dur1) and [t2, t2+dur2) overlap on the same day."""
    from datetime import datetime, timedelta
    s1 = datetime.combine(on_date, t1); e1 = s1 + timedelta(minutes=dur1 or 0)
    s2 = datetime.combine(on_date, t2); e2 = s2 + timedelta(minutes=dur2 or 0)
    return s1 < e2 and s2 < e1


def check_worker_availability(user, *, on_date, at_time, duration=0, exclude_booking_id=None):
    """Return ``(ok, reason)`` for assigning ``user`` to work at ``on_date`` /
    ``at_time``. ``reason`` is a specific, user-facing message on the first
    failure (deactivated account, marked unavailable, not scheduled, or already
    on an overlapping booking). A staff user with no profile has no schedule to
    violate, so only the account-active and double-booking checks apply."""
    from apps.bookings.models import ACTIVE_STATUSES, Booking
    from .models import StaffProfile

    if user is None:
        return False, "Select a worker to assign."
    name = user.full_name
    if not user.is_active:
        return False, f"{name} is a deactivated account and can't be assigned."

    profile = StaffProfile.objects.filter(user=user).select_related("base_club").first()
    if profile:
        if not profile.is_available:
            return False, f"{name} is marked unavailable for new assignments."
        if not schedule_covers(profile, on_date, at_time):
            return False, (
                f"{name} is not scheduled to work at {at_time.strftime('%H:%M')} "
                f"on {on_date.strftime('%a %d %b %Y')}.")

    clash = Booking.objects.filter(
        assigned_to=user, scheduled_date=on_date, status__in=ACTIVE_STATUSES)
    if exclude_booking_id:
        clash = clash.exclude(pk=exclude_booking_id)
    for b in clash.only("id", "reference", "scheduled_time", "duration_minutes"):
        if _slots_overlap(on_date, at_time, duration, b.scheduled_time, b.duration_minutes):
            return False, f"{name} is already assigned to booking {b.reference} at that time."
    return True, ""


def check_facility_availability(facility, *, club, on_date, at_time, duration=0,
                                facility_type=None, exclude_booking_id=None):
    """Return ``(ok, reason)`` for using ``facility`` at ``on_date`` / ``at_time``.

    ``facility`` None (no specific facility pinned) is always OK. Rejects an
    inactive facility, one at another club, one that cannot host the booked
    facility type, one out for maintenance, and one already taken by an
    overlapping booking."""
    from apps.bookings.models import ACTIVE_STATUSES, Booking
    from apps.facilities.models import MaintenanceBlock

    if facility is None:
        return True, ""
    if not facility.is_active:
        return False, f"Facility {facility.name} is inactive and can't be used."
    if club is not None and facility.club_id != club.id:
        return False, f"Facility {facility.name} does not belong to {club.name}."
    if facility_type is not None and not facility.serves(facility_type):
        return False, (f"{facility.name} cannot be booked as {facility_type.name}.")

    from apps.bookings.services import interval_for
    window = interval_for(at_time, duration or 0)
    for block in MaintenanceBlock.objects.filter(
            facility=facility, start_date__lte=on_date, end_date__gte=on_date):
        if window is None or block.covers(on_date, window[0], window[1]):
            reason = f" ({block.reason})" if block.reason else ""
            return False, f"{facility.name} is out for maintenance then{reason}."

    clash = Booking.objects.filter(
        facility=facility, scheduled_date=on_date, status__in=ACTIVE_STATUSES)
    if exclude_booking_id:
        clash = clash.exclude(pk=exclude_booking_id)
    for b in clash.only("id", "reference", "scheduled_time", "duration_minutes"):
        if _slots_overlap(on_date, at_time, duration, b.scheduled_time, b.duration_minutes):
            return False, f"Facility {facility.name} is already booked for {b.reference} at that time."
    return True, ""


def reassign_plan_conflicts(plan):
    """Availability conflicts in a transfer reassignment plan. Returns a list of
    ``(kind, record_id, reason)`` for chosen staff who aren't available for the
    booking they'd take over. Missing records are skipped (the executor skips
    them too)."""
    from django.contrib.auth import get_user_model
    from apps.accounts.models import STAFF_ROLES
    from apps.bookings.models import Booking

    User = get_user_model()
    out = []
    for bid, uid in (plan.get("bookings") or {}).items():
        worker = User.objects.filter(pk=uid, role__in=STAFF_ROLES).first()
        booking = Booking.objects.filter(pk=bid).first()
        if not worker or not booking:
            continue
        ok, why = check_worker_availability(
            worker, on_date=booking.scheduled_date, at_time=booking.scheduled_time,
            duration=booking.duration_minutes, exclude_booking_id=booking.id)
        if not ok:
            out.append(("bookings", str(bid), why))
    return out


# --------------------------------------------------------------------------- #
# Club transfer (maker-checker)
# --------------------------------------------------------------------------- #
from django.db import transaction  # noqa: E402


def _transfer_audit(request, event, summary, subject, actor):
    """Audit a transfer step — via the request when available, else as a system
    event (scheduled/command activation has no request)."""
    from apps.auditlogs.services import log_event, log_system_event
    if request is not None:
        log_event(request, event, summary, subject=subject, actor=actor)
    else:
        log_system_event(event, summary, subject=subject, actor=actor)


def transfer_impact(staff):
    """Records a transfer would touch: future bookings and upcoming (date-based)
    shifts - counts + lists for the impact summary."""
    from datetime import date as _date
    from apps.bookings.models import ACTIVE_STATUSES, Booking

    today = _date.today()
    bookings = list(
        Booking.objects.filter(
            assigned_to=staff.user_id, status__in=ACTIVE_STATUSES,
            scheduled_date__gte=today)
        .order_by("scheduled_date", "scheduled_time")
        .values("id", "reference", "scheduled_date", "status"))
    shifts = list(
        staff.shifts.filter(date__gte=today, is_active=True)
        .order_by("date", "start_time")
        .values("id", "date", "start_time", "end_time"))
    return {
        "bookings": bookings, "shifts": shifts,
        "counts": {"bookings": len(bookings), "shifts": len(shifts)},
    }


def validate_transfer(staff, to_club, effective_date):
    """Enforce the transfer rules (inactive/same club, before-hire date,
    duplicate pending). Raises serializers.ValidationError({field: msg})."""
    from .models import StaffClubTransfer, TransferStatus

    errs = {}
    if to_club is None:
        errs["to_club"] = "Select a destination club."
    else:
        if not to_club.is_active:
            errs["to_club"] = "The destination club is inactive."
        elif staff.base_club_id and to_club.id == staff.base_club_id:
            errs["to_club"] = "The employee is already based at this club."
    if effective_date is None:
        errs["effective_date"] = "Select an effective date."
    elif staff.hired_on and effective_date < staff.hired_on:
        errs["effective_date"] = "Effective date can't be before the hire date."
    if staff.transfers.filter(
            status__in=[TransferStatus.PENDING, TransferStatus.APPROVED]).exists():
        errs["status"] = "There is already a pending or scheduled transfer for this employee."
    if errs:
        raise serializers.ValidationError(errs)


def _execute_reassign(transfer, *, request, actor):
    """Reassign the chosen future bookings to the chosen replacement staff
    (manual plan). Empty plan = keep existing. Each move is audited (tagged to
    the new staff member)."""
    from django.contrib.auth import get_user_model
    from apps.accounts.models import STAFF_ROLES
    from apps.bookings import services as booking_services
    from apps.bookings.models import Booking

    User = get_user_model()
    plan = transfer.reassign_plan or {}

    for bid, uid in (plan.get("bookings") or {}).items():
        worker = User.objects.filter(pk=uid, role__in=STAFF_ROLES).first()
        booking = Booking.objects.filter(pk=bid).first()
        if worker and booking:
            booking.assigned_to = worker
            booking.save(update_fields=["assigned_to", "updated_at"])
            booking_services.record_booking_event(
                booking, f"Reassigned to {worker.full_name} (club transfer)", actor=actor)
            _transfer_audit(request, "booking_reassigned",
                            {"reference": booking.reference, "worker": worker.email},
                            staff_subject(worker), actor)


@transaction.atomic
def complete_transfer(transfer, *, request=None, actor=None):
    """Apply an approved transfer: move the club, apply the shift option,
    execute the reassignment plan, mark completed. Audited. Historical records
    are never rewritten."""
    from django.utils import timezone
    from .models import ShiftOption, TransferStatus

    staff = transfer.staff
    actor = actor or getattr(request, "user", None)

    transfer.from_club = transfer.from_club or staff.base_club
    staff.base_club = transfer.to_club
    if transfer.shift_option == ShiftOption.APPLY_CLUB:
        staff.shift_hours = {}   # inherit the destination club schedule
    # retain / configure: keep the current schedule (configure = edit later)
    staff.save(update_fields=["base_club", "shift_hours", "updated_at"])

    _execute_reassign(transfer, request=request, actor=actor)

    transfer.status = TransferStatus.COMPLETED
    transfer.completed_at = timezone.now()
    transfer.save(update_fields=["status", "completed_at", "from_club"])
    _transfer_audit(request, "staff_branch_transfer_completed",
                    {"staff": staff.employee_id, "to": transfer.to_club.name},
                    ("staff", staff.id), actor)
    return transfer


def activate_due_transfers():
    """Complete every approved+scheduled transfer whose effective date has
    arrived. Returns the number activated. Safe to run repeatedly (cron/command
    or lazily on staff fetch)."""
    from datetime import date as _date
    from .models import StaffClubTransfer, TransferStatus

    n = 0
    due = (StaffClubTransfer.objects
           .filter(status=TransferStatus.APPROVED, effective_date__lte=_date.today())
           .select_related("staff", "to_club", "approved_by"))
    for t in due:
        complete_transfer(t, request=None, actor=t.approved_by)
        n += 1
    return n
