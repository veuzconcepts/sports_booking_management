"""The type-aware, overlap-aware availability engine and facility allocation.

Covers the four things the old slot engine got wrong:
  1. capacity ignored which facility could host the booked type,
  2. a booking only blocked its START slot, not the slots it spanned,
  3. nothing allocated a specific facility, so two bookings could share a court,
  4. a facility out of service still counted towards capacity.
"""

from datetime import date, time, timedelta
from decimal import Decimal

import pytest

from apps.bookings.models import ACTIVE_STATUSES, Booking, BookingStatus
from apps.bookings.services import (
    FacilityUnavailable,
    allocate_facility,
    available_slots,
    capacity_for,
    eligible_facilities,
    free_facilities,
    interval_for,
    slot_is_available,
)
from apps.facilities.models import Facility, FacilityType, MaintenanceBlock

THURSDAY = date(2026, 6, 4)


# --------------------------------------------------------------------------- #
# Fixtures: a club with a tennis court, a padel court and a dual-purpose hall
# --------------------------------------------------------------------------- #
@pytest.fixture
def org(db):
    from apps.settings_app.models import Organization
    org = Organization.get_solo()
    org.slot_minutes = 60
    org.booking_hours = {**(org.booking_hours or {}),
                         "thu": {"closed": False,
                                 "shifts": [{"open": "09:00", "close": "13:00"}]}}
    org.save()
    return org


@pytest.fixture
def padel_type(db, facility_category):
    ft = FacilityType.objects.create(
        name="Padel Court", price=Decimal("80.00"), duration_minutes=60)
    ft.categories.set([facility_category])
    return ft


@pytest.fixture
def venue(db, club, facility_type, padel_type):
    """Court 1 -> tennis, Padel A -> padel, Hall A -> both, Store -> unrestricted."""
    court = Facility.objects.create(club=club, name="Court 1")
    court.facility_types.set([facility_type])
    padel = Facility.objects.create(club=club, name="Padel A")
    padel.facility_types.set([padel_type])
    hall = Facility.objects.create(club=club, name="Hall A")
    hall.facility_types.set([facility_type, padel_type])
    spare = Facility.objects.create(club=club, name="Spare")   # no declared types
    return {"court": court, "padel": padel, "hall": hall, "spare": spare}


def _book(customer, club, facility_type, on_date, at_time, facility=None,
          allocate=True, **extra):
    """Create a booking the way the API does: save, size it, then allocate a unit."""
    b = Booking(customer=customer, club=club, facility_type=facility_type,
                facility=facility, scheduled_date=on_date, scheduled_time=at_time,
                **extra)
    b.save()
    b.compute_duration()
    b.save()
    if allocate:
        allocate_facility(b)
        b.refresh_from_db()
    return b


def _draft(customer, club, facility_type, on_date, at_time, facility=None):
    """An unsaved booking - used to test allocation refusal without tripping the
    database constraint first."""
    b = Booking(customer=customer, club=club, facility_type=facility_type,
                facility=facility, scheduled_date=on_date, scheduled_time=at_time)
    b.duration_minutes = facility_type.duration_minutes
    b.sync_end_time()
    return b


# --------------------------------------------------------------------------- #
# Interval arithmetic
# --------------------------------------------------------------------------- #
def test_interval_for_returns_the_occupied_window():
    assert interval_for(time(10, 0), 90) == (time(10, 0), time(11, 30))


def test_interval_that_would_wrap_past_midnight_is_refused():
    assert interval_for(time(23, 30), 60) is None


def test_booking_stores_its_end_time(db, customer, club, facility_type, venue):
    facility_type.duration_minutes = 90
    facility_type.save()
    b = _book(customer, club, facility_type, THURSDAY, time(10, 0))
    b.refresh_from_db()
    assert b.duration_minutes == 90
    assert b.end_time == time(11, 30)
    assert b.occupies == (time(10, 0), time(11, 30))


