"""Reservation holds: claiming a court while the customer pays.

The hold exists so a booking does not have to be created unpaid in order to
keep a slot. What matters is therefore not that it stores a deadline, but
that it behaves like a booking to everything that asks "is this court free?",
and stops behaving that way the moment its time is up.

The threaded half lives in `test_reservations_concurrency.py`.
"""

from datetime import date, time, timedelta
from decimal import Decimal

import pytest
from django.core.cache import cache
from django.utils import timezone

from apps.bookings import availability_cache, reservations
from apps.bookings.models import (
    BookingHold, BookingHoldSlot, BookingStatus, HoldStatus,
)
from apps.bookings.services import available_slots, slot_is_available

pytestmark = pytest.mark.django_db


def _open_all_week():
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": "08:00", "close": "22:00"}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture(autouse=True)
def _fresh_cache():
    cache.clear()
    availability_cache.invalidate()


@pytest.fixture
def venue(db, tax_rate):
    """One club, one activity, ONE court, so every clash is unambiguous."""
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.hold_unpaid_minutes = 10
    org.hold_partly_paid_minutes = 30
    org.hold_max_minutes = 120
    org.save()

    club = Club.objects.create(name="Hold Club", code="HOLD", is_active=True,
                               booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Padel Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Court 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customer = Customer.objects.create(
        full_name="Layla", email="layla@hold.test", mobile_number="+966540001111")
    return {"club": club, "activity": activity, "court": court,
            "customer": customer, "org": org}


def soon(days=5):
    return timezone.localdate() + timedelta(days=days)


def take(venue, *times, on=None, **kwargs):
    day = on or soon()
    return reservations.acquire(
        club=venue["club"], facility_type=venue["activity"],
        slots=[(day, time(int(t.split(":")[0]), int(t.split(":")[1]))) for t in times],
        **kwargs)


def free_at(venue, at="19:00", on=None):
    hour, minute = (int(part) for part in at.split(":"))
    return slot_is_available(on or soon(), time(hour, minute),
                             club=venue["club"], facility_type=venue["activity"])


class TestAHoldBlocksTheCourt:
    def test_holding_a_slot_makes_it_unavailable(self, venue):
        assert free_at(venue) is True
        take(venue, "19:00")
        assert free_at(venue) is False

    def test_it_disappears_from_the_slot_list(self, venue):
        take(venue, "19:00")
        by_time = {s["time"]: s["available"] for s
                   in available_slots(soon(), club=venue["club"],
                                      facility_type=venue["activity"])}
        assert by_time["19:00"] == 0
        assert by_time["20:00"] == 1

    def test_it_disappears_from_the_month_summary(self, venue):
        from apps.bookings.services import date_availability_summary
        day = soon()
        for hour in range(8, 22):
            take(venue, f"{hour:02d}:00", on=day)
        summary = date_availability_summary(day, day, club=venue["club"],
                                            facility_type=venue["activity"])
        assert summary[day.isoformat()]["available"] is False

    def test_a_booking_cannot_take_a_held_court(self, venue, auth_api):
        take(venue, "19:00")
        resp = auth_api.post("/api/v1/bookings/", {
            "customer": venue["customer"].id, "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "scheduled_date": soon().isoformat(), "scheduled_time": "19:00",
        }, format="json")
        assert resp.status_code == 400, resp.content

    def test_a_second_hold_cannot_take_the_same_court(self, venue):
        take(venue, "19:00")
        with pytest.raises(reservations.SlotUnavailable) as exc:
            take(venue, "19:00")
        assert exc.value.slots[0]["time"] == "19:00"

    def test_a_hold_cannot_take_a_court_a_booking_already_has(self, venue, auth_api):
        auth_api.post("/api/v1/bookings/", {
            "customer": venue["customer"].id, "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "scheduled_date": soon().isoformat(), "scheduled_time": "19:00",
        }, format="json")
        with pytest.raises(reservations.SlotUnavailable):
            take(venue, "19:00")


class TestAllOrNothing:
    def test_several_slots_are_claimed_together(self, venue):
        hold, _token = take(venue, "19:00", "20:00", "21:00")
        assert hold.slots.count() == 3
        assert all(not free_at(venue, at) for at in ("19:00", "20:00", "21:00"))

    def test_one_unavailable_slot_takes_the_whole_request_with_it(self, venue):
        """Reserving two of three would lock courts for a booking that is not
        going to happen."""
        take(venue, "20:00")
        before = BookingHoldSlot.objects.count()
        with pytest.raises(reservations.SlotUnavailable) as exc:
            take(venue, "19:00", "20:00", "21:00")
        assert [s["time"] for s in exc.value.slots] == ["20:00"]
        assert BookingHoldSlot.objects.count() == before
        # 19:00 and 21:00 were never taken.
        assert free_at(venue, "19:00") is True
        assert free_at(venue, "21:00") is True

    def test_one_hold_cannot_take_the_same_court_twice_over(self, venue):
        """With a single court, two overlapping times cannot both be held."""
        venue["activity"].duration_minutes = 120
        venue["activity"].save()
        with pytest.raises(reservations.SlotUnavailable):
            take(venue, "19:00", "20:00")

    def test_slots_may_span_several_dates(self, venue):
        day, later = soon(), soon(6)
        hold, _token = reservations.acquire(
            club=venue["club"], facility_type=venue["activity"],
            slots=[(day, time(19, 0)), (later, time(19, 0))])
        assert hold.slots.count() == 2
        assert free_at(venue, on=day) is False
        assert free_at(venue, on=later) is False


class TestTheDeadline:
    def test_a_new_hold_uses_the_unpaid_window(self, venue):
        hold, _token = take(venue, "19:00")
        minutes = (hold.expires_at - timezone.now()).total_seconds() / 60
        assert 9 < minutes <= 10

    def test_a_club_can_shorten_its_own_window(self, venue):
        venue["club"].hold_unpaid_minutes = 3
        venue["club"].save()
        hold, _token = take(venue, "19:00")
        minutes = (hold.expires_at - timezone.now()).total_seconds() / 60
        assert 2 < minutes <= 3

    def test_an_expired_hold_stops_blocking_even_before_the_sweep(self, venue):
        """Section 20: the clock is read, not the job's last run."""
        hold, _token = take(venue, "19:00")
        assert free_at(venue) is False
        BookingHold.objects.filter(pk=hold.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1))
        availability_cache.invalidate()
        # Still ACTIVE in the table, but out of time.
        assert BookingHold.objects.get(pk=hold.pk).status == HoldStatus.ACTIVE
        assert free_at(venue) is True

    def test_the_sweep_marks_them_expired(self, venue):
        hold, _token = take(venue, "19:00")
        BookingHold.objects.filter(pk=hold.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1))
        assert reservations.expire_due() == 1
        assert BookingHold.objects.get(pk=hold.pk).status == HoldStatus.EXPIRED

    def test_the_sweep_is_safe_to_run_twice(self, venue):
        hold, _token = take(venue, "19:00")
        BookingHold.objects.filter(pk=hold.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1))
        assert reservations.expire_due() == 1
        assert reservations.expire_due() == 0

    def test_an_expired_court_can_be_claimed_again(self, venue):
        hold, _token = take(venue, "19:00")
        BookingHold.objects.filter(pk=hold.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1))
        reservations.expire_due()
        again, _token2 = take(venue, "19:00")
        assert again.slots.count() == 1


