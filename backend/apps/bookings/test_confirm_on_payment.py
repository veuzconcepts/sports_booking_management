"""A booking that has been paid for says it has been paid for.

The confirmation gate stops an unpaid online checkout being called Confirmed.
Nothing did the opposite: a customer who paid in full still sat at Pending
until a member of staff noticed and clicked. The money was in, the court was
theirs, and the listing said otherwise.

Money is only one way a booking stops owing anything. A membership that
absorbs it, points or a discount that clear it, or an activity that was free
to begin with all leave the club with nothing to collect, and they confirm for
exactly the same reason.

The interesting cases are the ones that must NOT confirm: a part-paid split
has not bought the court, a booking that still owes money has not either, and
a booking further along its life must not be dragged backwards.
"""

from datetime import time, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings import services as booking_services
from apps.bookings.models import Booking, BookingStatus, PaymentMethod, PaymentStatus

pytestmark = pytest.mark.django_db


@pytest.fixture
def venue(db, tax_rate):
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType

    club = Club.objects.create(name="Pay Club", code="PAYC", is_active=True)
    activity = FacilityType.objects.create(
        name="Padel Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True)
    court = Facility.objects.create(name="Padel 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customer = Customer.objects.create(
        full_name="Paying Player", email="payer@nadena.sa",
        mobile_number="+966500000321")
    return {"club": club, "activity": activity, "court": court,
            "customer": customer}


def a_booking(venue, **extra):
    fields = dict(
        customer=venue["customer"], club=venue["club"], facility=venue["court"],
        facility_type=venue["activity"],
        scheduled_date=timezone.localdate() + timedelta(days=3),
        scheduled_time=time(19, 0), end_time=time(20, 0), duration_minutes=60,
        status=BookingStatus.BOOKED, currency="SAR",
        total_amount=Decimal("100.000"), payment_status=PaymentStatus.PENDING,
        payment_method=PaymentMethod.CARD, source="website")
    fields.update(extra)
    return Booking.objects.create(**fields)


def pay(booking, amount=None):
    return booking_services.settle_booking_payment(
        booking, method="cash",
        amount=amount if amount is not None else booking_services.booking_outstanding(booking))


class TestPayingConfirmsIt:
    def test_paying_in_full_confirms_the_booking(self, venue):
        booking = a_booking(venue)
        pay(booking)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED

    def test_the_timeline_records_why(self, venue):
        booking = a_booking(venue)
        pay(booking)
        entry = booking.status_history.filter(
            to_status=BookingStatus.CONFIRMED).first()
        assert entry is not None
        assert "payment" in entry.note.lower()

    def test_an_admin_taking_cash_at_the_desk_confirms_it_too(self, venue):
        """One rule for every channel, so the desk and the website agree."""
        booking = a_booking(venue, source="admin", payment_method=PaymentMethod.CASH)
        pay(booking)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED


class TestWhatMustNotConfirm:
    def test_a_part_payment_leaves_it_pending(self, venue):
        """Half the money does not buy the court."""
        booking = a_booking(venue)
        pay(booking, amount=Decimal("40.000"))
        booking.refresh_from_db()
        assert booking.status == BookingStatus.BOOKED
        assert booking_services.booking_outstanding(booking) > 0

    def test_finishing_the_payment_then_confirms_it(self, venue):
        booking = a_booking(venue)
        pay(booking, amount=Decimal("40.000"))
        booking.refresh_from_db()
        assert booking.status == BookingStatus.BOOKED

        pay(booking)                       # the rest
        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED

    def test_a_booking_further_along_is_not_dragged_backwards(self, venue):
        """Paying an Assigned booking must not return it to Confirmed."""
        booking = a_booking(venue, status=BookingStatus.ASSIGNED)
        pay(booking)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.ASSIGNED

    def test_a_cancelled_booking_is_left_alone(self, venue):
        booking = a_booking(venue, status=BookingStatus.CANCELLED)
        pay(booking)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.CANCELLED

    def test_it_is_idempotent(self, venue):
        booking = a_booking(venue)
        pay(booking)
        booking.refresh_from_db()
        before = booking.status_history.count()

        booking_services.confirm_if_settled(booking)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED
        assert booking.status_history.count() == before


# --------------------------------------------------------------------------- #
# Nothing to pay in the first place
# --------------------------------------------------------------------------- #
def _open_all_week():
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture
def bookable(db, tax_rate):
    """A club that can be booked through the API, with one free activity and
    one chargeable one, so the same request differs only in price."""
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.save()

    club = Club.objects.create(name="Free Club", code="FREE", is_active=True,
                               booking_hours=_open_all_week())
    free = FacilityType.objects.create(
        name="Open Gym", price=Decimal("0"), duration_minutes=60, is_active=True)
    paid = FacilityType.objects.create(
        name="Tennis Court", price=Decimal("120.000"), duration_minutes=60,
        is_active=True)
    court = Facility.objects.create(name="Hall 1", club=club, is_active=True)
    court.facility_types.add(free, paid)
    customer = Customer.objects.create(
        full_name="Free Player", email="free@nadena.sa",
        mobile_number="+966500000322")
    return {"club": club, "free": free, "paid": paid, "court": court,
            "customer": customer}


def _body(bookable, activity):
    return {
        "customer": bookable["customer"].id,
        "club": bookable["club"].id,
        "facility_type": activity.id,
        "scheduled_date": (timezone.localdate() + timedelta(days=4)).isoformat(),
        "scheduled_time": "19:00",
    }


class TestNothingToPayConfirmsItToo:
    def test_a_free_booking_is_confirmed_as_soon_as_it_is_created(
            self, auth_api, bookable):
        """It never passes through the payment path, so nothing used to confirm
        it and a free booking sat at Pending for ever."""
        response = auth_api.post(
            "/api/v1/bookings/", _body(bookable, bookable["free"]), format="json")
        assert response.status_code == 201, response.data
        booking = Booking.objects.get(id=response.data["id"])
        assert booking.total_amount == Decimal("0.000")
        assert booking.status == BookingStatus.CONFIRMED

    def test_a_chargeable_booking_is_not(self, auth_api, bookable):
        """The control. The same request with a price on the activity, and the
        booking stays open because somebody still owes for it."""
        response = auth_api.post(
            "/api/v1/bookings/", _body(bookable, bookable["paid"]), format="json")
        assert response.status_code == 201, response.data
        booking = Booking.objects.get(id=response.data["id"])
        assert booking.status == BookingStatus.BOOKED
        assert booking_services.booking_outstanding(booking) > 0

    def test_a_membership_covered_booking_is_confirmed(self, venue):
        booking = a_booking(
            venue, total_amount=Decimal("0.000"),
            payment_status=PaymentStatus.COVERED,
            coverage_snapshot={"membership_number": "M-100",
                               "plan_name": "Gold", "covered_lines": ["court"]})
        booking_services.confirm_if_settled(booking)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED

    def test_the_timeline_says_the_membership_covered_it(self, venue):
        """An entry reading "Confirmed on payment" against a booking nobody
        paid for looks like a bug to whoever reads the log next."""
        booking = a_booking(
            venue, total_amount=Decimal("0.000"),
            payment_status=PaymentStatus.COVERED,
            coverage_snapshot={"membership_number": "M-100"})
        booking_services.confirm_if_settled(booking)
        note = booking.status_history.filter(
            to_status=BookingStatus.CONFIRMED).first().note
        assert "membership" in note.lower()

    def test_the_timeline_says_there_was_nothing_to_pay(self, venue):
        booking = a_booking(venue, total_amount=Decimal("0.000"),
                            payment_status=PaymentStatus.NO_PAYMENT_REQUIRED)
        booking_services.confirm_if_settled(booking)
        note = booking.status_history.filter(
            to_status=BookingStatus.CONFIRMED).first().note
        assert "nothing to pay" in note.lower()

    def test_a_free_booking_further_along_is_still_not_dragged_backwards(self, venue):
        booking = a_booking(venue, status=BookingStatus.COMPLETED,
                            total_amount=Decimal("0.000"),
                            payment_status=PaymentStatus.NO_PAYMENT_REQUIRED)
        booking_services.confirm_if_settled(booking)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.COMPLETED

    def test_an_edit_that_clears_the_balance_confirms_it(self, auth_api, bookable):
        """Move a booking onto the free activity and there is nothing left to
        collect, so it settles the same way a payment would."""
        created = auth_api.post(
            "/api/v1/bookings/", _body(bookable, bookable["paid"]), format="json")
        booking_id = created.data["id"]
        assert Booking.objects.get(id=booking_id).status == BookingStatus.BOOKED

        response = auth_api.patch(
            f"/api/v1/bookings/{booking_id}/",
            {"facility_type": bookable["free"].id}, format="json")
        assert response.status_code == 200, response.data
        booking = Booking.objects.get(id=booking_id)
        assert booking.total_amount == Decimal("0.000")
        assert booking.status == BookingStatus.CONFIRMED


class TestAMembershipRedeemedLater:
    """The customer books, then buys a membership that covers it. Redeeming the
    subscription onto the existing booking leaves nothing to collect."""

    @staticmethod
    def _membership_covering(venue):
        from apps.payments.models import (
            EntitlementLimit, EntitlementPeriod, EntitlementTarget, Membership,
            MembershipPlan, MembershipStatus,
        )
        plan = MembershipPlan.objects.create(
            name="Gold", code="GOLD-M", price=Decimal("500.000"), is_active=True)
        plan.entitlements.create(
            target_type=EntitlementTarget.FACILITY_TYPE,
            facility_type=venue["activity"],
            limit_type=EntitlementLimit.UNLIMITED, quantity=None,
            period=EntitlementPeriod.MONTHLY)
        today = timezone.localdate()
        return Membership.objects.create(
            customer=venue["customer"], plan=plan, club=venue["club"],
            status=MembershipStatus.ACTIVE,
            start_date=today - timedelta(days=1),
            end_date=today + timedelta(days=365))

    def test_redeeming_it_confirms_the_booking(self, auth_api, venue):
        booking = a_booking(venue)
        assert booking.status == BookingStatus.BOOKED

        self._membership_covering(venue)
        response = auth_api.post(
            f"/api/v1/bookings/{booking.id}/redeem-subscription/", {}, format="json")
        assert response.status_code == 200, response.data

        booking.refresh_from_db()
        assert booking.total_amount == Decimal("0.000")
        assert booking_services.booking_outstanding(booking) <= 0
        assert booking.status == BookingStatus.CONFIRMED


class TestPointsThatClearTheBalance:
    @staticmethod
    def _enable_redemption():
        from apps.loyalty.models import LoyaltyConfiguration
        cfg = LoyaltyConfiguration.objects.first() or LoyaltyConfiguration()
        cfg.redemption_enabled = True
        cfg.currency_per_point = Decimal("1")
        cfg.min_redeem_points = 0
        cfg.max_redeem_points_per_booking = 0
        cfg.max_redeem_percent = 0
        cfg.save()
        return cfg

    @staticmethod
    def _with_points(venue, points):
        customer = venue["customer"]
        customer.loyalty_points = points
        customer.save(update_fields=["loyalty_points"])
        return customer

    def test_redeeming_the_whole_balance_confirms_the_booking(self, venue):
        from apps.loyalty.services import redeem_points

        self._enable_redemption()
        self._with_points(venue, 500)

        booking = a_booking(venue)
        redeem_points(booking, 100)          # the whole pre-tax subtotal
        booking.refresh_from_db()
        assert booking_services.booking_outstanding(booking) <= 0
        assert booking.status == BookingStatus.CONFIRMED

    def test_redeeming_part_of_it_does_not(self, venue):
        from apps.loyalty.services import redeem_points

        self._enable_redemption()
        self._with_points(venue, 500)

        booking = a_booking(venue)
        redeem_points(booking, 30)
        booking.refresh_from_db()
        assert booking_services.booking_outstanding(booking) > 0
        assert booking.status == BookingStatus.BOOKED