# --------------------------------------------------------------------------- #
# 1. Capacity is type-aware
# --------------------------------------------------------------------------- #
def test_eligible_facilities_match_the_booked_type(db, club, venue, facility_type):
    names = {f.name for f in eligible_facilities(club=club, facility_type=facility_type)}
    assert names == {"Court 1", "Hall A", "Spare"}      # padel court excluded


def test_a_facility_with_no_declared_types_serves_anything(db, club, venue, padel_type):
    names = {f.name for f in eligible_facilities(club=club, facility_type=padel_type)}
    assert "Spare" in names


def test_capacity_counts_only_facilities_that_can_host_the_type(db, club, venue,
                                                                facility_type, padel_type):
    assert capacity_for(club=club, facility_type=facility_type) == 3   # court, hall, spare
    assert capacity_for(club=club, facility_type=padel_type) == 3      # padel, hall, spare
    assert capacity_for(club=club) == 4                                # all units


def test_inactive_facilities_are_never_eligible(db, club, venue, facility_type):
    venue["court"].is_active = False
    venue["court"].save()
    assert capacity_for(club=club, facility_type=facility_type) == 2


def test_capacity_is_scoped_to_the_club(db, club, venue, facility_type):
    from apps.clubs.models import Club
    other = Club.objects.create(code="north", name="Northside")
    spare = Facility.objects.create(club=other, name="Far Court")
    spare.facility_types.set([facility_type])
    assert capacity_for(club=club, facility_type=facility_type) == 3
    assert capacity_for(club=other, facility_type=facility_type) == 1


# --------------------------------------------------------------------------- #
# 2. A booking blocks every slot it spans
# --------------------------------------------------------------------------- #
def test_a_90_minute_booking_blocks_the_slot_it_runs_into(db, org, customer, club,
                                                          venue, facility_type):
    facility_type.duration_minutes = 90
    facility_type.save()
    # Only one eligible unit, so one booking exhausts capacity.
    venue["hall"].delete()
    venue["spare"].delete()

    _book(customer, club, facility_type, THURSDAY, time(10, 0))   # holds 10:00-11:30

    assert slot_is_available(THURSDAY, time(10, 0), club=club,
                             facility_type=facility_type) is False
    # 11:00 overlaps 10:00-11:30 and must also be refused.
    assert slot_is_available(THURSDAY, time(11, 0), club=club,
                             facility_type=facility_type) is False
    # 11:30 is clear.
    assert slot_is_available(THURSDAY, time(11, 30), club=club,
                             facility_type=facility_type) is True


def test_available_slots_reflect_a_spanning_booking(db, org, customer, club,
                                                    venue, facility_type):
    facility_type.duration_minutes = 60
    facility_type.save()
    venue["hall"].delete()
    venue["spare"].delete()
    _book(customer, club, facility_type, THURSDAY, time(10, 0))

    slots = {s["time"]: s for s in available_slots(THURSDAY, club=club,
                                                   facility_type=facility_type)}
    assert slots["09:00"]["available"] == 1
    assert slots["10:00"]["available"] == 0
    assert slots["11:00"]["available"] == 1


def test_a_padel_booking_does_not_consume_tennis_capacity(db, org, customer, club,
                                                          venue, facility_type, padel_type):
    # Padel A is the only padel-only unit; Hall A + Spare serve both.
    _book(customer, club, padel_type, THURSDAY, time(10, 0), facility=venue["padel"])

    tennis = {s["time"]: s for s in available_slots(THURSDAY, club=club,
                                                    facility_type=facility_type)}
    padel = {s["time"]: s for s in available_slots(THURSDAY, club=club,
                                                   facility_type=padel_type)}
    assert tennis["10:00"]["available"] == 3     # court, hall, spare all free
    assert padel["10:00"]["available"] == 2      # padel A taken