class TestExtendingForAPartPayment:
    def test_the_first_payment_buys_the_longer_window(self, venue):
        hold, _token = take(venue, "19:00")
        extended = reservations.extend_for_part_payment(hold)
        minutes = (extended.expires_at - timezone.now()).total_seconds() / 60
        assert 29 < minutes <= 30

    def test_it_happens_only_once(self, venue):
        """Otherwise friends paying a pound at a time hold the court all day."""
        hold, _token = take(venue, "19:00")
        first = reservations.extend_for_part_payment(hold).expires_at
        second = reservations.extend_for_part_payment(
            BookingHold.objects.get(pk=hold.pk)).expires_at
        assert first == second

    def test_it_can_never_pass_the_ceiling(self, venue):
        venue["org"].hold_partly_paid_minutes = 500
        venue["org"].hold_max_minutes = 15
        venue["org"].save()
        hold, _token = take(venue, "19:00")
        extended = reservations.extend_for_part_payment(hold)
        assert extended.expires_at <= extended.max_expires_at
        minutes = (extended.expires_at - timezone.now()).total_seconds() / 60
        assert minutes <= 15

    def test_an_expired_hold_is_not_revived_by_a_late_payment(self, venue):
        hold, _token = take(venue, "19:00")
        reservations.expire(hold)
        unchanged = reservations.extend_for_part_payment(
            BookingHold.objects.get(pk=hold.pk))
        assert unchanged.status == HoldStatus.EXPIRED


class TestFindingAHoldAgain:
    def test_the_token_finds_it(self, venue):
        hold, token = take(venue, "19:00")
        assert reservations.resolve(token).pk == hold.pk

    def test_a_wrong_token_finds_nothing(self, venue):
        take(venue, "19:00")
        assert reservations.resolve("not-a-real-token") is None

    def test_the_raw_token_is_never_stored(self, venue):
        """A leaked backup must not be replayable as a working reservation."""
        _hold, token = take(venue, "19:00")
        assert not BookingHold.objects.filter(token_hash=token).exists()

    def test_a_live_hold_is_returned(self, venue):
        _hold, token = take(venue, "19:00")
        assert reservations.require_live(token).is_live is True

    def test_an_expired_hold_refuses_and_marks_itself(self, venue):
        hold, token = take(venue, "19:00")
        BookingHold.objects.filter(pk=hold.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1))
        with pytest.raises(reservations.HoldExpired):
            reservations.require_live(token)
        # Asking also settled it, rather than leaving it for the sweep.
        assert BookingHold.objects.get(pk=hold.pk).status == HoldStatus.EXPIRED

    def test_an_unknown_token_is_told_apart_from_an_expired_one(self, venue):
        with pytest.raises(reservations.HoldExpired) as exc:
            reservations.require_live("nope")
        assert exc.value.code == "invalid_hold"

    def test_the_countdown_comes_from_the_deadline(self, venue):
        hold, _token = take(venue, "19:00")
        assert 500 < hold.seconds_remaining <= 600

    def test_a_finished_hold_counts_down_to_nothing(self, venue):
        hold, _token = take(venue, "19:00")
        reservations.release(hold)
        assert BookingHold.objects.get(pk=hold.pk).seconds_remaining == 0


