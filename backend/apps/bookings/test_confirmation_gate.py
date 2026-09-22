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
        with pytest.raises(ValueError, match="online payment"):
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
        """Real money, not a label. The gate reads the outstanding balance,
        which is the authoritative figure; a `payment_status` of PAID with no
        payment behind it is a state no real path can produce."""
        from apps.bookings.services import check_confirmable, settle_booking_payment

        booking = make_booking(venue)
        settle_booking_payment(booking, method="card")
        booking.refresh_from_db()

        check_confirmable(booking)          # raises if it would be refused
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

    def test_a_booking_covered_by_a_membership(self, venue):
        """Covered means the payable is nothing, which is why the status
        exists. `total_amount` is what makes that true."""
        booking = make_booking(venue, payment_status=PaymentStatus.COVERED,
                               total_amount=Decimal("0.000"))
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

    They used to be the same question, read from one predicate. They are not
    any more: refusing to CONFIRM a part-paid booking costs nobody anything,
    while CANCELLING one would take a court from somebody who has handed over
    real money, so the sweep stayed narrow and the gate got wider.

    What must still hold is the CONTAINMENT. Anything the sweep would release,
    the gate also refuses, so a booking can never be Confirmed at the moment
    its court is about to be handed to somebody else. That is the property the
    shared predicate was protecting, and it is now asserted directly.
    """

    @pytest.mark.parametrize("overrides", [
        {},
        {"payment_method": PaymentMethod.CASH},
        {"payment_method": ""},
        {"payment_status": PaymentStatus.PARTIALLY_PAID},
        {"payment_status": PaymentStatus.PAID},
        {"payment_status": PaymentStatus.COVERED, "total_amount": Decimal("0.000")},
        {"source": BookingSource.ADMIN},
    ])
    def test_anything_the_sweep_would_release_cannot_be_confirmed(
            self, venue, overrides):
        booking = make_booking(venue, **overrides)
        releasable = awaiting_online_payment(booking)

        try:
            booking_services.check_confirmable(booking)
            refused = False
        except ValueError:
            refused = True

        if releasable:
            assert refused, (
                f"{overrides}: the sweep would cancel this booking, but it "
                "could still be confirmed")


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
        from apps.bookings.services import settle_booking_payment

        booking = make_booking(venue)
        settle_booking_payment(booking, method="card")
        booking.refresh_from_db()
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


class TestPartPaidIsNotPaid:
    """A website checkout that has collected half the money is not a booking
    the club has committed a court to.

    Confirming it hid an outstanding balance behind a status that says
    everything is settled: the screenshot that started this showed a booking
    marked Confirmed with three of four split shares still pending.
    """

    def test_a_half_paid_online_booking_cannot_be_confirmed(self, venue):
        from apps.bookings.services import BookingPaymentRequired, settle_booking_payment

        booking = make_booking(venue)
        settle_booking_payment(booking, method="card", amount=Decimal("40.000"))
        booking.refresh_from_db()
        assert booking.status == BookingStatus.BOOKED

        with pytest.raises(BookingPaymentRequired) as exc:
            transition_booking(booking, BookingStatus.CONFIRMED)
        assert exc.value.code == "payment_required"

    def test_the_refusal_names_what_is_left(self, venue):
        """"Still awaiting its online payment" is untrue of a booking that has
        paid most of it, and tells reception nothing about how much to take."""
        from apps.bookings.services import BookingPaymentRequired, settle_booking_payment

        booking = make_booking(venue)
        settle_booking_payment(booking, method="card", amount=Decimal("40.000"))
        booking.refresh_from_db()

        with pytest.raises(BookingPaymentRequired) as exc:
            transition_booking(booking, BookingStatus.CONFIRMED)
        assert "60" in str(exc.value)

    def test_taking_the_rest_confirms_it(self, venue):
        from apps.bookings.services import settle_booking_payment

        booking = make_booking(venue)
        settle_booking_payment(booking, method="card", amount=Decimal("40.000"))
        booking.refresh_from_db()
        settle_booking_payment(booking, method="card")

        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED

    def test_a_part_paid_booking_is_still_never_cancelled_by_the_clock(self, venue):
        """The other half of the rule, and the reason the two predicates are
        allowed to differ. Refusing to confirm costs nobody anything; releasing
        a court somebody has paid real money towards is irreversible."""
        from django.utils import timezone
        from datetime import timedelta

        from apps.bookings.services import expire_unpaid_bookings, settle_booking_payment

        booking = make_booking(venue)
        settle_booking_payment(booking, method="card", amount=Decimal("40.000"))
        Booking.objects.filter(pk=booking.pk).update(
            created_at=timezone.now() - timedelta(days=2))

        expire_unpaid_bookings()
        booking.refresh_from_db()
        assert booking.status == BookingStatus.BOOKED

    def test_the_gate_refuses_everything_the_sweep_would_release(self, venue):
        """The containment that lets the two rules differ safely.

        A booking must never be Confirmed at the moment the sweep is about to
        cancel it. That was guaranteed by both reading ONE predicate; now it is
        guaranteed by this being a superset, so it is asserted rather than
        assumed.
        """
        from apps.bookings.services import (
            awaiting_online_payment, online_payment_incomplete, settle_booking_payment,
        )

        # A slot each: the `(facility, date, time)` uniqueness guarantee is
        # real, and five bookings on one court at 19:00 is a double booking.
        def at(hour, **overrides):
            return make_booking(venue, scheduled_time=time(hour, 0),
                                end_time=time(hour + 1, 0), **overrides)

        cases = [
            at(9),                                          # nothing paid
            at(10, payment_method=PaymentMethod.CASH),      # pay at venue
            at(11, payment_method=""),                      # never recorded
            at(12, source=BookingSource.ADMIN),             # taken at the desk
        ]
        part_paid = at(13)
        settle_booking_payment(part_paid, method="card", amount=Decimal("40.000"))
        part_paid.refresh_from_db()
        cases.append(part_paid)

        for booking in cases:
            if awaiting_online_payment(booking):
                assert online_payment_incomplete(booking), (
                    f"{booking.reference} would be released by the sweep but "
                    "could still be confirmed")

    def test_pay_at_venue_still_confirms_with_nothing_collected(self, venue):
        """Reception committing a court for a regular who pays on arrival. The
        widening must not have cost that."""
        booking = make_booking(venue, payment_method=PaymentMethod.CASH)
        transition_booking(booking, BookingStatus.CONFIRMED)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED

    def test_an_admin_booking_still_confirms_unpaid(self, venue):
        booking = make_booking(venue, source=BookingSource.ADMIN)
        transition_booking(booking, BookingStatus.CONFIRMED)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED

    def test_a_booking_with_no_payment_method_still_confirms(self, venue):
        """Not knowing is not a reason to refuse somebody's court."""
        booking = make_booking(venue, payment_method="")
        transition_booking(booking, BookingStatus.CONFIRMED)
        booking.refresh_from_db()
        assert booking.status == BookingStatus.CONFIRMED