def test_slots_that_would_run_past_closing_are_not_offered(db, org, club, venue,
                                                           facility_type):
    facility_type.duration_minutes = 120         # 2h in a 09:00-13:00 day
    facility_type.save()
    times = [s["time"] for s in available_slots(THURSDAY, club=club,
                                                facility_type=facility_type)]
    assert times == ["09:00", "10:00", "11:00"]  # a 12:00 start would end at 14:00


def test_each_slot_reports_the_interval_it_would_occupy(db, org, club, venue,
                                                        facility_type):
    facility_type.duration_minutes = 90
    facility_type.save()
    first = available_slots(THURSDAY, club=club, facility_type=facility_type)[0]
    assert (first["time"], first["end"]) == ("09:00", "10:30")


# --------------------------------------------------------------------------- #
# 3. Allocation
# --------------------------------------------------------------------------- #
def test_a_booking_is_allocated_a_facility_that_can_host_it(db, customer, club,
                                                            venue, facility_type):
    b = _book(customer, club, facility_type, THURSDAY, time(10, 0))
    assert b.facility is not None
    assert b.facility.serves(facility_type)


def test_allocation_never_hands_out_the_same_unit_twice(db, customer, club,
                                                        venue, facility_type):
    allocated = []
    for _ in range(3):                                   # 3 eligible units
        b = _book(customer, club, facility_type, THURSDAY, time(10, 0))
        allocated.append(b.facility_id)
    assert len(set(allocated)) == 3
    assert None not in allocated


def test_allocation_fails_once_every_unit_is_taken(db, customer, club,
                                                   venue, facility_type):
    for _ in range(3):
        _book(customer, club, facility_type, THURSDAY, time(10, 0))
    overflow = _draft(customer, club, facility_type, THURSDAY, time(10, 0))
    with pytest.raises(FacilityUnavailable):
        allocate_facility(overflow)


def test_a_staff_chosen_facility_is_kept_when_free(db, customer, club,
                                                   venue, facility_type):
    b = _book(customer, club, facility_type, THURSDAY, time(10, 0),
              facility=venue["hall"])
    assert b.facility == venue["hall"]


def test_a_staff_chosen_facility_is_refused_when_taken(db, customer, club,
                                                       venue, facility_type):
    _book(customer, club, facility_type, THURSDAY, time(10, 0), facility=venue["hall"])
    clash = _draft(customer, club, facility_type, THURSDAY, time(10, 0),
                   facility=venue["hall"])
    with pytest.raises(FacilityUnavailable):
        allocate_facility(clash)


def test_cancelling_releases_the_unit_for_reallocation(db, customer, club,
                                                       venue, facility_type):
    held = [_book(customer, club, facility_type, THURSDAY, time(10, 0)) for _ in range(3)]
    held[0].status = BookingStatus.CANCELLED
    held[0].save()

    fresh = _book(customer, club, facility_type, THURSDAY, time(10, 0))
    assert fresh.facility_id == held[0].facility_id


def test_a_type_that_needs_no_facility_is_not_allocated_one(db, customer, club,
                                                            venue, facility_type):
    facility_type.facility_required = False
    facility_type.save()
    b = _book(customer, club, facility_type, THURSDAY, time(10, 0), allocate=False)
    assert allocate_facility(b) is None
    assert b.facility_id is None


def test_the_unique_constraint_backstops_a_double_allocation(db, customer, club,
                                                             venue, facility_type):
    """Even if allocation were bypassed, the DB refuses two live bookings on one
    facility at one start time."""
    from django.db import IntegrityError, transaction

    _book(customer, club, facility_type, THURSDAY, time(10, 0), facility=venue["court"])
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            _book(customer, club, facility_type, THURSDAY, time(10, 0),
                  facility=venue["court"], allocate=False)


def test_a_cancelled_booking_does_not_hold_the_constraint(db, customer, club,
                                                          venue, facility_type):
    first = _book(customer, club, facility_type, THURSDAY, time(10, 0),
                  facility=venue["court"])
    first.status = BookingStatus.CANCELLED
    first.save()
    # The slot is free again, so an identical live booking is allowed.
    again = _book(customer, club, facility_type, THURSDAY, time(10, 0),
                  facility=venue["court"])
    assert again.facility == venue["court"]


