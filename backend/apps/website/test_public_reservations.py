"""Holding a court over HTTP, then spending the hold on a booking.

`apps/bookings/test_reservations.py` covers the engine. This covers the
customer-facing contract, and in particular the one join that can go wrong in
a way nothing else would notice: a customer's OWN reservation must not report
their own slot as taken when they finally check out. Get that wrong and every
reserved checkout fails at the last step with "that time was just taken",
which is both baffling and unrecoverable.

The other half is the deadline. It is issued by the server, absolute, and
enforced when read, because a countdown that trusted the device clock would
let a phone twenty minutes fast declare a perfectly good reservation dead.
"""

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings.models import (
    Booking, BookingHold, BookingOrder, HoldStatus,
)

pytestmark = pytest.mark.django_db

RESERVATIONS = "/api/v1/website/public/reservations/"
BOOKINGS = "/api/v1/website/public/bookings/"
ORDERS = "/api/v1/website/public/orders/"


def _open_all_week():
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture
def venue(db, tax_rate):
    """One club, one activity, exactly ONE court, so capacity is one."""
    from apps.clubs.models import Club
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.save()

    club = Club.objects.create(name="Hold Club", code="HOLDC", is_active=True,
                               booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Tennis Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Court A", club=club, is_active=True)
    court.facility_types.add(activity)
    return {"club": club, "activity": activity, "court": court}


@pytest.fixture
def multi(db):
    """Let the website offer more than one slot per checkout."""
    from apps.bookings.models import BookingPolicy
    policy = (BookingPolicy.objects.filter(is_default=True).first()
              or BookingPolicy.objects.create(is_default=True))
    policy.allow_multiple_slots = True
    policy.allow_multiple_dates = True
    policy.max_slots_per_booking = 5
    policy.save()
    return policy


def a_date(days=6):
    return timezone.localdate() + timedelta(days=days)


def reserve(api, venue, times, on=None):
    day = (on or a_date()).isoformat()
    return api.post(RESERVATIONS, {
        "club": venue["club"].id,
        "facility_type": venue["activity"].id,
        "slots": [{"date": day, "time": t} for t in times],
    }, format="json")


def booking_body(venue, time="19:00", on=None, **extra):
    return {
        "club": venue["club"].id,
        "facility_type": venue["activity"].id,
        "date": (on or a_date()).isoformat(),
        "time": time,
        "name": "Held Player",
        "email": "held@nadena.sa",
        "phone": "+966500000044",
        **extra,
    }


# --------------------------------------------------------------------------- #
# Claiming
# --------------------------------------------------------------------------- #
class TestClaimingACourt:
    def test_a_reservation_is_created_and_returns_its_token_once(self, api, venue):
        response = reserve(api, venue, ["19:00"])
        assert response.status_code == 201, response.data
        assert response.data["token"]
        assert response.data["reference"].startswith("HLD-")
        assert response.data["seconds_remaining"] > 0

    def test_the_deadline_is_absolute_and_comes_with_the_server_clock(self, api, venue):
        """So a countdown never has to trust the device."""
        data = reserve(api, venue, ["19:00"]).data
        assert data["expires_at"]
        assert data["server_time"]

    def test_the_held_slots_are_reported_back(self, api, venue, multi):
        data = reserve(api, venue, ["19:00", "20:00"]).data
        assert [s["time"] for s in data["slots"]] == ["19:00", "20:00"]
        assert data["slots"][0]["end"] == "20:00"

    def test_a_single_date_and_time_works_without_a_slots_list(self, api, venue):
        response = api.post(RESERVATIONS, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "date": a_date().isoformat(), "time": "19:00",
        }, format="json")
        assert response.status_code == 201, response.data

    def test_a_second_reservation_for_the_same_court_is_refused(self, api, venue):
        assert reserve(api, venue, ["19:00"]).status_code == 201
        second = reserve(api, venue, ["19:00"])
        assert second.status_code == 409
        assert second.data["code"] == "slot_unavailable"

    def test_a_reservation_blocks_the_booking_endpoint_too(self, api, venue):
        reserve(api, venue, ["19:00"])
        response = api.post(BOOKINGS, booking_body(venue), format="json")
        assert response.status_code == 409, response.data

    def test_choosing_nothing_is_refused(self, api, venue):
        response = api.post(RESERVATIONS, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id, "slots": [],
        }, format="json")
        assert response.status_code == 400
        assert response.data["code"] == "no_slots"

    def test_an_unknown_club_is_refused(self, api, venue):
        response = api.post(RESERVATIONS, {
            "club": 999999, "facility_type": venue["activity"].id,
            "slots": [{"date": a_date().isoformat(), "time": "19:00"}],
        }, format="json")
        assert response.status_code == 400

    def test_a_slot_outside_the_booking_window_is_refused_before_it_is_held(
            self, api, venue):
        """A court held for a slot that could never be booked is a court lost."""
        from apps.bookings.models import BookingPolicy
        policy = (BookingPolicy.objects.filter(is_default=True).first()
                  or BookingPolicy.objects.create(is_default=True))
        policy.max_advance_days = 2
        policy.save()
        response = reserve(api, venue, ["19:00"], on=a_date(30))
        assert response.status_code == 400, response.data
        assert not BookingHold.objects.exists()


