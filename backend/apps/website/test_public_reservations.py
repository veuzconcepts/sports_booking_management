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

from datetime import time, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings.models import (
    SLOT_BLOCKING_STATUSES, Booking, BookingHold, BookingOrder,
    BookingStatus, HoldStatus,
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


class TestThrottling:
    """Reservations must not eat the booking allowance.

    Claiming happens on reaching checkout and again on every change of mind,
    so putting it on the booking scope meant ordinary browsing exhausted the
    allowance and the BOOKING was then refused for the rest of the hour. The
    customer saw "Request was throttled. Expected available in 2615 seconds."
    where the countdown should have been.
    """

    def test_reservations_have_their_own_scope(self):
        from apps.website.reservation_views import PublicReservationCreateView

        scope = PublicReservationCreateView.throttle_scope
        assert scope == "public_reservation", scope
        assert scope != "public_booking"

    def test_the_reservation_allowance_is_larger_than_the_booking_one(self, settings):
        def per_hour(rate):
            count, _, period = rate.partition("/")
            factor = {"min": 60, "hour": 1, "day": 1 / 24}[period.rstrip("s")]
            return int(count) * factor

        rates = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
        assert per_hour(rates["public_reservation"]) > per_hour(rates["public_booking"])

    def test_reading_and_releasing_are_never_throttled(self):
        """A refused release leaves a court locked until its deadline.

        Rate limiting the operation that FREES a resource protects nobody and
        costs the club a slot it could have sold.
        """
        from apps.website.reservation_views import PublicReservationView

        assert PublicReservationView.throttle_scope is None

    def test_claiming_many_times_does_not_block_booking(self, api, venue, multi):
        """The failure as the customer met it, end to end."""
        day = a_date().isoformat()
        for hour in range(8, 20):        # comfortably past the 12/hour booking rate
            response = api.post(RESERVATIONS, {
                "club": venue["club"].id,
                "facility_type": venue["activity"].id,
                "slots": [{"date": day, "time": f"{hour:02d}:00"}],
            }, format="json")
            assert response.status_code != 429, (
                f"throttled after {hour - 8} reservations: {response.data}")

        booked = api.post(BOOKINGS, booking_body(venue, time="21:00"), format="json")
        assert booked.status_code == 201, booked.data


class TestTheCountdownCanBeHidden:
    """A club may prefer not to put a clock in front of a card form.

    Display only. The court is held exactly the same either way, which is the
    property worth protecting: a setting that quietly stopped holding courts
    would reintroduce the double booking this whole feature exists to prevent.
    """

    def test_the_countdown_is_shown_by_default(self, api, venue):
        assert reserve(api, venue, ["19:00"]).data["show_countdown"] is True

    def test_a_club_can_hide_it(self, api, venue):
        venue["club"].show_hold_countdown = False
        venue["club"].save()
        assert reserve(api, venue, ["19:00"]).data["show_countdown"] is False

    def test_the_organization_default_applies_when_the_club_says_nothing(
            self, api, venue):
        from apps.settings_app.models import Organization
        org = Organization.get_solo()
        org.show_hold_countdown = False
        org.save()
        assert venue["club"].show_hold_countdown is None
        assert reserve(api, venue, ["19:00"]).data["show_countdown"] is False

    def test_a_club_can_show_it_while_the_organization_hides_it(self, api, venue):
        from apps.settings_app.models import Organization
        org = Organization.get_solo()
        org.show_hold_countdown = False
        org.save()
        venue["club"].show_hold_countdown = True
        venue["club"].save()
        assert reserve(api, venue, ["19:00"]).data["show_countdown"] is True

    def test_hiding_it_still_holds_the_court(self, api, venue):
        """The whole point. Presentation must not change behaviour."""
        venue["club"].show_hold_countdown = False
        venue["club"].save()
        assert reserve(api, venue, ["19:00"]).status_code == 201
        assert reserve(api, venue, ["19:00"]).status_code == 409

    def test_reading_it_back_reports_the_same_answer(self, api, venue):
        venue["club"].show_hold_countdown = False
        venue["club"].save()
        token = reserve(api, venue, ["19:00"]).data["token"]
        assert api.get(f"{RESERVATIONS}{token}/").data["show_countdown"] is False


AVAILABILITY = "/api/v1/website/public/availability/"


class TestTheWireCarriesTheHeldCount:
    """The payload the BROWSER receives, not the dict the engine builds.

    `available_slots` grew a `held` count and `public_availability` rebuilt
    every slot from an explicit list of keys, which quietly dropped it. The
    rule in the website was correct and never fired, because the field it
    reads was never sent. A test of the rule alone passed throughout.
    """

    def ask(self, api, venue, on=None):
        return api.get(AVAILABILITY, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "date": (on or a_date()).isoformat(),
        })

    def slot(self, response, at="19:00"):
        return next(s for s in response.data["slots"] if s["time"] == at)

    def test_every_slot_reports_a_held_count(self, api, venue):
        response = self.ask(api, venue)
        assert response.status_code == 200, response.data
        assert all("held" in s for s in response.data["slots"])

    def test_a_free_slot_is_held_by_nobody(self, api, venue):
        assert self.slot(self.ask(api, venue))["held"] == 0

    def test_a_reserved_slot_is_reported_as_held_not_merely_unavailable(
            self, api, venue):
        """The customer-visible difference: withdrawn, not "fully booked"."""
        reserve(api, venue, ["19:00"])
        slot = self.slot(self.ask(api, venue))
        assert slot["available"] == 0
        assert slot["held"] == 1

    def test_a_booked_slot_is_unavailable_but_not_held(self, api, venue):
        from apps.bookings.models import Booking, BookingStatus

        Booking.objects.create(
            club=venue["club"], facility=venue["court"],
            facility_type=venue["activity"], scheduled_date=a_date(),
            scheduled_time=__import__("datetime").time(19, 0),
            end_time=__import__("datetime").time(20, 0), duration_minutes=60,
            status=BookingStatus.CONFIRMED, currency="SAR",
            total_amount=Decimal("100.000"))
        slot = self.slot(self.ask(api, venue))
        assert slot["available"] == 0
        assert slot["held"] == 0

    def test_releasing_puts_the_slot_back_on_the_wire_as_free(self, api, venue):
        token = reserve(api, venue, ["19:00"]).data["token"]
        api.delete(f"{RESERVATIONS}{token}/")
        slot = self.slot(self.ask(api, venue))
        assert slot["available"] >= 1
        assert slot["held"] == 0


