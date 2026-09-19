"""Which dates the booking calendar may offer.

The calendar used to grey out days from the weekday pattern alone, so a date
closed for a holiday, out for maintenance or simply full still looked
bookable. The customer found out by clicking it.

These tests pin the cases where "the day is open" and "something can actually
be booked" come apart, because those are the ones the old calendar got wrong.
"""

from datetime import date, time, timedelta
from decimal import Decimal

import pytest
from django.core.cache import cache

from apps.bookings import availability_cache
from apps.bookings.models import Booking, BookingPolicy, BookingStatus
from apps.bookings.services import (
    DATE_CLOSED, DATE_FULL, DATE_HOLIDAY, DATE_OUTSIDE_WINDOW, DATE_PAST,
    DATE_RULES, date_availability_summary, next_available_date,
)

pytestmark = pytest.mark.django_db

CALENDAR = "/api/v1/website/public/availability/calendar/"


def _open_all_week(open_at="08:00", close_at="20:00"):
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False,
                  "shifts": [{"open": open_at, "close": close_at}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture(autouse=True)
def _fresh_cache():
    cache.clear()
    availability_cache.invalidate()


@pytest.fixture
def venue(db, tax_rate):
    """One club, one activity, one court, open 08:00 to 20:00 every day."""
    from apps.clubs.models import Club
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.save()

    club = Club.objects.create(name="Calendar Club", is_active=True,
                               booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Tennis Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Court 1", club=club, is_active=True)
    court.facility_types.add(activity)
    return {"club": club, "activity": activity, "court": court}


def soon(days=7):
    from django.utils import timezone
    return timezone.localdate() + timedelta(days=days)


def summary_for(venue, first=None, last=None):
    first = first or soon(1)
    last = last or soon(20)
    return date_availability_summary(
        first, last, club=venue["club"], facility_type=venue["activity"])


def fill(venue, on_date, times=("08:00", "09:00", "10:00", "11:00", "12:00",
                                "13:00", "14:00", "15:00", "16:00", "17:00",
                                "18:00", "19:00")):
    """Book out the single court for a whole day."""
    from apps.customers.models import Customer

    customer = Customer.objects.create(
        full_name="Filler", email=f"f{on_date}@calendar.test",
        mobile_number="+966500009999")
    for at in times:
        hour, minute = (int(part) for part in at.split(":"))
        Booking.objects.create(
            customer=customer, club=venue["club"],
            facility_type=venue["activity"], facility=venue["court"],
            scheduled_date=on_date, scheduled_time=time(hour, minute),
            end_time=time(hour + 1, minute), status=BookingStatus.CONFIRMED,
            currency="SAR", total_amount=Decimal("100.000"))


# --------------------------------------------------------------------------- #
# The basic states
# --------------------------------------------------------------------------- #
class TestDateStates:
    def test_a_date_with_slots_is_available(self, venue):
        day = summary_for(venue)[soon(3).isoformat()]
        assert day["available"] is True
        assert day["slot_count"] > 0

    def test_a_fully_booked_date_is_not_available(self, venue):
        target = soon(3)
        fill(venue, target)
        day = summary_for(venue)[target.isoformat()]
        assert day["available"] is False
        assert day["reason"] == DATE_FULL
        # It is full, not shut: saying "closed" would be a different message.
        assert day["slot_count"] == 0

    def test_a_closed_weekday_is_not_available(self, venue):
        from apps.settings_app.models import BOOKING_DAY_KEYS
        target = soon(3)
        hours = _open_all_week()
        hours[BOOKING_DAY_KEYS[target.weekday()]] = {"closed": True, "shifts": []}
        venue["club"].booking_hours = hours
        venue["club"].save()
        day = summary_for(venue)[target.isoformat()]
        assert day["available"] is False
        assert day["reason"] == DATE_CLOSED

    def test_a_holiday_closure_is_not_available(self, venue):
        from apps.settings_app.models import ScheduleException
        target = soon(4)
        ScheduleException.objects.create(
            name="National Day", club=venue["club"], start_date=target,
            end_date=target, closed=True, is_active=True)
        day = summary_for(venue)[target.isoformat()]
        assert day["available"] is False
        # Distinguished from an ordinary closed weekday for support tooling.
        assert day["reason"] == DATE_HOLIDAY

    def test_a_maintenance_closure_is_not_available(self, venue):
        from apps.facilities.models import MaintenanceBlock
        target = soon(5)
        MaintenanceBlock.objects.create(
            facility=venue["court"], start_date=target, end_date=target,
            reason="Resurfacing")
        day = summary_for(venue)[target.isoformat()]
        assert day["available"] is False
        assert day["reason"] == DATE_FULL

    def test_a_past_date_is_not_available(self, venue):
        from django.utils import timezone
        past = timezone.localdate() - timedelta(days=2)
        day = date_availability_summary(
            past, past, club=venue["club"], facility_type=venue["activity"])
        assert day[past.isoformat()]["available"] is False
        assert day[past.isoformat()]["reason"] == DATE_PAST

    def test_beyond_the_booking_horizon_is_not_available(self, venue):
        policy = (BookingPolicy.objects.filter(is_default=True).first()
                  or BookingPolicy.objects.create(is_default=True))
        policy.max_advance_days = 10
        policy.save()
        far = soon(30)
        day = date_availability_summary(
            far, far, club=venue["club"], facility_type=venue["activity"])
        assert day[far.isoformat()]["available"] is False
        assert day[far.isoformat()]["reason"] == DATE_OUTSIDE_WINDOW

    def test_a_club_with_no_courts_offers_nothing(self, venue):
        venue["court"].delete()
        days = summary_for(venue)
        assert all(day["available"] is False for day in days.values())


# --------------------------------------------------------------------------- #
# Booking rules decide what "bookable" means (section 15 and 16)
# --------------------------------------------------------------------------- #
class TestRulesAffectDateAvailability:
    def _policy(self, **fields):
        policy = (BookingPolicy.objects.filter(is_default=True).first()
                  or BookingPolicy.objects.create(is_default=True))
        for key, value in fields.items():
            setattr(policy, key, value)
        policy.save()
        return policy

    def test_a_floor_of_two_needs_two_free_slots(self, venue):
        """One isolated gap cannot satisfy a two-slot minimum."""
        target = soon(3)
        self._policy(allow_multiple_slots=True, allow_multiple_dates=False,
                     min_slots_per_booking=2, max_slots_per_booking=4)
        # Leave exactly one hour free.
        fill(venue, target, times=("08:00", "09:00", "10:00", "11:00", "12:00",
                                   "13:00", "14:00", "15:00", "16:00", "17:00",
                                   "18:00"))
        day = summary_for(venue)[target.isoformat()]
        assert day["available"] is False
        assert day["reason"] == DATE_RULES
        # The one free slot is still reported, so support can see why.
        assert day["slot_count"] == 1

    def test_one_free_slot_is_enough_when_other_dates_are_allowed(self, venue):
        """The rest of the minimum can come from another day."""
        target = soon(3)
        self._policy(allow_multiple_slots=True, allow_multiple_dates=True,
                     min_slots_per_booking=2, max_slots_per_booking=4)
        fill(venue, target, times=("08:00", "09:00", "10:00", "11:00", "12:00",
                                   "13:00", "14:00", "15:00", "16:00", "17:00",
                                   "18:00"))
        assert summary_for(venue)[target.isoformat()]["available"] is True

    def test_back_to_back_needs_an_actual_run(self, venue):
        """Two free hours with a booking between them are not consecutive."""
        target = soon(3)
        self._policy(allow_multiple_slots=True, allow_multiple_dates=True,
                     require_consecutive_slots=True,
                     min_slots_per_booking=2, max_slots_per_booking=4)
        # Free at 08:00 and 10:00 only, so no run of two exists.
        fill(venue, target, times=("09:00", "11:00", "12:00", "13:00", "14:00",
                                   "15:00", "16:00", "17:00", "18:00", "19:00"))
        day = summary_for(venue)[target.isoformat()]
        assert day["available"] is False
        assert day["reason"] == DATE_RULES

    def test_back_to_back_is_satisfied_by_a_real_run(self, venue):
        target = soon(3)
        self._policy(allow_multiple_slots=True, allow_multiple_dates=True,
                     require_consecutive_slots=True,
                     min_slots_per_booking=2, max_slots_per_booking=4)
        # 08:00 and 09:00 are both free and adjacent.
        fill(venue, target, times=("10:00", "11:00", "12:00", "13:00", "14:00",
                                   "15:00", "16:00", "17:00", "18:00", "19:00"))
        assert summary_for(venue)[target.isoformat()]["available"] is True

    def test_a_long_duration_can_empty_a_short_day(self, venue):
        """A 90-minute activity does not fit a 60-minute opening."""
        from apps.settings_app.models import ScheduleException
        target = soon(4)
        venue["activity"].duration_minutes = 90
        venue["activity"].save()
        ScheduleException.objects.create(
            name="Short day", club=venue["club"], start_date=target,
            end_date=target, is_active=True,
            shifts=[{"open": "08:00", "close": "09:00"}])
        assert summary_for(venue)[target.isoformat()]["available"] is False


# --------------------------------------------------------------------------- #
# Next available
# --------------------------------------------------------------------------- #
class TestNextAvailable:
    def test_it_skips_the_days_that_cannot_be_booked(self, venue):
        first, second = soon(1), soon(2)
        fill(venue, first)
        fill(venue, second)
        assert next_available_date(
            first, club=venue["club"], facility_type=venue["activity"]) == soon(3)

    def test_it_looks_past_the_end_of_the_month(self, venue):
        """A quiet period must not need the customer to press next repeatedly."""
        from apps.settings_app.models import ScheduleException
        start = soon(1)
        ScheduleException.objects.create(
            name="Winter break", club=venue["club"], start_date=start,
            end_date=start + timedelta(days=40), closed=True, is_active=True)
        found = next_available_date(
            start, club=venue["club"], facility_type=venue["activity"])
        assert found == start + timedelta(days=41)

    def test_it_gives_up_rather_than_inventing_a_date(self, venue):
        from apps.settings_app.models import ScheduleException
        start = soon(1)
        ScheduleException.objects.create(
            name="Closed", club=venue["club"], start_date=start,
            end_date=start + timedelta(days=400), closed=True, is_active=True)
        assert next_available_date(
            start, club=venue["club"], facility_type=venue["activity"]) is None

    def test_it_respects_the_booking_horizon(self, venue):
        policy = (BookingPolicy.objects.filter(is_default=True).first()
                  or BookingPolicy.objects.create(is_default=True))
        policy.max_advance_days = 3
        policy.save()
        from apps.settings_app.models import ScheduleException
        start = soon(1)
        ScheduleException.objects.create(
            name="Closed", club=venue["club"], start_date=start,
            end_date=start + timedelta(days=20), closed=True, is_active=True)
        # The first open date is outside the window, so there is no answer.
        assert next_available_date(
            start, club=venue["club"], facility_type=venue["activity"]) is None


# --------------------------------------------------------------------------- #
# The endpoint
# --------------------------------------------------------------------------- #
class TestCalendarEndpoint:
    def _get(self, api, venue, first=None, last=None):
        return api.get(CALENDAR, {
            "club": venue["club"].id, "facility_type": venue["activity"].id,
            "from": (first or soon(1)).isoformat(),
            "to": (last or soon(20)).isoformat()})

    def test_it_answers_a_whole_range_in_one_request(self, api, venue):
        resp = self._get(api, venue)
        assert resp.status_code == 200, resp.content
        body = resp.json()
        assert len(body["days"]) == 20
        assert body["window"]["max_advance_days"] is not None

    def test_one_request_covers_the_month_without_a_query_per_day(self, api, venue,
                                                                  django_assert_max_num_queries):
        """Section 6: the cost must not grow with the length of the range."""
        availability_cache.invalidate()
        with django_assert_max_num_queries(25):
            self._get(api, venue, soon(1), soon(30))

    def test_next_available_is_offered_when_the_range_is_empty(self, api, venue):
        from apps.settings_app.models import ScheduleException
        ScheduleException.objects.create(
            name="Closed", club=venue["club"], start_date=soon(1),
            end_date=soon(10), closed=True, is_active=True)
        body = self._get(api, venue, soon(1), soon(10)).json()
        assert all(not day["available"] for day in body["days"].values())
        assert body["next_available"] == soon(11).isoformat()

    def test_next_available_is_not_computed_when_the_range_has_dates(self, api, venue):
        body = self._get(api, venue).json()
        assert body["next_available"] is None

    def test_an_absurd_range_is_clamped_rather_than_served(self, api, venue):
        body = self._get(api, venue, soon(1), soon(4000)).json()
        assert len(body["days"]) <= 62

    def test_a_backwards_range_is_refused(self, api, venue):
        assert self._get(api, venue, soon(10), soon(1)).status_code == 400

    def test_a_missing_range_is_refused(self, api, venue):
        assert api.get(CALENDAR, {"club": venue["club"].id}).status_code == 400

    def test_an_unknown_club_is_refused(self, api, venue):
        resp = api.get(CALENDAR, {"club": 999999, "from": soon(1).isoformat(),
                                  "to": soon(5).isoformat()})
        assert resp.status_code == 404

    def test_it_needs_no_account(self, api, venue):
        assert self._get(api, venue).status_code == 200


# --------------------------------------------------------------------------- #
# Freshness
# --------------------------------------------------------------------------- #
class TestCacheFreshness:
    def test_a_new_booking_removes_the_date_it_filled(self, venue):
        target = soon(3)
        assert summary_for(venue)[target.isoformat()]["available"] is True
        fill(venue, target)
        # No explicit invalidation here: writing the bookings must be enough.
        assert summary_for(venue)[target.isoformat()]["available"] is False

    def test_a_cancellation_gives_the_date_back(self, venue):
        target = soon(3)
        fill(venue, target)
        assert summary_for(venue)[target.isoformat()]["available"] is False
        booking = Booking.objects.filter(scheduled_date=target).first()
        booking.status = BookingStatus.CANCELLED
        booking.save()
        assert summary_for(venue)[target.isoformat()]["available"] is True

    def test_closing_the_club_removes_its_dates(self, venue):
        target = soon(3)
        assert summary_for(venue)[target.isoformat()]["available"] is True
        from apps.settings_app.models import ScheduleException
        ScheduleException.objects.create(
            name="Eid", club=venue["club"], start_date=target, end_date=target,
            closed=True, is_active=True)
        assert summary_for(venue)[target.isoformat()]["available"] is False

    def test_a_maintenance_block_removes_its_dates(self, venue):
        target = soon(3)
        assert summary_for(venue)[target.isoformat()]["available"] is True
        from apps.facilities.models import MaintenanceBlock
        MaintenanceBlock.objects.create(
            facility=venue["court"], start_date=target, end_date=target)
        assert summary_for(venue)[target.isoformat()]["available"] is False
