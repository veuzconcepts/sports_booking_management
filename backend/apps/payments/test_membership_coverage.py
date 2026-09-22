"""A membership that covers the court actually takes the court off the bill.

`coverage_for_booking` has always returned `covered_service_item`. Pricing and
the coverage snapshot in `Booking` asked for `covered_facility_type`, a name
nothing has ever produced, and the two reads failed differently. Pricing used
`.get`, so the answer was falsy and a member was charged full price for a
court their plan covered, with no snapshot written to say otherwise. The
snapshot subscripted it, so a membership covering an ADD-ON raised KeyError
out of `compute_pricing` rather than quietly overcharging.

These tests pin the behaviour by its effect (a bill), not by the key, so
renaming either side again cannot quietly bring the bug back.
"""

from datetime import time, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings.models import Booking, BookingStatus, PaymentStatus

pytestmark = pytest.mark.django_db

COURT_PRICE = Decimal("100.000")
RACKET_PRICE = Decimal("20.000")


@pytest.fixture
def venue(db, tax_rate):
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import AddOn, Facility, FacilityType

    club = Club.objects.create(name="Member Club", code="MEMC", is_active=True)
    activity = FacilityType.objects.create(
        name="Padel Court", price=COURT_PRICE, duration_minutes=60, is_active=True)
    court = Facility.objects.create(name="Padel 1", club=club, is_active=True)
    court.facility_types.add(activity)
    racket = AddOn.objects.create(name="Racket hire", price=RACKET_PRICE,
                                  is_active=True)
    customer = Customer.objects.create(
        full_name="Member Player", email="member@nadena.sa",
        mobile_number="+966500000401")
    return {"club": club, "activity": activity, "court": court,
            "racket": racket, "customer": customer}


def a_booking(venue, add_ons=()):
    booking = Booking.objects.create(
        customer=venue["customer"], club=venue["club"], facility=venue["court"],
        facility_type=venue["activity"],
        scheduled_date=timezone.localdate() + timedelta(days=3),
        scheduled_time=time(19, 0), end_time=time(20, 0), duration_minutes=60,
        status=BookingStatus.BOOKED, currency="SAR")
    if add_ons:
        booking.add_ons.set(add_ons)
    booking.compute_pricing()
    booking.sync_payment_status()
    booking.save()
    return booking


def give_membership(venue, *, covers_court=False, covers_racket=False):
    from apps.payments.models import (
        EntitlementLimit, EntitlementPeriod, EntitlementTarget, Membership,
        MembershipPlan, MembershipStatus,
    )
    plan = MembershipPlan.objects.create(
        name="Gold", code="GOLD-COV", price=Decimal("500.000"), is_active=True)
    if covers_court:
        plan.entitlements.create(
            target_type=EntitlementTarget.FACILITY_TYPE,
            facility_type=venue["activity"],
            limit_type=EntitlementLimit.UNLIMITED,
            period=EntitlementPeriod.MONTHLY)
    if covers_racket:
        plan.entitlements.create(
            target_type=EntitlementTarget.ADDON, addon=venue["racket"],
            limit_type=EntitlementLimit.UNLIMITED,
            period=EntitlementPeriod.MONTHLY)
    today = timezone.localdate()
    return Membership.objects.create(
        customer=venue["customer"], plan=plan, club=venue["club"],
        status=MembershipStatus.ACTIVE,
        start_date=today - timedelta(days=1),
        end_date=today + timedelta(days=365))


class TestTheCourtComesOffTheBill:
    def test_without_a_membership_the_court_is_charged(self, venue):
        """The control. Everything below must differ from this and only this."""
        booking = a_booking(venue)
        assert booking.total_amount > 0
        assert booking.coverage_snapshot is None

    def test_a_membership_covering_the_court_zeroes_it(self, venue):
        give_membership(venue, covers_court=True)
        booking = a_booking(venue)
        assert booking.total_amount == Decimal("0.000")

    def test_it_records_what_the_membership_covered(self, venue):
        """The snapshot is the only record of what the member did not pay for,
        and it captures the catalogue price from BEFORE coverage zeroed it."""
        membership = give_membership(venue, covers_court=True)
        booking = a_booking(venue)

        snap = booking.coverage_snapshot
        assert snap is not None
        assert snap["membership_number"] == membership.number
        assert Decimal(snap["covered_amount"]) == COURT_PRICE
        assert [line["kind"] for line in snap["covered_lines"]] == ["facility_type"]

    def test_the_booking_reads_as_covered_rather_than_unpaid(self, venue):
        give_membership(venue, covers_court=True)
        booking = a_booking(venue)
        assert booking.payment_status == PaymentStatus.COVERED

    def test_a_membership_for_a_different_activity_changes_nothing(self, venue):
        """Coverage is per entitlement. Holding any membership is not enough."""
        from apps.facilities.models import FacilityType
        from apps.payments.models import (
            EntitlementLimit, EntitlementPeriod, EntitlementTarget, Membership,
            MembershipPlan, MembershipStatus,
        )
        other = FacilityType.objects.create(
            name="Squash Court", price=Decimal("80.000"), duration_minutes=60,
            is_active=True)
        plan = MembershipPlan.objects.create(
            name="Squash Only", code="SQ-ONLY", price=Decimal("300.000"),
            is_active=True)
        plan.entitlements.create(
            target_type=EntitlementTarget.FACILITY_TYPE, facility_type=other,
            limit_type=EntitlementLimit.UNLIMITED,
            period=EntitlementPeriod.MONTHLY)
        today = timezone.localdate()
        Membership.objects.create(
            customer=venue["customer"], plan=plan, club=venue["club"],
            status=MembershipStatus.ACTIVE, start_date=today - timedelta(days=1),
            end_date=today + timedelta(days=365))

        booking = a_booking(venue)
        assert booking.total_amount > 0
        assert booking.coverage_snapshot is None


class TestAddOnCoverage:
    """Add-on coverage was broken differently: it raised KeyError building the
    snapshot. These pin what a member is actually charged for their extras."""

    def test_a_covered_add_on_is_not_charged_but_the_court_is(self, venue):
        give_membership(venue, covers_racket=True)
        booking = a_booking(venue, add_ons=[venue["racket"]])

        snap = booking.coverage_snapshot
        assert [line["kind"] for line in snap["covered_lines"]] == ["addon"]
        assert Decimal(snap["covered_amount"]) == RACKET_PRICE
        # The court is still billed, so the member owes something.
        assert booking.total_amount > 0

    def test_covering_both_leaves_nothing_to_pay(self, venue):
        give_membership(venue, covers_court=True, covers_racket=True)
        booking = a_booking(venue, add_ons=[venue["racket"]])

        assert booking.total_amount == Decimal("0.000")
        assert Decimal(booking.coverage_snapshot["covered_amount"]) == (
            COURT_PRICE + RACKET_PRICE)
        assert booking.payment_status == PaymentStatus.COVERED
