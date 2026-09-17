"""The one schedule engine: inheritance, breaks, exceptions and overnight hours.

Covers the Organization -> Club -> Facility hierarchy end to end. Every test
asserts against `resolve_for_date` / `available_slots` rather than against the
stored JSON, because what matters is the pattern the BOOKING ENGINE ends up
using - a config that reads correctly but resolves wrongly is the bug worth
catching.
"""

from datetime import date, time, timedelta

import pytest

from apps.bookings.services import available_slots
from apps.facilities.models import Facility
from apps.settings_app import schedule as sched
from apps.settings_app.models import Organization, ScheduleException

# A fixed Monday and the rest of that week, so weekday-specific rules are not
# at the mercy of the day the suite happens to run.
MONDAY = date(2026, 9, 21)
TUESDAY = MONDAY + timedelta(days=1)
FRIDAY = MONDAY + timedelta(days=4)
SATURDAY = MONDAY + timedelta(days=5)


def week(**days):
    """A full week of 08:00-22:00, with the named days replaced."""
    base = {d: {"closed": False, "shifts": [{"open": "08:00", "close": "22:00"}]}
            for d in sched.DAY_KEYS}
    base.update(days)
    return base


def day(open_t, close_t, breaks=None):
    return {"closed": False,
            "shifts": [{"open": open_t, "close": close_t}],
            "breaks": breaks or []}


CLOSED = {"closed": True, "shifts": [], "breaks": []}


@pytest.fixture
def org(db):
    o = Organization.get_solo()
    o.slot_minutes = 60
    o.booking_hours = week()
    o.buffer_before_minutes = 0
    o.buffer_after_minutes = 0
    o.save()
    return o


@pytest.fixture
def court(db, club, facility_type):
    f = Facility.objects.create(club=club, name="Court 1")
    f.facility_types.set([facility_type])
    return f


def hours(resolved):
    """Resolved shifts as readable ("HH:MM", "HH:MM") pairs."""
    return [(sched.fmt(w.start_time), sched.fmt(w.end_time)) for w in resolved.shifts]


# --------------------------------------------------------------------------- #
# 1-5: the inheritance hierarchy
# --------------------------------------------------------------------------- #
def test_a_club_inherits_the_organization_schedule(org, club):
    resolved = sched.resolve_for_date(MONDAY, club=club)
    assert hours(resolved) == [("08:00", "22:00")]
    assert resolved.source == sched.SCOPE_ORGANIZATION


def test_a_club_overrides_the_organization(org, club):
    club.booking_hours = week()
    club.booking_hours["mon"] = day("09:00", "23:00")
    club.save()
    resolved = sched.resolve_for_date(MONDAY, club=club)
    assert hours(resolved) == [("09:00", "23:00")]
    assert resolved.source == sched.SCOPE_CLUB


def test_a_facility_inherits_its_club(org, club, court):
    club.booking_hours = {"mon": day("09:00", "23:00")}
    club.save()
    resolved = sched.resolve_for_date(MONDAY, facility=court)
    assert hours(resolved) == [("09:00", "23:00")]
    assert resolved.source == sched.SCOPE_CLUB


def test_a_facility_overrides_one_day_and_inherits_the_rest(org, club, court):
    """The headline case: a unit that differs only on Friday stores only Friday."""
    club.booking_hours = {"mon": day("09:00", "23:00"), "fri": day("09:00", "23:00")}
    club.save()
    court.booking_hours = {"fri": day("14:00", "23:00")}
    court.save()

    friday = sched.resolve_for_date(FRIDAY, facility=court)
    assert hours(friday) == [("14:00", "23:00")]
    assert friday.source == sched.SCOPE_FACILITY

    monday = sched.resolve_for_date(MONDAY, facility=court)
    assert hours(monday) == [("09:00", "23:00")]
    assert monday.source == sched.SCOPE_CLUB


def test_a_facility_can_override_the_entire_week(org, club, court):
    court.booking_hours = week(**{d: day("06:00", "10:00") for d in sched.DAY_KEYS})
    court.save()
    for on_date in (MONDAY, FRIDAY, SATURDAY):
        resolved = sched.resolve_for_date(on_date, facility=court)
        assert hours(resolved) == [("06:00", "10:00")]
        assert resolved.source == sched.SCOPE_FACILITY