# --------------------------------------------------------------------------- #
# 4. Maintenance blocks
# --------------------------------------------------------------------------- #
def test_an_all_day_block_removes_the_unit(db, org, club, venue, facility_type):
    MaintenanceBlock.objects.create(
        facility=venue["court"], start_date=THURSDAY, end_date=THURSDAY,
        reason="Resurfacing")
    free = free_facilities(THURSDAY, time(10, 0), club=club, facility_type=facility_type)
    assert "Court 1" not in {f.name for f in free}
    assert {f.name for f in free} == {"Hall A", "Spare"}


def test_a_block_only_bites_inside_its_date_range(db, org, club, venue, facility_type):
    MaintenanceBlock.objects.create(
        facility=venue["court"], start_date=THURSDAY - timedelta(days=3),
        end_date=THURSDAY - timedelta(days=1), reason="Past work")
    free = free_facilities(THURSDAY, time(10, 0), club=club, facility_type=facility_type)
    assert "Court 1" in {f.name for f in free}


def test_a_timed_block_only_bites_inside_its_window(db, org, club, venue, facility_type):
    MaintenanceBlock.objects.create(
        facility=venue["court"], start_date=THURSDAY, end_date=THURSDAY,
        start_time=time(12, 0), end_time=time(14, 0), reason="Net replacement")

    morning = free_facilities(THURSDAY, time(10, 0), club=club, facility_type=facility_type)
    midday = free_facilities(THURSDAY, time(12, 0), club=club, facility_type=facility_type)
    assert "Court 1" in {f.name for f in morning}
    assert "Court 1" not in {f.name for f in midday}


def test_a_block_reduces_reported_availability(db, org, club, venue, facility_type):
    before = {s["time"]: s for s in available_slots(THURSDAY, club=club,
                                                    facility_type=facility_type)}
    MaintenanceBlock.objects.create(
        facility=venue["court"], start_date=THURSDAY, end_date=THURSDAY)
    after = {s["time"]: s for s in available_slots(THURSDAY, club=club,
                                                   facility_type=facility_type)}
    assert before["10:00"]["available"] == 3
    assert after["10:00"]["available"] == 2


def test_allocation_skips_a_blocked_unit(db, customer, club, venue, facility_type):
    MaintenanceBlock.objects.create(
        facility=venue["court"], start_date=THURSDAY, end_date=THURSDAY)
    b = _book(customer, club, facility_type, THURSDAY, time(10, 0))
    assert b.facility != venue["court"]


def test_block_validation_rejects_a_backwards_range(db, venue):
    from django.core.exceptions import ValidationError
    block = MaintenanceBlock(facility=venue["court"],
                             start_date=THURSDAY, end_date=THURSDAY - timedelta(days=1))
    with pytest.raises(ValidationError):
        block.clean()


def test_block_validation_rejects_a_half_specified_window(db, venue):
    from django.core.exceptions import ValidationError
    block = MaintenanceBlock(facility=venue["court"], start_date=THURSDAY,
                             end_date=THURSDAY, start_time=time(9, 0))
    with pytest.raises(ValidationError):
        block.clean()


# --------------------------------------------------------------------------- #
# Query budget: the day must cost a fixed number of queries
# --------------------------------------------------------------------------- #
def test_available_slots_does_not_scale_queries_with_slot_count(
        db, org, club, venue, facility_type, django_assert_max_num_queries):
    org.booking_hours = {**(org.booking_hours or {}),
                         "thu": {"closed": False,
                                 "shifts": [{"open": "06:00", "close": "22:00"}]}}
    org.save()
    with django_assert_max_num_queries(8):
        slots = available_slots(THURSDAY, club=club, facility_type=facility_type)
    assert len(slots) == 16