class TestPayingAfterTheReservationRanOut:
    """Confirmed policy: if the slot is still free, let them finish.

    A reservation is protection against somebody else taking the court while
    the customer pays. Once it has lapsed that protection is simply gone; it
    is not a punishment. Refusing a customer who is standing there with their
    card out, for a court nobody else wants, would lose the club a booking for
    no reason.

    So the checkout drops the dead token and books normally. What it must NOT
    do is spend the dead token, because converting an expired reservation
    would claim a court on the strength of a claim that has lapsed.
    """

    def test_the_slot_can_still_be_booked_once_the_reservation_lapses(
            self, api, venue):
        token = reserve(api, venue, ["19:00"]).data["token"]
        hold = BookingHold.objects.get()
        hold.expires_at = timezone.now() - timedelta(minutes=1)
        hold.save(update_fields=["expires_at"])

        # No reservation field: exactly what the browser sends once the
        # countdown has run out and the stored token has been dropped.
        response = api.post(BOOKINGS, booking_body(venue), format="json")
        assert response.status_code == 201, response.data
        assert token                                    # it existed, and is now moot

    def test_the_court_is_properly_taken_by_that_booking(self, api, venue):
        reserve(api, venue, ["19:00"])
        hold = BookingHold.objects.get()
        hold.expires_at = timezone.now() - timedelta(minutes=1)
        hold.save(update_fields=["expires_at"])
        api.post(BOOKINGS, booking_body(venue), format="json")

        # A second customer is refused, so this is a real booking rather than
        # one that slipped through an expired gap.
        assert reserve(api, venue, ["19:00"]).status_code == 409

    def test_somebody_else_may_have_taken_it_first(self, api, venue):
        """The other half of letting a lapsed reservation go: it is a race
        the customer can lose, and losing it has to be said plainly."""
        reserve(api, venue, ["19:00"])
        hold = BookingHold.objects.get()
        hold.expires_at = timezone.now() - timedelta(minutes=1)
        hold.save(update_fields=["expires_at"])

        rival = reserve(api, venue, ["19:00"])          # claims the freed court
        assert rival.status_code == 201

        response = api.post(BOOKINGS, booking_body(venue), format="json")
        assert response.status_code == 409, response.data

    def test_the_dead_token_itself_is_still_refused(self, api, venue):
        """Dropping the token is the checkout's job. Spending it is not
        allowed, because converting a lapsed reservation would claim a court
        on a claim that has expired."""
        token = reserve(api, venue, ["19:00"]).data["token"]
        hold = BookingHold.objects.get()
        hold.expires_at = timezone.now() - timedelta(minutes=1)
        hold.save(update_fields=["expires_at"])

        response = api.post(BOOKINGS, booking_body(venue, reservation=token),
                            format="json")
        assert response.status_code == 409
        assert response.data["code"] == "hold_expired"