def test_nothing_is_copied_into_the_child(org, club, court):
    """Changing the organization moves every scope that has not overridden."""
    court.booking_hours = {"fri": day("14:00", "23:00")}
    court.save()

    org.booking_hours = week(mon=day("07:00", "12:00"))
    org.save()

    assert hours(sched.resolve_for_date(MONDAY, facility=court)) == [("07:00", "12:00")]
    # The facility's own Friday is untouched by the organization change.
    assert hours(sched.resolve_for_date(FRIDAY, facility=court)) == [("14:00", "23:00")]


def test_clearing_an_override_returns_the_scope_to_inherited(org, club):
    club.booking_hours = {"mon": day("09:00", "23:00")}
    club.save()
    assert sched.resolve_for_date(MONDAY, club=club).source == sched.SCOPE_CLUB

    club.booking_hours = {}
    club.save()
    resolved = sched.resolve_for_date(MONDAY, club=club)
    assert resolved.source == sched.SCOPE_ORGANIZATION
    assert hours(resolved) == [("08:00", "22:00")]


def test_a_facility_resolves_against_its_own_club_even_when_none_is_passed(org, club, court):
    club.booking_hours = {"mon": day("10:00", "12:00")}
    club.save()
    assert hours(sched.resolve_for_date(MONDAY, facility=court)) == [("10:00", "12:00")]


# --------------------------------------------------------------------------- #
# 6-10: shifts and breaks
# --------------------------------------------------------------------------- #
def test_multiple_shifts_in_one_day(org, club):
    club.booking_hours = {"mon": {"closed": False, "shifts": [
        {"open": "08:00", "close": "12:00"}, {"open": "16:00", "close": "22:00"}]}}
    club.save()
    assert hours(sched.resolve_for_date(MONDAY, club=club)) == [
        ("08:00", "12:00"), ("16:00", "22:00")]


def test_a_break_inside_a_shift_removes_those_slots(org, club, court, facility_type):
    club.booking_hours = {"mon": day("08:00", "14:00",
                                     breaks=[{"name": "Maintenance",
                                              "open": "11:00", "close": "12:00"}])}
    club.save()
    times = [s["time"] for s in available_slots(MONDAY, club=club,
                                                facility_type=facility_type)]
    assert "10:00" in times
    assert "11:00" not in times          # sits inside the break
    assert "12:00" in times              # resumes right after it


def test_multiple_breaks_in_one_day(org, club, court, facility_type):
    club.booking_hours = {"mon": day("08:00", "20:00", breaks=[
        {"name": "Lunch", "open": "13:00", "close": "14:00"},
        {"name": "Clean", "open": "18:00", "close": "19:00"}])}
    club.save()
    times = [s["time"] for s in available_slots(MONDAY, club=club,
                                                facility_type=facility_type)]
    assert "13:00" not in times
    assert "18:00" not in times
    assert {"12:00", "14:00", "17:00", "19:00"} <= set(times)


def test_a_recurring_break_can_apply_to_every_day(org, club, court, facility_type):
    """A 'global' break is the same break written on each day it applies to -
    one representation, so resolution never has to merge two sources."""
    lunch = [{"name": "Daily maintenance", "open": "13:00", "close": "14:00"}]
    club.booking_hours = {d: day("08:00", "20:00", breaks=lunch) for d in sched.DAY_KEYS}
    club.save()
    for on_date in (MONDAY, FRIDAY, SATURDAY):
        times = [s["time"] for s in available_slots(on_date, club=club,
                                                    facility_type=facility_type)]
        assert "13:00" not in times


def test_a_friday_only_break(org, club, court, facility_type):
    club.booking_hours = {
        "fri": day("08:00", "20:00", breaks=[{"name": "Prayer", "open": "12:00",
                                              "close": "13:30"}])}
    club.save()
    friday = [s["time"] for s in available_slots(FRIDAY, club=club,
                                                 facility_type=facility_type)]
    monday = [s["time"] for s in available_slots(MONDAY, club=club,
                                                 facility_type=facility_type)]
    assert "12:00" not in friday
    assert "12:00" in monday


def test_a_facility_break_does_not_leak_to_its_siblings(org, club, court,
                                                         facility_type):
    other = Facility.objects.create(club=club, name="Court 2")
    other.facility_types.set([facility_type])
    court.booking_hours = {"mon": day("08:00", "20:00",
                                      breaks=[{"name": "Repair", "open": "14:00",
                                               "close": "15:00"}])}
    court.save()

    assert any(sched.overlaps(840, 900, b.start, b.end)
               for b in sched.resolve_for_date(MONDAY, facility=court).breaks)
    assert sched.resolve_for_date(MONDAY, facility=other).breaks == []