# --------------------------------------------------------------------------- #
# Reading and releasing
# --------------------------------------------------------------------------- #
class TestReadingAndReleasing:
    def test_the_countdown_can_be_read_back_after_a_refresh(self, api, venue):
        token = reserve(api, venue, ["19:00"]).data["token"]
        response = api.get(f"{RESERVATIONS}{token}/")
        assert response.status_code == 200
        assert response.data["status"] == HoldStatus.ACTIVE
        assert response.data["seconds_remaining"] > 0

    def test_reading_never_hands_the_token_out_again(self, api, venue):
        token = reserve(api, venue, ["19:00"]).data["token"]
        assert "token" not in api.get(f"{RESERVATIONS}{token}/").data

    def test_an_unknown_token_is_not_found(self, api, venue):
        assert api.get(f"{RESERVATIONS}nonsense/").status_code == 404

    def test_an_expired_reservation_reads_as_expired_before_the_sweep_runs(
            self, api, venue):
        """The sweep runs every few minutes. Reading must not wait for it."""
        token = reserve(api, venue, ["19:00"]).data["token"]
        hold = BookingHold.objects.get()
        hold.expires_at = timezone.now() - timedelta(minutes=1)
        hold.save(update_fields=["expires_at"])

        data = api.get(f"{RESERVATIONS}{token}/").data
        assert data["status"] == HoldStatus.EXPIRED
        assert data["seconds_remaining"] == 0

    def test_an_expired_reservation_frees_the_court_for_somebody_else(
            self, api, venue):
        reserve(api, venue, ["19:00"])
        hold = BookingHold.objects.get()
        hold.expires_at = timezone.now() - timedelta(minutes=1)
        hold.save(update_fields=["expires_at"])
        assert reserve(api, venue, ["19:00"]).status_code == 201

    def test_giving_up_a_reservation_frees_the_court_at_once(self, api, venue):
        token = reserve(api, venue, ["19:00"]).data["token"]
        assert api.delete(f"{RESERVATIONS}{token}/").status_code == 200
        assert reserve(api, venue, ["19:00"]).status_code == 201

    def test_releasing_twice_is_not_an_error(self, api, venue):
        token = reserve(api, venue, ["19:00"]).data["token"]
        assert api.delete(f"{RESERVATIONS}{token}/").status_code == 200
        assert api.delete(f"{RESERVATIONS}{token}/").status_code == 200