class TestOneCustomerCannotTakeAnothersHeldCourt:
    """The hard boundary on letting a lapsed reservation still pay.

    "If the slot is free, let them finish" must never become "let them finish
    regardless". The moment somebody ELSE is holding that court, inside their
    own window, the first customer is refused. Two people paying for one court
    is the failure this whole feature exists to prevent, and a lapsed
    reservation must not become a back door into it.

    Every entry point is checked, because one that forgot would be a real
    double booking rather than a cosmetic bug.
    """

    def steal(self, api, venue, times=("19:00",)):
        """Let a first reservation lapse, then have a second customer take it."""
        reserve(api, venue, list(times))
        for hold in BookingHold.objects.all():
            hold.expires_at = timezone.now() - timedelta(minutes=1)
            hold.save(update_fields=["expires_at"])
        rival = reserve(api, venue, list(times))
        assert rival.status_code == 201, rival.data
        return rival.data["token"]

    def test_the_single_booking_endpoint_refuses(self, api, venue):
        self.steal(api, venue)
        response = api.post(BOOKINGS, booking_body(venue), format="json")
        assert response.status_code == 409, response.data
        assert not Booking.objects.exists()

    def test_the_order_endpoint_refuses(self, api, venue, multi):
        """The multi-slot path allocates through the same engine, and has to
        be held to the same rule."""
        self.steal(api, venue, ("19:00", "20:00"))
        day = a_date().isoformat()
        response = api.post(ORDERS, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "slots": [{"date": day, "time": "19:00"}, {"date": day, "time": "20:00"}],
            "name": "Second Player", "email": "second@nadena.sa",
            "phone": "+966500000055",
        }, format="json")
        assert response.status_code == 409, response.data
        assert not BookingOrder.objects.exists()
        assert not Booking.objects.exists()

    def test_an_order_is_refused_whole_when_one_slot_is_held(self, api, venue, multi):
        """All or nothing: the free slot must not be booked on its own,
        leaving the customer half a purchase they did not ask for."""
        reserve(api, venue, ["20:00"])                  # somebody holds 20:00 only
        day = a_date().isoformat()
        response = api.post(ORDERS, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "slots": [{"date": day, "time": "19:00"}, {"date": day, "time": "20:00"}],
            "name": "Second Player", "email": "second@nadena.sa",
            "phone": "+966500000055",
        }, format="json")
        assert response.status_code == 409, response.data
        assert not Booking.objects.exists()

    def test_the_admin_is_refused_too(self, api, venue, auth_api):
        """Staff go through `allocate_facility`, which reads the same holds."""
        self.steal(api, venue)
        response = auth_api.post("/api/v1/bookings/", {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "scheduled_date": a_date().isoformat(),
            "scheduled_time": "19:00",
            "booking_type": "walk_in",
            "walk_in_name": "Desk Customer",
        }, format="json")
        assert response.status_code == 400, response.data
        assert not Booking.objects.exists()

    def test_the_holder_can_still_complete_their_own_booking(self, api, venue):
        """The other side of the boundary: refusing everyone would be just as
        wrong. The customer who actually holds the court finishes normally."""
        token = self.steal(api, venue)
        response = api.post(BOOKINGS, booking_body(venue, reservation=token),
                            format="json")
        assert response.status_code == 201, response.data


