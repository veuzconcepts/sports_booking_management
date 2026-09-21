"""A booking that has been paid for says it has been paid for.

The confirmation gate stops an unpaid online checkout being called Confirmed.
Nothing did the opposite: a customer who paid in full still sat at Pending
until a member of staff noticed and clicked. The money was in, the court was
theirs, and the listing said otherwise.

The interesting cases are the ones that must NOT confirm: a part-paid split
has not bought the court, and a booking further along its life must not be
dragged backwards.
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
