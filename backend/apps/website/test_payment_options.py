"""Which payment methods a club offers, and what happens when one is off.

Pay-at-venue and split payment are the club's decision, not the gateway's. The
website may only offer what the club actually accepts, and the server has to
refuse the rest, because hiding a button is not enforcement: a stale tab, the
back button or a direct API call all reach the endpoint anyway.

The case worth being careful about is cash switched off. A pay-at-venue
booking is deliberately exempt from the expiry sweep, so a booking recorded as
cash at a club that never takes cash would hold its court forever with nobody
able to pay for it. These tests pin that it cannot be recorded at all.
"""

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings.models import Booking, PaymentMethod
from apps.payments.gateway import CARD_APPROVED

pytestmark = pytest.mark.django_db

PAYMENT_CONFIG = "/api/v1/website/public/payment-config/"
BOOKINGS = "/api/v1/website/public/bookings/"


def _open_all_week():
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture
def demo_mode(settings):
    settings.PAYMENT_MODE = "demo"
    settings.PAYMENT_ALLOW_DEMO = True
    return settings


@pytest.fixture
def venue(db, tax_rate):
    from apps.clubs.models import Club
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.cash_enabled = True
    org.split_enabled = True
    org.save()

    club = Club.objects.create(name="Options Club", code="OPT", is_active=True,
                               booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Squash Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Squash 1", club=club, is_active=True)
    court.facility_types.add(activity)
    return {"club": club, "activity": activity, "court": court, "org": org}


def booking_payload(venue, payment=None, hour="19:00"):
    payload = {
        "club": venue["club"].id,
        "facility_type": venue["activity"].id,
        "date": (timezone.localdate() + timedelta(days=6)).isoformat(),
        "time": hour,
        "name": "Options Player",
        "email": "options@nadena.sa",
        "phone": "+966500000022",
    }
    if payment is not None:
        payload["payment"] = payment
    return payload


# --------------------------------------------------------------------------- #
# What the website is told
# --------------------------------------------------------------------------- #
class TestTheConfigEndpoint:
    def test_cash_on_is_reported(self, api, venue):
        response = api.get(PAYMENT_CONFIG)
        assert response.status_code == 200
        assert response.data["cash_enabled"] is True

    def test_cash_off_at_the_organization_is_reported(self, api, venue):
        venue["org"].cash_enabled = False
        venue["org"].save()
        assert api.get(PAYMENT_CONFIG).data["cash_enabled"] is False

    def test_a_club_may_turn_cash_off_on_its_own(self, api, venue):
        venue["club"].cash_enabled = False
        venue["club"].save()
        assert api.get(PAYMENT_CONFIG).data["cash_enabled"] is True
        scoped = api.get(f"{PAYMENT_CONFIG}?club={venue['club'].id}")
        assert scoped.data["cash_enabled"] is False

    def test_a_club_may_turn_cash_on_while_the_organization_has_it_off(
            self, api, venue):
        venue["org"].cash_enabled = False
        venue["org"].save()
        venue["club"].cash_enabled = True
        venue["club"].save()
        scoped = api.get(f"{PAYMENT_CONFIG}?club={venue['club'].id}")
        assert scoped.data["cash_enabled"] is True

    def test_an_unknown_club_falls_back_rather_than_erroring(self, api, venue):
        """The checkout still needs an answer it can render."""
        response = api.get(f"{PAYMENT_CONFIG}?club=999999")
        assert response.status_code == 200
        assert response.data["cash_enabled"] is True

    def test_rubbish_in_the_club_parameter_does_not_break_it(self, api, venue):
        assert api.get(f"{PAYMENT_CONFIG}?club=abc").status_code == 200
        assert api.get(f"{PAYMENT_CONFIG}?club=").status_code == 200

    def test_the_split_window_comes_from_the_club_not_the_environment(
            self, api, venue):
        venue["club"].split_hold_minutes = 25
        venue["club"].split_max_shares = 4
        venue["club"].save()
        data = api.get(f"{PAYMENT_CONFIG}?club={venue['club'].id}").data
        assert data["split_minutes"] == 25
        assert data["split_max_shares"] == 4

    def test_split_switched_off_is_reported(self, api, venue):
        venue["club"].split_enabled = False
        venue["club"].save()
        data = api.get(f"{PAYMENT_CONFIG}?club={venue['club'].id}").data
        assert data["split_enabled"] is False

    def test_split_needs_a_card_provider_as_well_as_the_clubs_permission(
            self, api, venue, settings):
        """Splitting a bill is several card payments. Without a gateway there
        is nothing to split it across, whatever the club has enabled."""
        settings.PAYMENT_MODE = "none"
        data = api.get(f"{PAYMENT_CONFIG}?club={venue['club'].id}").data
        assert data["card_enabled"] is False
        assert data["split_enabled"] is False


# --------------------------------------------------------------------------- #
# What the server actually allows
# --------------------------------------------------------------------------- #
class TestCashSwitchedOff:
    def test_pay_at_venue_is_refused(self, api, venue, demo_mode):
        venue["club"].cash_enabled = False
        venue["club"].save()
        response = api.post(BOOKINGS,
                            booking_payload(venue, {"method": "cash"}),
                            format="json")
        assert response.status_code in (200, 201), response.data
        assert response.data["payment"]["status"] == "unavailable"
        assert response.data["payment"]["code"] == "cash_disabled"

    def test_the_booking_is_not_recorded_as_a_cash_booking(
            self, api, venue, demo_mode):
        """The dangerous half. A cash booking is exempt from the expiry sweep,
        so recording one here would hold the court with no way to pay."""
        venue["club"].cash_enabled = False
        venue["club"].save()
        api.post(BOOKINGS, booking_payload(venue, {"method": "cash"}),
                 format="json")
        booking = Booking.objects.latest("id")
        assert booking.payment_method != PaymentMethod.CASH

    def test_naming_no_method_at_all_does_not_become_a_cash_booking(
            self, api, venue, demo_mode):
        """The default used to be cash unconditionally."""
        venue["club"].cash_enabled = False
        venue["club"].save()
        api.post(BOOKINGS, booking_payload(venue), format="json")
        booking = Booking.objects.latest("id")
        assert booking.payment_method != PaymentMethod.CASH

    def test_paying_by_card_still_works(self, api, venue, demo_mode):
        venue["club"].cash_enabled = False
        venue["club"].save()
        response = api.post(
            BOOKINGS,
            booking_payload(venue, {
                "method": "card",
                "card": {"number": CARD_APPROVED, "expiry": "12/30",
                         "cvv": "123", "name": "Options Player"}}),
            format="json")
        assert response.data["payment"]["status"] == "paid", response.data["payment"]


class TestCashLeftOn:
    def test_pay_at_venue_works_as_before(self, api, venue, demo_mode):
        response = api.post(BOOKINGS, booking_payload(venue, {"method": "cash"}),
                            format="json")
        assert response.status_code in (200, 201), response.data
        assert response.data["payment"]["status"] == "due_at_venue"
        assert Booking.objects.latest("id").payment_method == PaymentMethod.CASH

    def test_naming_no_method_still_means_pay_at_venue(self, api, venue, demo_mode):
        api.post(BOOKINGS, booking_payload(venue), format="json")
        assert Booking.objects.latest("id").payment_method == PaymentMethod.CASH


class TestSplitSwitchedOff:
    def test_splitting_is_refused(self, api, venue, demo_mode):
        venue["club"].split_enabled = False
        venue["club"].save()
        response = api.post(
            BOOKINGS,
            booking_payload(venue, {"method": "split",
                                    "participants": [{"name": "A"}, {"name": "B"}]}),
            format="json")
        assert response.data["payment"]["status"] == "unavailable"
        assert response.data["payment"]["code"] == "split_disabled"

    def test_no_split_arrangement_is_created(self, api, venue, demo_mode):
        from apps.payments.models import BookingPaymentSplit

        venue["club"].split_enabled = False
        venue["club"].save()
        api.post(BOOKINGS,
                 booking_payload(venue, {"method": "split",
                                         "participants": [{"name": "A"},
                                                          {"name": "B"}]}),
                 format="json")
        assert not BookingPaymentSplit.objects.exists()


class TestNothingToPay:
    def test_a_free_booking_is_never_refused_for_its_method(self, api, venue,
                                                            demo_mode):
        """No money is changing hands, so no method can be the wrong one."""
        venue["club"].cash_enabled = False
        venue["club"].save()
        venue["activity"].price = Decimal("0.000")
        venue["activity"].save()
        response = api.post(BOOKINGS, booking_payload(venue, {"method": "cash"}),
                            format="json")
        assert response.data["payment"]["status"] == "due_at_venue"


class TestNoCardProviderConfigured:
    """What a customer is told when the gateway is missing.

    The advice depends on the club, because "you can still pay at the club" is
    a lie at a club that does not take cash, and sending somebody to a desk
    that will turn them away is worse than saying to try again.
    """

    @pytest.fixture(autouse=True)
    def no_provider(self, settings):
        settings.PAYMENT_MODE = "none"

    def test_a_cash_club_is_pointed_at_the_desk(self, api, venue):
        response = api.post(BOOKINGS, booking_payload(venue, {"method": "card"}),
                            format="json")
        detail = response.data["payment"]["detail"]
        assert "pay at the club" in detail, detail

    def test_a_card_only_club_is_not(self, api, venue):
        venue["club"].cash_enabled = False
        venue["club"].save()
        response = api.post(BOOKINGS, booking_payload(venue, {"method": "card"}),
                            format="json")
        detail = response.data["payment"]["detail"]
        assert "pay at the club" not in detail, detail
        assert response.data["payment"]["status"] == "unavailable"
