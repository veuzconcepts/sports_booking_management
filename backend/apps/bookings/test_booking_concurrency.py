"""Two customers, one court, at the same moment.

Everything else about availability is tested sequentially elsewhere. This file
runs real threads against a real database, because the failure this guards
against only exists in the window between "is it free?" and "take it", and a
sequential test cannot open that window.

Two shapes are covered, and they are protected by different things:

* the SAME start time, which the partial unique index on
  (facility, scheduled_date, scheduled_time) refuses outright;
* an OVERLAPPING but different start, which no index can express, and which
  therefore depends entirely on `allocate_facility` holding a lock.

These use `transaction=True` so each thread commits for real; that makes them
slower than the rest of the suite and it is the only way the race is genuine.
"""

import threading
from datetime import date, time, timedelta
from decimal import Decimal

import pytest
from django.db import connections, transaction

from apps.bookings.models import ACTIVE_STATUSES, Booking, BookingStatus
from apps.bookings.services import FacilityUnavailable, allocate_facility

pytestmark = pytest.mark.django_db(transaction=True)

WHEN = date(2026, 6, 1)          # a Monday, comfortably inside any horizon


def _open_all_week(open_at="06:00", close_at="23:00"):
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": open_at, "close": close_at}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture
def venue(db):
    """One club, one activity, exactly ONE court, so capacity is one."""
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.save()

    club = Club.objects.create(name="Race Club", code="RACE", is_active=True,
                               booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Padel Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Court 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customers = [
        Customer.objects.create(full_name=f"Player {i}", email=f"p{i}@race.test",
                                mobile_number=f"+96650000{i:04d}")
        for i in range(2)
    ]
    return {"club": club, "activity": activity, "court": court,
            "customers": customers}


def _attempt(venue, customer, at_time, duration=None, results=None, barrier=None):
    """Create one booking the way the engine does, from its own thread."""
    activity = venue["activity"]
    try:
        if barrier is not None:
            barrier.wait(timeout=10)
        with transaction.atomic():
            booking = Booking(
                customer=customer, club=venue["club"], facility_type=activity,
                scheduled_date=WHEN, scheduled_time=at_time,
                duration_minutes=duration or activity.duration_minutes,
                status=BookingStatus.CONFIRMED, currency="SAR",
                total_amount=Decimal("100.000"),
            )
            booking.end_time = (
                (time(at_time.hour + (duration or 60) // 60, at_time.minute))
                if at_time.hour + (duration or 60) // 60 < 24 else time(23, 59))
            allocate_facility(booking, commit=False)
            booking.save()
        results.append(("ok", booking.pk))
    except Exception as exc:                       # noqa: BLE001 - recorded, not hidden
        results.append(("refused", type(exc).__name__))
    finally:
        # Each thread opened its own connection; leaving them open wedges the
        # test database teardown.
        connections.close_all()


def _run_together(venue, first, second):
    """Run two booking attempts from a standing start, as close as possible."""
    results = []
    barrier = threading.Barrier(2, timeout=10)
    threads = [
        threading.Thread(target=_attempt, kwargs={
            "venue": venue, "customer": venue["customers"][i],
            "results": results, "barrier": barrier, **spec})
        for i, spec in enumerate((first, second))
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    return results


def _live_on(at_time=None):
    qs = Booking.objects.filter(scheduled_date=WHEN, status__in=ACTIVE_STATUSES,
                                facility__isnull=False)
    if at_time is not None:
        qs = qs.filter(scheduled_time=at_time)
    return qs


class TestTwoCustomersOneCourt:
    def test_the_same_start_time_admits_exactly_one(self, venue):
        """Section 53. Both ask for 19:00 on the only court."""
        results = _run_together(
            venue,
            {"at_time": time(19, 0)},
            {"at_time": time(19, 0)},
        )
        assert len(results) == 2, results
        winners = [r for r in results if r[0] == "ok"]
        assert len(winners) == 1, f"expected exactly one winner, got {results}"
        assert _live_on(time(19, 0)).count() == 1

    def test_an_overlapping_start_admits_exactly_one(self, venue):
        """The case no index can express.

        A 120-minute booking at 19:00 and a 60-minute booking at 20:00 want
        the same court for 20:00-21:00. The rows differ in `scheduled_time`,
        so the unique index cannot see the clash: only the lock taken by
        `allocate_facility` can.
        """
        results = _run_together(
            venue,
            {"at_time": time(19, 0), "duration": 120},
            {"at_time": time(20, 0), "duration": 60},
        )
        assert len(results) == 2, results
        winners = [r for r in results if r[0] == "ok"]
        assert len(winners) == 1, (
            f"both bookings were accepted for an overlapping period: {results}")
        assert _live_on().count() == 1

    def test_two_different_hours_both_succeed(self, venue):
        """The protection must not be so broad that it refuses honest work."""
        results = _run_together(
            venue,
            {"at_time": time(9, 0)},
            {"at_time": time(14, 0)},
        )
        assert [r[0] for r in results] == ["ok", "ok"], results
        assert _live_on().count() == 2

    def test_capacity_of_two_admits_two_and_refuses_a_third(self, venue):
        """With two courts, two concurrent bookings are correct, not a bug."""
        from apps.facilities.models import Facility
        second_court = Facility.objects.create(
            name="Court 2", club=venue["club"], is_active=True)
        second_court.facility_types.add(venue["activity"])

        results = _run_together(
            venue, {"at_time": time(19, 0)}, {"at_time": time(19, 0)})
        assert [r[0] for r in results] == ["ok", "ok"], results
        assert _live_on(time(19, 0)).count() == 2

        # The third is refused, by the engine rather than by the index: the
        # two live rows hold different facilities.
        from apps.customers.models import Customer
        third = Customer.objects.create(
            full_name="Third", email="third@race.test", mobile_number="+966500009999")
        overflow = []
        _attempt(venue, third, time(19, 0), results=overflow)
        assert overflow[0][0] == "refused", overflow
        assert _live_on(time(19, 0)).count() == 2