# --------------------------------------------------------------------------- #
# 11-12: special dates
# --------------------------------------------------------------------------- #
def test_a_special_date_can_close_the_day(org, club, court, facility_type):
    ScheduleException.objects.create(name="National Day", club=club,
                                     start_date=MONDAY, closed=True)
    resolved = sched.resolve_for_date(MONDAY, club=club)
    assert resolved.closed is True
    assert resolved.exception == "National Day"
    assert available_slots(MONDAY, club=club, facility_type=facility_type) == []


def test_a_special_date_can_set_custom_hours(org, club):
    ScheduleException.objects.create(
        name="Ramadan hours", club=club, start_date=MONDAY, end_date=FRIDAY,
        closed=False, shifts=[{"open": "16:00", "close": "23:00"}])
    resolved = sched.resolve_for_date(TUESDAY, club=club)
    assert hours(resolved) == [("16:00", "23:00")]
    assert resolved.exception == "Ramadan hours"
    # Outside the range the ordinary weekday pattern returns.
    assert hours(sched.resolve_for_date(SATURDAY, club=club)) == [("08:00", "22:00")]


def test_an_exception_beats_the_weekday_pattern_at_every_scope(org, club, court):
    court.booking_hours = {"mon": day("06:00", "23:00")}
    court.save()
    ScheduleException.objects.create(name="Resurfacing", facility=court,
                                     start_date=MONDAY, closed=True)
    assert sched.resolve_for_date(MONDAY, facility=court).closed is True


def test_the_most_specific_exception_wins(org, club, court):
    ScheduleException.objects.create(name="Org holiday", start_date=MONDAY, closed=True)
    ScheduleException.objects.create(
        name="Court open anyway", facility=court, start_date=MONDAY,
        closed=False, shifts=[{"open": "10:00", "close": "14:00"}])
    resolved = sched.resolve_for_date(MONDAY, facility=court)
    assert resolved.exception == "Court open anyway"
    assert hours(resolved) == [("10:00", "14:00")]
    # The club itself, with no exception of its own, still follows the org one.
    assert sched.resolve_for_date(MONDAY, club=club).closed is True


def test_a_disabled_exception_is_ignored(org, club):
    ScheduleException.objects.create(name="Cancelled closure", club=club,
                                     start_date=MONDAY, closed=True, is_active=False)
    assert sched.resolve_for_date(MONDAY, club=club).closed is False


def test_an_exception_only_covers_its_own_range(org, club):
    ScheduleException.objects.create(name="Tournament", club=club,
                                     start_date=TUESDAY, end_date=FRIDAY, closed=True)
    assert sched.resolve_for_date(MONDAY, club=club).closed is False
    assert sched.resolve_for_date(TUESDAY, club=club).closed is True
    assert sched.resolve_for_date(FRIDAY, club=club).closed is True
    assert sched.resolve_for_date(SATURDAY, club=club).closed is False


# --------------------------------------------------------------------------- #
# 13: temporary facility blocks (maintenance) still remove capacity
# --------------------------------------------------------------------------- #
def test_a_maintenance_block_removes_capacity_without_closing_the_day(
        org, club, court, facility_type, admin_user):
    from apps.facilities.models import MaintenanceBlock

    MaintenanceBlock.objects.create(facility=court, start_date=MONDAY,
                                    end_date=MONDAY, start_time=time(10, 0),
                                    end_time=time(12, 0), reason="Resurfacing",
                                    created_by=admin_user)
    slots = {s["time"]: s for s in available_slots(MONDAY, club=club,
                                                   facility_type=facility_type)}
    assert slots["10:00"]["available"] == 0      # the only court is blocked
    assert slots["13:00"]["available"] == 1
    # The day itself is still open - a block is not a closure.
    assert sched.resolve_for_date(MONDAY, facility=court).is_open is True


# --------------------------------------------------------------------------- #
# 14: overnight operation
# --------------------------------------------------------------------------- #
def test_an_overnight_shift_is_kept_rather_than_silently_dropped(org, club):
    club.booking_hours = {"mon": day("18:00", "02:00")}
    club.save()
    resolved = sched.resolve_for_date(MONDAY, club=club)
    assert resolved.is_open is True
    assert resolved.shifts[0].start == 18 * 60
    assert resolved.shifts[0].end == 26 * 60          # 02:00 the next day