# --------------------------------------------------------------------------- #
# Spending the reservation
# --------------------------------------------------------------------------- #
class TestCheckingOutAgainstAReservation:
    def test_a_customer_can_book_the_slot_they_reserved(self, api, venue):
        """The join that breaks everything if it is wrong.

        Their own hold is still live and still blocking the only court, so
        without the exclusion this is a 409 every single time.
        """
        token = reserve(api, venue, ["19:00"]).data["token"]
        response = api.post(BOOKINGS,
                            booking_body(venue, reservation=token), format="json")
        assert response.status_code == 201, response.data

    def test_the_reservation_is_converted_not_left_running(self, api, venue):
        token = reserve(api, venue, ["19:00"]).data["token"]
        api.post(BOOKINGS, booking_body(venue, reservation=token), format="json")
        hold = BookingHold.objects.get()
        assert hold.status == HoldStatus.CONVERTED
        assert hold.booking_id == Booking.objects.get().id

    def test_the_court_is_still_taken_afterwards(self, api, venue):
        """The booking blocks it now. There must be no gap where it looks free."""
        token = reserve(api, venue, ["19:00"]).data["token"]
        api.post(BOOKINGS, booking_body(venue, reservation=token), format="json")
        assert reserve(api, venue, ["19:00"]).status_code == 409

    def test_booking_without_a_reservation_still_works(self, api, venue):
        """Backward compatible: an un-updated client is not broken."""
        assert api.post(BOOKINGS, booking_body(venue),
                        format="json").status_code == 201

    def test_an_expired_reservation_is_refused_at_the_payment_step(self, api, venue):
        token = reserve(api, venue, ["19:00"]).data["token"]
        hold = BookingHold.objects.get()
        hold.expires_at = timezone.now() - timedelta(minutes=1)
        hold.save(update_fields=["expires_at"])

        response = api.post(BOOKINGS, booking_body(venue, reservation=token),
                            format="json")
        assert response.status_code == 409
        assert response.data["code"] == "hold_expired"

    def test_a_token_cannot_be_spent_on_a_slot_it_does_not_hold(self, api, venue):
        """Otherwise a 7pm token would quietly release a 7pm court to pay for 8pm."""
        token = reserve(api, venue, ["19:00"]).data["token"]
        response = api.post(
            BOOKINGS, booking_body(venue, time="21:00", reservation=token),
            format="json")
        assert response.status_code == 409
        assert response.data["code"] == "hold_mismatch"
        assert BookingHold.objects.get().status == HoldStatus.ACTIVE

    def test_a_token_from_another_club_is_refused(self, api, venue):
        from apps.clubs.models import Club
        from apps.facilities.models import Facility

        other = Club.objects.create(name="Other Club", code="OTHR",
                                    is_active=True, booking_hours=_open_all_week())
        court = Facility.objects.create(name="Other 1", club=other, is_active=True)
        court.facility_types.add(venue["activity"])
        token = api.post(RESERVATIONS, {
            "club": other.id, "facility_type": venue["activity"].id,
            "slots": [{"date": a_date().isoformat(), "time": "19:00"}],
        }, format="json").data["token"]

        response = api.post(BOOKINGS, booking_body(venue, reservation=token),
                            format="json")
        assert response.status_code == 409
        assert response.data["code"] == "hold_mismatch"

    def test_rubbish_in_the_reservation_field_is_refused_not_ignored(self, api, venue):
        """Silently ignoring it would book without the court ever being held."""
        response = api.post(BOOKINGS, booking_body(venue, reservation="nonsense"),
                            format="json")
        assert response.status_code == 409
        assert response.data["code"] == "invalid_hold"


class TestMultiSlotCheckout:
    def test_an_order_can_be_placed_against_a_reservation(self, api, venue, multi):
        token = reserve(api, venue, ["19:00", "20:00"]).data["token"]
        day = a_date().isoformat()
        response = api.post(ORDERS, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "slots": [{"date": day, "time": "19:00"}, {"date": day, "time": "20:00"}],
            "name": "Held Player", "email": "held@nadena.sa",
            "phone": "+966500000044", "reservation": token,
        }, format="json")
        assert response.status_code == 201, response.data
        assert response.data["slot_count"] == 2

    def test_the_reservation_converts_to_the_order(self, api, venue, multi):
        token = reserve(api, venue, ["19:00", "20:00"]).data["token"]
        day = a_date().isoformat()
        api.post(ORDERS, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "slots": [{"date": day, "time": "19:00"}, {"date": day, "time": "20:00"}],
            "name": "Held Player", "email": "held@nadena.sa",
            "phone": "+966500000044", "reservation": token,
        }, format="json")
        hold = BookingHold.objects.get()
        assert hold.status == HoldStatus.CONVERTED
        assert hold.order_id == BookingOrder.objects.get().id
        assert hold.booking_id is None

    def test_booking_fewer_slots_than_were_reserved_is_allowed(self, api, venue, multi):
        """They reserved two and completed one. The reservation is still theirs."""
        token = reserve(api, venue, ["19:00", "20:00"]).data["token"]
        response = api.post(BOOKINGS, booking_body(venue, reservation=token),
                            format="json")
        assert response.status_code == 201, response.data

    def test_booking_a_slot_outside_the_reservation_is_refused(self, api, venue, multi):
        token = reserve(api, venue, ["19:00"]).data["token"]
        day = a_date().isoformat()
        response = api.post(ORDERS, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "slots": [{"date": day, "time": "19:00"}, {"date": day, "time": "20:00"}],
            "name": "Held Player", "email": "held@nadena.sa",
            "phone": "+966500000044", "reservation": token,
        }, format="json")
        assert response.status_code == 409
        assert response.data["code"] == "hold_mismatch"