class TestGivingTheCourtBack:
    def test_releasing_frees_the_slot(self, venue):
        hold, _token = take(venue, "19:00")
        reservations.release(hold)
        assert free_at(venue) is True

    def test_releasing_twice_changes_nothing(self, venue):
        hold, _token = take(venue, "19:00")
        reservations.release(hold)
        again = reservations.release(BookingHold.objects.get(pk=hold.pk))
        assert again.status == HoldStatus.RELEASED

    def test_converting_keeps_the_court_blocked_throughout(self, venue):
        """The booking is already holding it, so there is no moment when the
        court looks free to anybody else."""
        from apps.bookings.models import Booking
        hold, _token = take(venue, "19:00")
        booking = Booking.objects.create(
            customer=venue["customer"], club=venue["club"],
            facility_type=venue["activity"], facility=venue["court"],
            scheduled_date=soon(), scheduled_time=time(19, 0),
            end_time=time(20, 0), status=BookingStatus.CONFIRMED,
            currency="SAR", total_amount=Decimal("100.000"))
        reservations.convert(hold, booking=booking)
        assert BookingHold.objects.get(pk=hold.pk).status == HoldStatus.CONVERTED
        assert free_at(venue) is False       # now held by the booking

    def test_a_converted_hold_does_not_expire_the_booking(self, venue):
        """Section 45: a session timer must never release a paid booking."""
        from apps.bookings.models import Booking
        hold, _token = take(venue, "19:00")
        booking = Booking.objects.create(
            customer=venue["customer"], club=venue["club"],
            facility_type=venue["activity"], facility=venue["court"],
            scheduled_date=soon(), scheduled_time=time(19, 0),
            end_time=time(20, 0), status=BookingStatus.CONFIRMED,
            currency="SAR", total_amount=Decimal("100.000"))
        reservations.convert(hold, booking=booking)
        BookingHold.objects.filter(pk=hold.pk).update(
            expires_at=timezone.now() - timedelta(hours=1))
        reservations.expire_due()
        assert free_at(venue) is False
        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED


class TestAHeldSlotIsNotCalledBooked:
    """"Fully booked" and "somebody is paying for it" are different facts.

    They look identical in an availability payload that merges holds into
    bookings, and the website then told customers a court was booked when
    nobody had booked it and it might well be free again in minutes.
    """

    def slot_at(self, venue, at="19:00"):
        return next(s for s in available_slots(
            soon(), club=venue["club"], facility_type=venue["activity"])
            if s["time"] == at)

    def book_it(self, venue):
        from apps.bookings.models import Booking
        return Booking.objects.create(
            customer=venue["customer"], club=venue["club"],
            facility_type=venue["activity"], facility=venue["court"],
            scheduled_date=soon(), scheduled_time=time(19, 0),
            end_time=time(20, 0), status=BookingStatus.CONFIRMED,
            currency="SAR", total_amount=Decimal("100.000"))

    def test_a_held_slot_says_how_many_courts_are_held(self, venue):
        take(venue, "19:00")
        slot = self.slot_at(venue)
        assert slot["available"] == 0
        assert slot["held"] == 1

    def test_a_genuinely_booked_slot_reports_no_holds(self, venue):
        """So the two can be told apart from the payload alone."""
        self.book_it(venue)
        slot = self.slot_at(venue)
        assert slot["available"] == 0
        assert slot["held"] == 0

    def test_a_free_slot_reports_no_holds(self, venue):
        slot = self.slot_at(venue)
        assert slot["available"] >= 1
        assert slot["held"] == 0

    def test_a_court_both_booked_and_held_counts_as_booked(self, venue):
        """The state that will not change when a clock runs out wins."""
        self.book_it(venue)
        slot = self.slot_at(venue)
        assert slot["booked"] == 1
        assert slot["held"] == 0

    def test_the_slot_is_free_again_once_the_reservation_ends(self, venue):
        hold, _token = take(venue, "19:00")
        reservations.release(hold)
        slot = self.slot_at(venue)
        assert slot["available"] >= 1
        assert slot["held"] == 0