def test_an_overnight_shift_offers_slots_on_the_following_morning(
        org, club, court, facility_type):
    club.booking_hours = {**week(), "mon": day("18:00", "02:00"), "tue": CLOSED}
    club.save()

    monday = [s["time"] for s in available_slots(MONDAY, club=club,
                                                 facility_type=facility_type)]
    assert "18:00" in monday and "21:00" in monday
    assert not any(t < "18:00" for t in monday)      # nothing before opening

    # Tuesday is closed in its own right, yet the tail of Monday night runs on.
    tuesday = [s["time"] for s in available_slots(TUESDAY, club=club,
                                                  facility_type=facility_type)]
    assert "00:00" in tuesday and "01:00" in tuesday
    assert "03:00" not in tuesday


def test_a_24_hour_day_is_expressed_as_equal_times(org, club):
    club.booking_hours = {"mon": day("00:00", "00:00")}
    club.save()
    resolved = sched.resolve_for_date(MONDAY, club=club)
    assert resolved.shifts[0].minutes == 24 * 60


# --------------------------------------------------------------------------- #
# 15: slot interval vs booking duration
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("interval,expected", [(30, 8), (60, 4), (120, 2)])
def test_the_slot_interval_decides_how_often_a_slot_starts(
        org, club, court, facility_type, interval, expected):
    club.booking_hours = {"mon": day("08:00", "12:00")}
    club.slot_minutes = interval
    club.save()
    facility_type.duration_minutes = interval
    facility_type.save()
    slots = available_slots(MONDAY, club=club, facility_type=facility_type)
    assert len(slots) == expected


def test_interval_and_duration_are_independent(org, club, court, facility_type):
    """A 30-minute interval with a 60-minute booking gives overlapping start
    times, each holding the court for a full hour."""
    club.booking_hours = {"mon": day("08:00", "11:00")}
    club.slot_minutes = 30
    club.save()
    facility_type.duration_minutes = 60
    facility_type.save()
    slots = available_slots(MONDAY, club=club, facility_type=facility_type)
    assert [s["time"] for s in slots] == ["08:00", "08:30", "09:00", "09:30", "10:00"]
    assert slots[0]["end"] == "09:00"           # 60 minutes, not 30


def test_a_facility_may_set_its_own_slot_interval(org, club, court):
    club.slot_minutes = 60
    club.save()
    court.slot_minutes = 15
    court.save()
    assert sched.resolve_slot_minutes(club, court)[0] == 15
    assert sched.resolve_slot_minutes(club)[0] == 60


def test_a_booking_that_would_run_past_closing_is_not_offered(
        org, club, court, facility_type):
    club.booking_hours = {"mon": day("08:00", "10:00")}
    club.slot_minutes = 60
    club.save()
    facility_type.duration_minutes = 90
    facility_type.save()
    times = [s["time"] for s in available_slots(MONDAY, club=club,
                                                facility_type=facility_type)]
    assert times == ["08:00"]         # 09:00 + 90min would overrun 10:00


# --------------------------------------------------------------------------- #
# Buffers
# --------------------------------------------------------------------------- #
def test_a_buffer_after_a_booking_holds_the_facility(org, club, court,
                                                     facility_type, customer):
    from apps.bookings.models import Booking

    club.booking_hours = {"mon": day("08:00", "12:00")}
    club.slot_minutes = 60
    club.buffer_after_minutes = 30
    club.save()
    facility_type.duration_minutes = 60
    facility_type.save()

    booking = Booking(customer=customer, club=club, facility_type=facility_type,
                      facility=court, scheduled_date=MONDAY,
                      scheduled_time=time(9, 0), status="confirmed")
    booking.save()
    booking.compute_duration()
    booking.save()

    slots = {s["time"]: s for s in available_slots(MONDAY, club=club,
                                                   facility_type=facility_type)}
    assert slots["09:00"]["available"] == 0        # the booking itself
    assert slots["10:00"]["available"] == 0        # held by the 30-minute buffer
    assert slots["11:00"]["available"] == 1


def test_buffers_are_inherited_as_a_pair(org, club, court):
    org.buffer_before_minutes = 5
    org.buffer_after_minutes = 5
    org.save()
    club.buffer_after_minutes = 20
    club.save()
    # The club sets one, so the club's pair wins whole - it does not take the
    # organization's 5-minute "before" and the club's 20-minute "after".
    assert sched.resolve_buffers(club) == (0, 20)


