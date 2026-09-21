"""Confirmed means the club has committed the court.

A website checkout that chose to pay online has not paid, so calling it
Confirmed says something untrue: the same booking is simultaneously a candidate
for `expire_unpaid_bookings` to release. Both rules therefore read one
predicate, and these tests pin both halves of it.

The larger half of this file is the set of bookings that must STILL confirm.
A gate that refuses too much is not a safer gate: it stops a receptionist
committing a court somebody is standing at the desk asking for.
"""

from datetime import time, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings import services as booking_services
from apps.bookings.models import (
    Booking, BookingSource, BookingStatus, PaymentMethod, PaymentStatus,
)
from apps.bookings.services import awaiting_online_payment, transition_booking

pytestmark = pytest.mark.django_db


@pytest.fixture
def venue(db):
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType

    club = Club.objects.create(name="Gate Club", code="GATE", is_active=True)
    activity = FacilityType.objects.create(
        name="Gate Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Gate 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customer = Customer.objects.create(
        full_name="Gate Player", email="gate@test.test",
        mobile_number="+966550001111")
    return {"club": club, "activity": activity, "court": court,
            "customer": customer}


@pytest.fixture
def worker(make_user):
    """A staff account with no profile, so it has no schedule to violate."""
    from apps.accounts.models import Role
    return make_user("gate-worker@example.com", role=Role.FACILITY_STAFF)


def make_booking(venue, **overrides):
    fields = dict(
        customer=venue["customer"], club=venue["club"],
        facility_type=venue["activity"], facility=venue["court"],
        scheduled_date=timezone.localdate() + timedelta(days=3),
        scheduled_time=time(19, 0), end_time=time(20, 0),
        duration_minutes=60, status=BookingStatus.BOOKED,
        currency="SAR", total_amount=Decimal("100.000"),
        payment_status=PaymentStatus.PENDING,
        payment_method=PaymentMethod.ONLINE,
        source=BookingSource.WEBSITE,
    )
    fields.update(overrides)
    return Booking.objects.create(**fields)


class TestTheOneCaseThatIsRefused:
    def test_an_unpaid_online_website_checkout_cannot_be_confirmed(self, venue):
        booking = make_booking(venue)
        with pytest.raises(ValueError, match="awaiting its online payment"):
            transition_booking(booking, BookingStatus.CONFIRMED)

    def test_the_refusal_leaves_the_booking_where_it_was(self, venue):
        booking = make_booking(venue)
        with pytest.raises(ValueError):
            transition_booking(booking, BookingStatus.CONFIRMED)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.BOOKED
        assert not booking.status_history.filter(
            to_status=BookingStatus.CONFIRMED).exists()

    def test_a_bank_transfer_awaiting_the_money_is_refused_too(self, venue):
        """Not card-specific. Any recorded intent to pay before arriving."""
        booking = make_booking(venue, payment_method=PaymentMethod.BANK_TRANSFER)
        with pytest.raises(ValueError):
            transition_booking(booking, BookingStatus.CONFIRMED)

    def test_paying_makes_it_confirmable(self, venue):
        booking = make_booking(venue)
        booking.payment_status = PaymentStatus.PAID
        booking.save(update_fields=["payment_status"])
        transition_booking(booking, BookingStatus.CONFIRMED)
        assert booking.status == BookingStatus.CONFIRMED


class TestWhatMustStillConfirm:
    """Every one of these is somebody's real booking."""

    def test_pay_at_venue(self, venue):
        booking = make_booking(venue, payment_method=PaymentMethod.CASH)
        transition_booking(booking, BookingStatus.CONFIRMED)
        assert booking.status == BookingStatus.CONFIRMED

    def test_an_admin_booking_even_with_an_online_method(self, venue):
        booking = make_booking(venue, source=BookingSource.ADMIN)
        transition_booking(booking, BookingStatus.CONFIRMED)
        assert booking.status == BookingStatus.CONFIRMED

    def test_a_booking_whose_method_was_never_recorded(self, venue):
        """Not knowing is not evidence of non-payment."""
        booking = make_booking(venue, payment_method="")
        transition_booking(booking, BookingStatus.CONFIRMED)
        assert booking.status == BookingStatus.CONFIRMED

    def test_a_part_paid_booking(self, venue):
        booking = make_booking(venue, payment_status=PaymentStatus.PARTIALLY_PAID)
        transition_booking(booking, BookingStatus.CONFIRMED)
        assert booking.status == BookingStatus.CONFIRMED

    def test_a_booking_covered_by_a_membership(self, venue):
        booking = make_booking(venue, payment_status=PaymentStatus.COVERED)
        transition_booking(booking, BookingStatus.CONFIRMED)
        assert booking.status == BookingStatus.CONFIRMED

    def test_a_booking_with_nothing_to_pay(self, venue):
        booking = make_booking(
            venue, payment_status=PaymentStatus.NO_PAYMENT_REQUIRED,
            total_amount=Decimal("0.000"))
        transition_booking(booking, BookingStatus.CONFIRMED)
        assert booking.status == BookingStatus.CONFIRMED

    def test_every_other_transition_is_untouched(self, venue):
        """The gate reads `target`, so it must not affect anything else."""
        booking = make_booking(venue)
        transition_booking(booking, BookingStatus.CANCELLED)
        assert booking.status == BookingStatus.CANCELLED


