"""One multi-slot checkout, as a single record.

A multi-slot order is N ordinary bookings, which is what keeps the calendar,
capacity, refunds and the double-booking index working. The cost of that choice
is that no screen showed the checkout as one thing: staff saw three
near-identical rows sharing a reference and had to open each in turn to find
out what had been paid.

The order owns no money and no status. Everything here is summed or read from
the bookings, so the interesting cases are the ones where those two could
disagree: a cancelled slot, a part-paid slot, and a slot at a club the reader
is not allowed to see.
"""

from datetime import date, time
from decimal import Decimal

import pytest

from apps.bookings import multi_slot
from apps.bookings.models import Booking, BookingPolicy, BookingStatus
from apps.bookings.services import settle_booking_payment

pytestmark = pytest.mark.django_db

MONDAY = date(2026, 6, 1)
ORDERS = "/api/v1/bookings/orders/"


def _open_all_week():
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture
def venue(db, tax_rate):
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.save()
    club = Club.objects.create(name="Order Club", code="ORDC", is_active=True,
                               booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Badminton Court", price=Decimal("35.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Court South 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customer = Customer.objects.create(
        full_name="Mohammed Navab", email="navab@orderclub.sa",
        mobile_number="+966500000088")

    policy = BookingPolicy.objects.filter(is_default=True).first() or \
        BookingPolicy.objects.create(is_default=True)
    policy.allow_multiple_slots = True
    policy.max_slots_per_booking = 4
    policy.save()
    return {"club": club, "activity": activity, "court": court, "customer": customer}


@pytest.fixture
def order(venue):
    return multi_slot.create_order(
        customer=venue["customer"], club=venue["club"],
        facility_type=venue["activity"],
        slots=[(MONDAY, time(9, 0)), (MONDAY, time(10, 0)), (MONDAY, time(11, 0))])


def fetch(api, booking_order):
    response = api.get(f"{ORDERS}{booking_order.pk}/")
    assert response.status_code == 200, response.data
    return response.data


class TestWhatTheOrderSays:
    def test_it_names_the_checkout_and_who_made_it(self, auth_api, order):
        booking_order, _bookings = order
        data = fetch(auth_api, booking_order)

        assert data["reference"] == booking_order.reference
        assert data["customer_name"] == "Mohammed Navab"
        assert data["customer_email"] == "navab@orderclub.sa"
        assert data["club_name"] == "Order Club"
        assert data["facility_type_name"] == "Badminton Court"

    def test_it_lists_every_slot_in_time_order(self, auth_api, order):
        booking_order, bookings = order
        slots = fetch(auth_api, booking_order)["slots"]

        assert [s["scheduled_time"] for s in slots] == ["09:00", "10:00", "11:00"]
        assert [s["reference"] for s in slots] == [b.reference for b in bookings]
        assert all(s["facility_name"] == "Court South 1" for s in slots)

    def test_each_slot_carries_its_own_money_and_status(self, auth_api, order):
        """Slots can be priced differently and settle at different times, so a
        single order-level status would be a lie about at least one of them."""
        booking_order, bookings = order
        settle_booking_payment(bookings[0], method="cash")

        slots = {s["reference"]: s for s in fetch(auth_api, booking_order)["slots"]}
        first = slots[bookings[0].reference]
        second = slots[bookings[1].reference]
        assert Decimal(first["outstanding"]) == 0
        assert first["status"] == BookingStatus.CONFIRMED
        assert Decimal(second["outstanding"]) > 0
        assert second["status"] == BookingStatus.BOOKED

    def test_the_totals_are_summed_from_the_slots(self, auth_api, order):
        booking_order, bookings = order
        data = fetch(auth_api, booking_order)

        expected = sum((b.total_amount for b in bookings), Decimal("0"))
        assert Decimal(data["total_amount"]) == expected
        assert Decimal(data["amount_paid"]) == 0
        assert Decimal(data["outstanding"]) == expected
        assert data["slot_count"] == 3

    def test_paying_one_slot_moves_the_order_totals(self, auth_api, order):
        booking_order, bookings = order
        settle_booking_payment(bookings[0], method="cash")

        data = fetch(auth_api, booking_order)
        assert Decimal(data["amount_paid"]) == bookings[0].total_amount
        assert Decimal(data["outstanding"]) == (
            Decimal(data["total_amount"]) - bookings[0].total_amount)


class TestACancelledSlot:
    """`live_bookings` drives the MONEY, because a cancelled slot is not owed
    for. It must not drive the LIST: a cancelled slot is usually the thing
    somebody opened this screen to ask about."""

    def test_it_still_appears(self, auth_api, order):
        booking_order, bookings = order
        bookings[1].status = BookingStatus.CANCELLED
        bookings[1].save(update_fields=["status"])

        slots = fetch(auth_api, booking_order)["slots"]
        assert len(slots) == 3
        cancelled = next(s for s in slots if s["reference"] == bookings[1].reference)
        assert cancelled["status"] == BookingStatus.CANCELLED

    def test_it_is_left_out_of_the_money(self, auth_api, order):
        booking_order, bookings = order
        bookings[1].status = BookingStatus.CANCELLED
        bookings[1].save(update_fields=["status"])

        data = fetch(auth_api, booking_order)
        assert data["slot_count"] == 2
        assert Decimal(data["total_amount"]) == (
            bookings[0].total_amount + bookings[2].total_amount)


class TestWhoMayLook:
    def test_a_signed_out_visitor_may_not(self, api, order):
        booking_order, _bookings = order
        assert api.get(f"{ORDERS}{booking_order.pk}/").status_code == 401

    def test_a_manager_at_another_club_may_not(self, api, order, venue, make_user):
        """The same club boundary the bookings obey. An order names a customer
        and everything they booked."""
        from apps.accounts.models import Role
        from apps.clubs.models import Club

        booking_order, _bookings = order
        elsewhere = Club.objects.create(name="Far Club", code="FARC", is_active=True)
        manager = make_user("far@example.com", role=Role.MANAGER)
        manager.assigned_clubs.set([elsewhere])
        api.force_authenticate(user=manager)

        assert api.get(f"{ORDERS}{booking_order.pk}/").status_code == 404

    def test_a_manager_at_this_club_may(self, api, order, venue, make_user):
        from apps.accounts.models import Role

        booking_order, _bookings = order
        manager = make_user("desk@example.com", role=Role.MANAGER)
        manager.assigned_clubs.set([venue["club"]])
        api.force_authenticate(user=manager)

        assert api.get(f"{ORDERS}{booking_order.pk}/").status_code == 200

    def test_a_customer_may_not(self, api, order, make_user):
        from apps.accounts.models import Role

        booking_order, _bookings = order
        api.force_authenticate(
            user=make_user("player@example.com", role=Role.CUSTOMER))
        assert api.get(f"{ORDERS}{booking_order.pk}/").status_code == 404


class TestItIsReadOnly:
    """An order owns nothing of its own, so the way to change any of it is to
    act on the slot it belongs to."""

    def test_it_cannot_be_created(self, auth_api, venue):
        assert auth_api.post(ORDERS, {}, format="json").status_code in (404, 405)

    def test_it_cannot_be_edited(self, auth_api, order):
        booking_order, _bookings = order
        response = auth_api.patch(f"{ORDERS}{booking_order.pk}/",
                                  {"currency": "USD"}, format="json")
        assert response.status_code == 405

    def test_it_cannot_be_deleted(self, auth_api, order):
        booking_order, _bookings = order
        assert auth_api.delete(f"{ORDERS}{booking_order.pk}/").status_code == 405

    def test_there_is_no_listing_to_browse(self, auth_api, order):
        """An order is reached from a booking, not browsed. A listing nobody
        opens is a listing nobody scopes or paginates either."""
        assert auth_api.get(ORDERS).status_code == 404