# --------------------------------------------------------------------------- #
# 17: a closed day
# --------------------------------------------------------------------------- #
def test_a_closed_day_offers_nothing(org, club, court, facility_type):
    club.booking_hours = {"mon": CLOSED}
    club.save()
    assert available_slots(MONDAY, club=club, facility_type=facility_type) == []
    assert sched.resolve_for_date(MONDAY, club=club).is_open is False


def test_a_club_closed_day_does_not_close_the_other_days(org, club, court,
                                                          facility_type):
    club.booking_hours = {"mon": CLOSED}
    club.save()
    assert available_slots(TUESDAY, club=club, facility_type=facility_type)


# --------------------------------------------------------------------------- #
# 22: timezone
# --------------------------------------------------------------------------- #
def test_availability_uses_the_organization_timezone_not_utc(org, settings):
    """`local_now` must follow the configured timezone; Django's TIME_ZONE stays
    UTC so stored timestamps remain unambiguous."""
    from django.utils import timezone as dj_timezone

    org.timezone = "Asia/Dubai"
    org.save()
    local = sched.local_now()
    utc = dj_timezone.now()
    assert local.utcoffset().total_seconds() == 4 * 3600
    assert abs((local - utc).total_seconds()) < 5      # same instant, other clock


def test_an_unknown_timezone_falls_back_to_utc(org):
    org.timezone = "Mars/Olympus"
    org.save()
    assert sched.local_now().utcoffset().total_seconds() == 0


def test_past_slots_are_judged_in_the_organization_timezone(org, club, court,
                                                            facility_type):
    """The bug this guards: with TIME_ZONE=UTC and a +04:00 organization, the
    engine believed it was four hours earlier and kept offering slots that had
    already passed."""
    org.timezone = "Asia/Dubai"
    org.save()
    today = sched.local_now().date()
    key = sched.DAY_KEYS[today.weekday()]
    club.booking_hours = {key: day("00:00", "23:00")}
    club.slot_minutes = 60
    club.save()
    facility_type.duration_minutes = 60
    facility_type.save()

    now_hour = sched.local_now().hour
    times = [s["time"] for s in available_slots(today, club=club,
                                                facility_type=facility_type)]
    assert all(int(t[:2]) > now_hour for t in times)


# --------------------------------------------------------------------------- #
# Facility hours must bite even when availability is asked for the whole club
# --------------------------------------------------------------------------- #
def test_a_short_facility_is_not_offered_after_it_closes(org, club, court,
                                                          facility_type):
    """The club is open until 22:00 but this court shuts at 12:00. Asking the
    CLUB for availability must not keep offering the court all evening."""
    other = Facility.objects.create(club=club, name="Court 2")
    other.facility_types.set([facility_type])
    club.booking_hours = {"mon": day("08:00", "22:00")}
    club.save()
    court.booking_hours = {"mon": day("08:00", "12:00")}
    court.save()

    slots = {s["time"]: s for s in available_slots(MONDAY, club=club,
                                                   facility_type=facility_type)}
    assert slots["09:00"]["available"] == 2      # both courts
    assert slots["14:00"]["available"] == 1      # only Court 2 is still open


def test_a_facility_break_reduces_club_capacity_for_that_window(org, club, court,
                                                                 facility_type):
    other = Facility.objects.create(club=club, name="Court 2")
    other.facility_types.set([facility_type])
    club.booking_hours = {"mon": day("08:00", "20:00")}
    club.save()
    court.booking_hours = {"mon": day("08:00", "20:00",
                                      breaks=[{"name": "Clean", "open": "14:00",
                                               "close": "15:00"}])}
    court.save()

    slots = {s["time"]: s for s in available_slots(MONDAY, club=club,
                                                   facility_type=facility_type)}
    assert slots["14:00"]["available"] == 1      # the other court only
    assert slots["15:00"]["available"] == 2


def test_a_facility_closed_on_a_day_leaves_the_club_open(org, club, court,
                                                          facility_type):
    other = Facility.objects.create(club=club, name="Court 2")
    other.facility_types.set([facility_type])
    court.booking_hours = {"mon": CLOSED}
    court.save()

    slots = available_slots(MONDAY, club=club, facility_type=facility_type)
    assert slots, "the club is still open through its other court"
    assert all(s["available"] == 1 for s in slots)