class TestABookedCourtCannotBeBookedAgain:
    """No bypass. A booked court is gone, by every route in.

    The reservation work added a deliberate hole in availability: a checkout
    passes its own token so its own hold stops reporting its own slot as
    taken. That exclusion must reach holds and NOTHING else. If it ever
    widened to bookings, a customer holding a court could be handed one that
    was already sold, and two people would turn up for it.
    """

    def already_booked(self, venue, at=time(19, 0)):
        return Booking.objects.create(
            customer=None, club=venue["club"], facility=venue["court"],
            facility_type=venue["activity"], scheduled_date=a_date(),
            scheduled_time=at, end_time=time(at.hour + 1, 0),
            duration_minutes=60, status=BookingStatus.CONFIRMED,
            booking_type="walk_in", walk_in_name="First Customer",
            currency="SAR", total_amount=Decimal("100.000"))

    def test_the_website_refuses(self, api, venue):
        self.already_booked(venue)
        response = api.post(BOOKINGS, booking_body(venue), format="json")
        assert response.status_code == 409, response.data

    def test_a_live_reservation_does_not_override_a_booking(self, api, venue):
        """The one that matters. Holding a court is not a claim on a court
        somebody has already bought, and the token that hides your own hold
        must not hide anybody's booking."""
        token = reserve(api, venue, ["19:00"]).data["token"]
        self.already_booked(venue)              # sold from another channel

        response = api.post(BOOKINGS, booking_body(venue, reservation=token),
                            format="json")
        assert response.status_code == 409, response.data
        assert Booking.objects.filter(
            scheduled_time=time(19, 0),
            status__in=SLOT_BLOCKING_STATUSES).count() == 1

    def test_an_order_cannot_override_a_booking_either(self, api, venue, multi):
        token = reserve(api, venue, ["19:00", "20:00"]).data["token"]
        self.already_booked(venue, at=time(20, 0))
        day = a_date().isoformat()

        response = api.post(ORDERS, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "slots": [{"date": day, "time": "19:00"}, {"date": day, "time": "20:00"}],
            "name": "Second Player", "email": "second@nadena.sa",
            "phone": "+966500000066", "reservation": token,
        }, format="json")
        assert response.status_code == 409, response.data
        assert not BookingOrder.objects.exists()

    def test_the_admin_refuses_too(self, auth_api, venue):
        self.already_booked(venue)
        response = auth_api.post("/api/v1/bookings/", {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "scheduled_date": a_date().isoformat(),
            "scheduled_time": "19:00",
            "booking_type": "walk_in", "walk_in_name": "Desk Customer",
        }, format="json")
        assert response.status_code == 400, response.data
        assert Booking.objects.count() == 1

    def test_the_slot_never_reports_itself_as_free(self, api, venue):
        """Availability and the checkout must agree; a slot that reads free
        and then refuses is how a customer ends up blaming the club."""
        self.already_booked(venue)
        slot = next(s for s in api.get(AVAILABILITY, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "date": a_date().isoformat(),
        }).data["slots"] if s["time"] == "19:00")
        assert slot["available"] == 0
        assert slot["held"] == 0                # booked, not merely held
