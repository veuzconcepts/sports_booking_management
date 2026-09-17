"""Releasing courts held by online checkouts that were never completed.

Most of this file is about what must NOT be released. An automatic cancel is
the one mistake here that a customer feels directly: they arrive at the club
and their court is gone. So every condition that rules a booking out has a
test of its own, and the default when anything is unknown is to leave the
booking alone.
"""

from datetime import date, time, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings.models import (
    Booking, BookingSource, BookingStatus, PaymentMethod, PaymentStatus,
)
from apps.bookings.services import PAYMENT_WINDOW_MINUTES, expire_unpaid_bookings

pytestmark = pytest.mark.django_db


@pytest.fixture
def venue(db, tax_rate):
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import BOOKING_DAY_KEYS, Organization

    hours = {day: {"closed": False, "shifts": [{"open": "08:00", "close": "22:00"}]}
             for day in BOOKING_DAY_KEYS}
    org = Organization.get_solo()
    org.booking_hours = hours
    org.save()
    club = Club.objects.create(name="Window Club", code="WIN", is_active=True,
                               booking_hours=hours)
    activity = FacilityType.objects.create(
        name="Padel Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Court 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customer = Customer.objects.create(
        full_name="Layla", email="layla@window.test", mobile_number="+966530001111")
    return {"club": club, "activity": activity, "court": court, "customer": customer}


def make_booking(venue, *, age_minutes=60, method=PaymentMethod.CARD,
                 status=BookingStatus.BOOKED,
                 payment_status=PaymentStatus.PENDING,
                 source=BookingSource.WEBSITE, at_hour=19):
    booking = Booking.objects.create(
        customer=venue["customer"], club=venue["club"],
        facility_type=venue["activity"], facility=venue["court"],
        scheduled_date=timezone.localdate() + timedelta(days=5),
        scheduled_time=time(at_hour, 0), end_time=time(at_hour + 1, 0),
        status=status, payment_status=payment_status, payment_method=method,
        source=source, currency="SAR", total_amount=Decimal("100.000"),
    )
    # `created_at` is auto_now_add, so it has to be pushed back afterwards.
    Booking.objects.filter(pk=booking.pk).update(
        created_at=timezone.now() - timedelta(minutes=age_minutes))
    booking.refresh_from_db()
    return booking


def status_of(booking):
    booking.refresh_from_db()
    return booking.status


class TestWhatIsReleased:
    def test_an_abandoned_card_checkout_is_released(self, venue):
        booking = make_booking(venue)
        assert expire_unpaid_bookings() == 1
        assert status_of(booking) == BookingStatus.CANCELLED

    def test_the_reason_is_recorded_on_the_booking(self, venue):
        booking = make_booking(venue)
        expire_unpaid_bookings()
        booking.refresh_from_db()
        assert "Payment not completed" in booking.cancellation_reason
        assert booking.cancelled_at is not None

    def test_it_appears_in_the_booking_log(self, venue):
        booking = make_booking(venue)
        expire_unpaid_bookings()
        events = list(booking.status_history.values_list("event", flat=True))
        assert "payment_window_expired" in events

    def test_the_court_is_bookable_again(self, venue):
        from apps.bookings.services import slot_is_available
        booking = make_booking(venue)
        assert slot_is_available(booking.scheduled_date, booking.scheduled_time,
                                 club=venue["club"],
                                 facility_type=venue["activity"]) is False
        expire_unpaid_bookings()
        assert slot_is_available(booking.scheduled_date, booking.scheduled_time,
                                 club=venue["club"],
                                 facility_type=venue["activity"]) is True

    def test_running_it_again_changes_nothing(self, venue):
        make_booking(venue)
        assert expire_unpaid_bookings() == 1
        assert expire_unpaid_bookings() == 0


