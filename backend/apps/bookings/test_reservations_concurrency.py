"""Two people, one court, at the same instant.

`test_reservations.py` covers holds sequentially. This runs real threads
against a real database, because the failure a hold exists to prevent only
lives in the window between "which courts are free?" and "take one", and a
sequential test cannot open that window.

Four races, all from section 80 of the spec: two customers, website against
admin, two admins, and two multi-slot selections that overlap on one hour.

`transaction=True` so each thread commits for real. That makes these slower
than the rest of the suite and it is the only way the race is genuine.
"""

import threading
from datetime import time, timedelta
from decimal import Decimal

import pytest
from django.db import connections
from django.utils import timezone

from apps.bookings import reservations
from apps.bookings.models import (
    ACTIVE_STATUSES, Booking, BookingHold, BookingHoldSlot, BookingSource,
    BookingStatus, HoldStatus,
)

pytestmark = pytest.mark.django_db(transaction=True)


def _open_all_week():
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
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

    club = Club.objects.create(name="Race Hold Club", code="RHOLD",
                               is_active=True, booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Padel Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Court 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customers = [
        Customer.objects.create(full_name=f"Player {i}", email=f"h{i}@race.test",
                                mobile_number=f"+96655000{i:04d}")
        for i in range(2)
    ]
    return {"club": club, "activity": activity, "court": court,
            "customers": customers}


def when(days=4):
    return timezone.localdate() + timedelta(days=days)


def _hold_attempt(venue, times, results, barrier, source=BookingSource.WEBSITE):
    try:
        barrier.wait(timeout=10)
        hold, _token = reservations.acquire(
            club=venue["club"], facility_type=venue["activity"],
            slots=[(when(), time(hour, 0)) for hour in times], source=source)
        results.append(("held", hold.reference))
    except reservations.SlotUnavailable:
        results.append(("refused", "unavailable"))
    except Exception as exc:                   # noqa: BLE001 - recorded, not hidden
        results.append(("error", type(exc).__name__))
    finally:
        connections.close_all()


def _booking_attempt(venue, customer, hour, results, barrier):
    """Take the court the way the admin booking path does."""
    from django.db import transaction

    from apps.bookings.services import FacilityUnavailable, allocate_facility
    try:
        barrier.wait(timeout=10)
        with transaction.atomic():
            booking = Booking(
                customer=customer, club=venue["club"],
                facility_type=venue["activity"], scheduled_date=when(),
                scheduled_time=time(hour, 0), end_time=time(hour + 1, 0),
                duration_minutes=60, status=BookingStatus.CONFIRMED,
                currency="SAR", total_amount=Decimal("100.000"))
            allocate_facility(booking, commit=False)
            booking.save()
        results.append(("booked", booking.reference))
    except FacilityUnavailable:
        results.append(("refused", "unavailable"))
    except Exception as exc:                   # noqa: BLE001
        results.append(("error", type(exc).__name__))
    finally:
        connections.close_all()


def run_together(*jobs):
    """Start every job from a standing start, as close together as possible."""
    results = []
    barrier = threading.Barrier(len(jobs), timeout=10)
    threads = [threading.Thread(target=job, args=(results, barrier))
               for job in jobs]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    return results


def live_holds_on(hour):
    return BookingHoldSlot.objects.filter(
        scheduled_date=when(), scheduled_time=time(hour, 0),
        hold__status=HoldStatus.ACTIVE).count()


def live_bookings_on(hour):
    return Booking.objects.filter(
        scheduled_date=when(), scheduled_time=time(hour, 0),
        status__in=ACTIVE_STATUSES, facility__isnull=False).count()


class TestOnlyOneClaimWins:
    def test_two_customers_reaching_for_the_same_slot(self, venue):
        """Section 80: exactly one hold wins."""
        results = run_together(
            lambda r, b: _hold_attempt(venue, [19], r, b),
            lambda r, b: _hold_attempt(venue, [19], r, b),
        )
        assert len(results) == 2, results
        assert [r[0] for r in results].count("held") == 1, results
        assert live_holds_on(19) == 1

    def test_the_website_and_the_admin_reaching_at_once(self, venue):
        """One is a hold, the other a confirmed booking. Still only one court."""
        results = run_together(
            lambda r, b: _hold_attempt(venue, [19], r, b),
            lambda r, b: _booking_attempt(venue, venue["customers"][0], 19, r, b),
        )
        assert len(results) == 2, results
        winners = [r for r in results if r[0] in ("held", "booked")]
        assert len(winners) == 1, f"both took the same court: {results}"
        assert live_holds_on(19) + live_bookings_on(19) == 1

    def test_two_admins_reaching_for_the_same_slot(self, venue):
        results = run_together(
            lambda r, b: _booking_attempt(venue, venue["customers"][0], 19, r, b),
            lambda r, b: _booking_attempt(venue, venue["customers"][1], 19, r, b),
        )
        assert [r[0] for r in results].count("booked") == 1, results
        assert live_bookings_on(19) == 1

    def test_two_selections_overlapping_on_one_hour(self, venue):
        """7+8 against 8+9: only one may have the 8 o'clock court.

        And the loser must leave nothing behind. Reserving its 9 o'clock and
        then failing would lock a court for a booking that cannot happen.
        """
        results = run_together(
            lambda r, b: _hold_attempt(venue, [19, 20], r, b),
            lambda r, b: _hold_attempt(venue, [20, 21], r, b),
        )
        assert len(results) == 2, results
        assert [r[0] for r in results].count("held") == 1, results
        assert live_holds_on(20) == 1
        # Exactly one two-slot hold exists, with nothing stranded from the other.
        assert BookingHold.objects.filter(status=HoldStatus.ACTIVE).count() == 1
        assert BookingHoldSlot.objects.filter(
            hold__status=HoldStatus.ACTIVE).count() == 2


class TestTheProtectionIsNotTooBroad:
    def test_two_different_hours_both_succeed(self, venue):
        results = run_together(
            lambda r, b: _hold_attempt(venue, [9], r, b),
            lambda r, b: _hold_attempt(venue, [14], r, b),
        )
        assert [r[0] for r in results] == ["held", "held"], results

    def test_two_courts_admit_two_holds_on_one_hour(self, venue):
        from apps.facilities.models import Facility
        second = Facility.objects.create(name="Court 2", club=venue["club"],
                                         is_active=True)
        second.facility_types.add(venue["activity"])
        results = run_together(
            lambda r, b: _hold_attempt(venue, [19], r, b),
            lambda r, b: _hold_attempt(venue, [19], r, b),
        )
        assert [r[0] for r in results] == ["held", "held"], results
        assert live_holds_on(19) == 2
