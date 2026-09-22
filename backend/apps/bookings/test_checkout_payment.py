"""The public checkout, end to end: cash, card and split.

These go through the real HTTP endpoint rather than the service, because the
things most likely to break are at the seam: whether the browser can influence
what it is charged, whether a declined card destroys the booking, and whether a
production configuration quietly falls back to simulating success.
"""

from datetime import date, time, timedelta
from decimal import Decimal

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from apps.bookings.models import Booking, BookingStatus
from apps.bookings.services import booking_amount_paid, booking_outstanding
from apps.payments.gateway import CARD_APPROVED, CARD_DECLINED
from apps.payments.models import BookingPaymentSplit, ShareStatus, SplitStatus

pytestmark = pytest.mark.django_db

CARD = {"number": CARD_APPROVED, "holder": "Test Player", "expiry": "12/30", "cvv": "123"}


@pytest.fixture
def demo_mode(settings):
    settings.PAYMENT_MODE = "demo"
    settings.PAYMENT_ALLOW_DEMO = True
    return settings


@pytest.fixture
def catalogue(db):
    """A bookable facility type at a club, open around the clock.

    The wide opening hours are deliberate: these tests are about payment, and a
    schedule that happened to close at the chosen hour would fail them for an
    unrelated reason.
    """
    from apps.clubs.models import Club
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    # Real weekday keys, in the shape the schedule engine stores. Numeric keys
    # normalise to a day with no shifts, which resolves to CLOSED.
    from apps.settings_app.models import BOOKING_DAY_KEYS

    hours = {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
             for day in BOOKING_DAY_KEYS}
    org = Organization.get_solo()
    org.booking_hours = hours
    org.save()

    club = Club.objects.create(name="Riverside Club", is_active=True,
                               booking_hours=hours)
    ftype = FacilityType.objects.create(
        name="Football Pitch", price=Decimal("400.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    unit = Facility.objects.create(name="Pitch 1", club=club, is_active=True)
    unit.facility_types.add(ftype)
    return {"club": club, "facility_type": ftype}


@pytest.fixture
def api():
    return APIClient()


def booking_body(catalogue, payment, *, suffix="1"):
    return {
        "facility_type": catalogue["facility_type"].id,
        "club": catalogue["club"].id,
        "date": (date.today() + timedelta(days=3)).isoformat(),
        "time": time(19, 0).strftime("%H:%M"),
        "name": "Mohammed",
        "email": f"organizer{suffix}@riversideclub.sa",
        "phone": f"+96654944331{suffix}",
        "payment": payment,
    }


def create(api, catalogue, payment, **kwargs):
    return api.post(reverse("website-public-booking-create"),
                    booking_body(catalogue, payment, **kwargs), format="json")


# --------------------------------------------------------------------------- #
# Cash: unchanged behaviour
# --------------------------------------------------------------------------- #
def test_cash_booking_still_collects_nothing(api, catalogue, demo_mode):
    response = create(api, catalogue, {"method": "cash"})
    assert response.status_code == 201, response.json()
    body = response.json()
    assert body["payment"]["status"] == "due_at_venue"
    booking = Booking.objects.get(reference=body["reference"])
    assert booking_amount_paid(booking) == Decimal("0.000")
    assert booking.status == BookingStatus.BOOKED


def test_a_booking_with_no_payment_block_behaves_as_before(api, catalogue, demo_mode):
    """Backwards compatibility: an older client that sends no payment section
    must keep getting exactly the booking it used to get."""
    body = booking_body(catalogue, None)
    body.pop("payment")
    response = api.post(reverse("website-public-booking-create"), body, format="json")
    assert response.status_code == 201
    assert response.json()["payment"]["status"] == "due_at_venue"


# --------------------------------------------------------------------------- #
# Card
# --------------------------------------------------------------------------- #
def test_card_payment_confirms_and_invoices(api, catalogue, demo_mode):
    response = create(api, catalogue, {"method": "card", "card": CARD})
    assert response.status_code == 201
    body = response.json()
    assert body["payment"]["status"] == "paid"
    assert body["payment"]["card_last4"] == "4242"
    assert body["payment"]["invoice"]
    assert body["payment_status"] == "paid"

    booking = Booking.objects.get(reference=body["reference"])
    assert booking_outstanding(booking) == Decimal("0.000")
    assert booking_amount_paid(booking) == booking.total_amount


def test_a_declined_card_keeps_the_booking_and_says_so(api, catalogue, demo_mode):
    """A decline must not silently discard the slot the customer just chose."""
    response = create(api, catalogue,
                      {"method": "card", "card": {**CARD, "number": CARD_DECLINED}})
    assert response.status_code == 201
    body = response.json()
    assert body["payment"]["status"] == "failed"
    assert body["payment"]["code"] == "declined"
    assert body["checkout_token"]

    booking = Booking.objects.get(reference=body["reference"])
    assert booking.status == BookingStatus.BOOKED
    assert booking.payment_status == "pending"
    assert booking_amount_paid(booking) == Decimal("0.000")


def test_the_checkout_token_pays_a_declined_booking(api, catalogue, demo_mode):
    declined = create(api, catalogue,
                      {"method": "card", "card": {**CARD, "number": CARD_DECLINED}}).json()
    response = api.post(reverse("website-public-booking-pay"),
                        {"checkout_token": declined["checkout_token"], "card": CARD},
                        format="json")
    assert response.status_code == 200
    assert response.json()["status"] == "paid"
    booking = Booking.objects.get(reference=declined["reference"])
    assert booking_outstanding(booking) == Decimal("0.000")


def test_a_forged_checkout_token_pays_nothing(api, catalogue, demo_mode):
    create(api, catalogue, {"method": "cash"})
    response = api.post(reverse("website-public-booking-pay"),
                        {"checkout_token": "not-a-signed-token", "card": CARD},
                        format="json")
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_session"


def test_the_same_booking_cannot_be_paid_twice(api, catalogue, demo_mode):
    paid = create(api, catalogue, {"method": "card", "card": CARD}).json()
    response = api.post(reverse("website-public-booking-pay"),
                        {"checkout_token": paid["checkout_token"], "card": CARD},
                        format="json")
    assert response.status_code == 400
    assert response.json()["code"] == "nothing_due"


def test_card_is_refused_when_no_provider_is_configured(api, catalogue, settings):
    """Section 51: production must fail safely, never simulate success."""
    settings.PAYMENT_MODE = "demo"
    settings.PAYMENT_ALLOW_DEMO = False
    response = create(api, catalogue, {"method": "card", "card": CARD})
    assert response.status_code == 201
    body = response.json()
    assert body["payment"]["status"] == "unavailable"
    booking = Booking.objects.get(reference=body["reference"])
    assert booking_amount_paid(booking) == Decimal("0.000")


def test_double_submitting_the_checkout_does_not_double_book(api, catalogue, demo_mode):
    first = create(api, catalogue, {"method": "card", "card": CARD})
    second = create(api, catalogue, {"method": "card", "card": CARD})
    assert first.status_code == 201
    assert second.status_code == 409
    assert Booking.objects.count() == 1


# --------------------------------------------------------------------------- #
# Split
# --------------------------------------------------------------------------- #
def test_equal_split_creates_links_and_takes_the_organizer_share(api, catalogue, demo_mode):
    response = create(api, catalogue, {
        "method": "split",
        "card": CARD,
        "split": {"mode": "equal", "people": 4, "include_me": True,
                  "pay_my_share_now": True,
                  "friends": [{"name": "Ali"}, {"name": "Ahmed"}, {"name": "Omar"}]},
    })
    assert response.status_code == 201
    payment = response.json()["payment"]
    assert payment["status"] == "started"
    assert payment["manage_url"].endswith(payment["manage_token"])
    assert len(payment["links"]) == 4
    assert payment["organizer_payment"]["status"] == "paid"

    booking = Booking.objects.get(reference=response.json()["reference"])
    shares = list(BookingPaymentSplit.objects.get(booking=booking).shares.all())
    assert len(shares) == 4
    assert sum(s.amount for s in shares) == booking.total_amount
    assert booking.payment_status == "partially_paid"
    # Exactly one quarter has been collected.
    assert booking_amount_paid(booking) == shares[0].amount


def test_a_split_that_does_not_add_up_is_refused(api, catalogue, demo_mode):
    response = create(api, catalogue, {
        "method": "split",
        "split": {"mode": "custom", "participants": [
            {"name": "Ali", "amount": "10.00"},
            {"name": "Omar", "amount": "10.00"},
        ]},
    })
    assert response.status_code == 201
    payment = response.json()["payment"]
    assert payment["status"] == "failed"
    assert payment["code"] == "allocation_mismatch"
    assert not BookingPaymentSplit.objects.exists()


def test_the_browser_cannot_dictate_the_share_amounts(api, catalogue, demo_mode):
    """An equal split sends only a headcount; the amounts come from the backend's
    own outstanding balance, so a tampered page changes nothing."""
    response = create(api, catalogue, {
        "method": "split",
        "split": {"mode": "equal", "people": 3, "include_me": True,
                  "pay_my_share_now": False,
                  # Values a tampered client might send. They are not read.
                  "amount": "0.01", "total": "0.03"},
    })
    booking = Booking.objects.get(reference=response.json()["reference"])
    shares = list(BookingPaymentSplit.objects.get(booking=booking).shares.all())
    assert sum(s.amount for s in shares) == booking.total_amount
    assert all(s.amount > Decimal("1.00") for s in shares)


def test_a_friend_pays_through_the_public_link(api, catalogue, demo_mode):
    created = create(api, catalogue, {
        "method": "split",
        "split": {"mode": "equal", "people": 2, "include_me": True,
                  "pay_my_share_now": False, "friends": [{"name": "Ali"}]},
    }).json()
    booking = Booking.objects.get(reference=created["reference"])
    share_links = created["payment"]["links"]
    first_link = next(iter(share_links.values()))
    token = first_link.rsplit("/", 1)[-1]

    summary = api.get(reverse("website-public-split-share", args=[token]))
    assert summary.status_code == 200
    assert summary.json()["booking"]["club"] == "Riverside Club"

    paid = api.post(reverse("website-public-split-share", args=[token]),
                    {"card": CARD}, format="json")
    assert paid.status_code == 200
    booking.refresh_from_db()
    assert booking.payment_status == "partially_paid"


def test_the_last_share_completes_the_booking(api, catalogue, demo_mode):
    created = create(api, catalogue, {
        "method": "split",
        "split": {"mode": "equal", "people": 2, "include_me": True,
                  "pay_my_share_now": False, "friends": [{"name": "Ali"}]},
    }).json()
    booking = Booking.objects.get(reference=created["reference"])
    for link in created["payment"]["links"].values():
        token = link.rsplit("/", 1)[-1]
        assert api.post(reverse("website-public-split-share", args=[token]),
                        {"card": CARD}, format="json").status_code == 200

    booking.refresh_from_db()
    assert booking.payment_status == "paid"
    assert booking_outstanding(booking) == Decimal("0.000")
    split = BookingPaymentSplit.objects.get(booking=booking)
    assert split.status == SplitStatus.COMPLETED
    # One booking, several payments: revenue must not be counted four times.
    assert Booking.objects.count() == 1
    assert booking.payments.filter(status="paid").count() == 2


def test_organizer_pays_the_remaining_balance(api, catalogue, demo_mode):
    created = create(api, catalogue, {
        "method": "split",
        "split": {"mode": "equal", "people": 4, "include_me": True,
                  "pay_my_share_now": False},
    }).json()
    booking = Booking.objects.get(reference=created["reference"])
    manage = created["payment"]["manage_token"]

    response = api.post(reverse("website-public-split-manage", args=[manage]),
                        {"action": "pay_remaining", "card": CARD}, format="json")
    assert response.status_code == 200
    booking.refresh_from_db()
    assert booking.payment_status == "paid"
    # Every link that was still out there is now closed.
    split = BookingPaymentSplit.objects.get(booking=booking)
    assert not split.shares.filter(status=ShareStatus.PENDING).exists()


def test_revenue_counts_one_booking_and_every_payment(api, catalogue, demo_mode):
    """Section 45: four payers must not read as four bookings."""
    from apps.reports.services import revenue_report

    created = create(api, catalogue, {
        "method": "split",
        "split": {"mode": "equal", "people": 4, "include_me": True,
                  "pay_my_share_now": False},
    }).json()
    booking = Booking.objects.get(reference=created["reference"])
    for link in created["payment"]["links"].values():
        token = link.rsplit("/", 1)[-1]
        api.post(reverse("website-public-split-share", args=[token]),
                 {"card": CARD}, format="json")

    booking.refresh_from_db()
    report = revenue_report(date.today() - timedelta(days=1),
                            date.today() + timedelta(days=1))
    assert Decimal(report["gross_revenue"]) == booking.total_amount
    assert Booking.objects.count() == 1