class TestWhatIsLeftAlone:
    """Each of these is somebody who would arrive to find their court gone."""

    def test_a_pay_at_venue_booking_is_never_released(self, venue):
        booking = make_booking(venue, method=PaymentMethod.CASH)
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.BOOKED

    def test_an_unknown_payment_method_is_never_released(self, venue):
        """Not knowing is a reason to leave it, not a reason to cancel it."""
        booking = make_booking(venue, method="")
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.BOOKED

    def test_a_booking_inside_the_window_is_left_alone(self, venue):
        booking = make_booking(venue, age_minutes=PAYMENT_WINDOW_MINUTES - 5)
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.BOOKED

    def test_an_admin_booking_is_never_released(self, venue):
        booking = make_booking(venue, source=BookingSource.ADMIN)
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.BOOKED

    def test_a_walk_in_is_never_released(self, venue):
        booking = make_booking(venue, source=BookingSource.WALK_IN)
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.BOOKED

    def test_a_booking_staff_have_confirmed_is_never_released(self, venue):
        booking = make_booking(venue, status=BookingStatus.CONFIRMED)
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.CONFIRMED

    def test_a_paid_booking_is_never_released(self, venue):
        booking = make_booking(venue, payment_status=PaymentStatus.PAID)
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.BOOKED

    def test_a_booking_covered_by_a_membership_is_never_released(self, venue):
        booking = make_booking(venue, payment_status=PaymentStatus.COVERED)
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.BOOKED

    def test_a_part_paid_booking_is_never_released(self, venue):
        """Money has changed hands: a person decides what happens next."""
        from apps.payments.models import Payment, PaymentStatus as PayStatus
        booking = make_booking(venue)
        Payment.objects.create(
            customer=venue["customer"], booking=booking,
            amount=Decimal("40.000"), status=PayStatus.PAID, method="card")
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.BOOKED

    def test_a_booking_with_a_live_split_is_never_released(self, venue):
        """Confirmed policy: split expiry is inert, and friends may still be
        paying. The clock must not cancel what that policy protects."""
        from apps.payments.models import BookingPaymentSplit, SplitStatus
        booking = make_booking(venue)
        BookingPaymentSplit.objects.create(
            booking=booking, organizer=venue["customer"], currency="SAR",
            amount_allocated=Decimal("100.000"), status=SplitStatus.ACTIVE,
            organizer_token_hash="x" * 64,
            expires_at=timezone.now() + timedelta(hours=1))
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.BOOKED

    def test_a_multi_slot_order_with_a_live_split_is_never_released(self, venue):
        """The split hangs off the ORDER, not off any one of its slots."""
        from apps.bookings.models import BookingOrder
        from apps.payments.models import BookingPaymentSplit, SplitStatus
        order = BookingOrder.objects.create(
            customer=venue["customer"], club=venue["club"],
            facility_type=venue["activity"], currency="SAR")
        booking = make_booking(venue)
        booking.order = order
        booking.save(update_fields=["order"])
        BookingPaymentSplit.objects.create(
            order=order, organizer=venue["customer"], currency="SAR",
            amount_allocated=Decimal("100.000"), status=SplitStatus.ACTIVE,
            organizer_token_hash="y" * 64,
            expires_at=timezone.now() + timedelta(hours=1))
        assert expire_unpaid_bookings() == 0
        assert status_of(booking) == BookingStatus.BOOKED

    def test_an_expired_split_does_not_protect_the_booking_forever(self, venue):
        """An arrangement that is over stops shielding an unpaid checkout."""
        from apps.payments.models import BookingPaymentSplit, SplitStatus
        booking = make_booking(venue)
        BookingPaymentSplit.objects.create(
            booking=booking, organizer=venue["customer"], currency="SAR",
            amount_allocated=Decimal("100.000"), status=SplitStatus.EXPIRED,
            organizer_token_hash="z" * 64,
            expires_at=timezone.now() - timedelta(hours=1))
        assert expire_unpaid_bookings() == 1