class TestTheReleaseRuleAgrees:
    """The gate and the expiry sweep must never disagree about one booking.

    If they did, a booking could be Confirmed at the same moment its court was
    being handed to somebody else.
    """

    @pytest.mark.parametrize("overrides", [
        {},
        {"payment_method": PaymentMethod.CASH},
        {"payment_method": ""},
        {"payment_status": PaymentStatus.PARTIALLY_PAID},
        {"payment_status": PaymentStatus.PAID},
        {"payment_status": PaymentStatus.COVERED},
    ])
    def test_refusing_to_confirm_and_being_releasable_are_the_same_question(
            self, venue, overrides):
        booking = make_booking(venue, **overrides)
        releasable = awaiting_online_payment(booking)

        try:
            booking_services.check_confirmable(booking)
            refused = False
        except ValueError:
            refused = True

        assert refused == releasable, (
            f"{overrides}: confirm-refused={refused} releasable={releasable}")


class TestAssigningDoesNotConfirmPastTheGate:
    def test_assign_refuses_an_unpaid_online_booking(self, venue, auth_api, worker):
        """Section 80: the silent BOOKED to CONFIRMED hop had no gate on it."""
        booking = make_booking(venue)
        response = auth_api.post(
            f"/api/v1/bookings/{booking.id}/assign/",
            {"assigned_to": worker.id}, format="json")
        assert response.status_code == 409, response.data
        assert response.data.get("code") == "not_confirmable"

    def test_a_refused_assign_does_not_assign_the_worker(self, venue, auth_api, worker):
        """The write used to happen before the status hop, so a refusal here
        would have left a worker attached to a booking that never moved."""
        booking = make_booking(venue)
        auth_api.post(f"/api/v1/bookings/{booking.id}/assign/",
                    {"assigned_to": worker.id}, format="json")
        booking.refresh_from_db()
        assert booking.assigned_to_id is None
        assert booking.status == BookingStatus.BOOKED

    def test_assign_still_works_once_the_booking_is_paid(self, venue, auth_api, worker):
        booking = make_booking(venue, payment_status=PaymentStatus.PAID)
        response = auth_api.post(
            f"/api/v1/bookings/{booking.id}/assign/",
            {"assigned_to": worker.id}, format="json")
        assert response.status_code == 200, response.data
        booking.refresh_from_db()
        assert booking.assigned_to_id == worker.id
        assert booking.status == BookingStatus.ASSIGNED

    def test_assign_still_works_for_a_pay_at_venue_booking(self, venue, auth_api, worker):
        booking = make_booking(venue, payment_method=PaymentMethod.CASH)
        response = auth_api.post(
            f"/api/v1/bookings/{booking.id}/assign/",
            {"assigned_to": worker.id}, format="json")
        assert response.status_code == 200, response.data


class TestTheRefusalOffersAWayForward:
    """Staff meeting "cannot be confirmed yet" with nothing to click is what
    made this rule feel like a bug.

    The rule itself is unchanged: an unpaid online checkout is still refused,
    because the same predicate decides whether the slot sweep may release it.
    What changed is that the refusal is now identifiable, so the screen can
    offer to TAKE the payment instead of stopping there.
    """

    def test_the_refusal_carries_a_code(self, venue):
        from apps.bookings.services import BookingPaymentRequired

        booking = make_booking(venue)
        with pytest.raises(BookingPaymentRequired) as exc:
            transition_booking(booking, BookingStatus.CONFIRMED)
        assert exc.value.code == "payment_required"

    def test_it_is_still_a_value_error(self, venue):
        """Every existing caller catches ValueError, and must keep working."""
        booking = make_booking(venue)
        with pytest.raises(ValueError):
            transition_booking(booking, BookingStatus.CONFIRMED)

    def test_the_api_reports_the_code_so_the_screen_can_act_on_it(
            self, auth_api, venue):
        booking = make_booking(venue)
        response = auth_api.post(f"/api/v1/bookings/{booking.pk}/transition/",
                                 {"status": BookingStatus.CONFIRMED}, format="json")
        assert response.status_code == 400
        assert response.data["code"] == "payment_required"
        assert "payment" in response.data["detail"].lower()

    def test_another_refusal_carries_no_code(self, venue):
        """So the screen offers payment only where payment is the answer."""
        booking = make_booking(venue, status=BookingStatus.CANCELLED)
        response = None
        try:
            transition_booking(booking, BookingStatus.CONFIRMED)
        except ValueError as exc:
            response = getattr(exc, "code", "")
        assert response == ""

    def test_taking_the_payment_confirms_it(self, auth_api, venue):
        """The whole point: pay, and the booking confirms itself through
        `confirm_if_settled` without anybody clicking Confirm again."""
        from apps.bookings.services import settle_booking_payment

        booking = make_booking(venue)
        settle_booking_payment(booking, method="card")

        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED
