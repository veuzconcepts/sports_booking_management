"""Public website API: catalogue, clubs, availability, quoting and booking."""

from datetime import date, timedelta
from decimal import Decimal

import pytest

from apps.bookings.models import Booking, BookingSource


@pytest.fixture
def bookable(db, club, facilities, facility_type, tax_rate):
    """A club with courts plus one online-bookable facility type."""
    facility_type.online_booking_enabled = True
    facility_type.save()
    return facility_type


def test_public_endpoints_need_no_authentication(api, bookable, club):
    for path in ("/api/v1/website/public/home/",
                 "/api/v1/website/public/catalogue/",
                 "/api/v1/website/public/clubs/",
                 "/api/v1/website/public/branding/",
                 "/api/v1/website/public/booking-config/"):
        assert api.get(path).status_code == 200, path


def test_catalogue_uses_facility_terms(api, bookable, facility_category):
    body = api.get("/api/v1/website/public/catalogue/").json()
    assert set(body) == {"currency", "categories", "facility_types", "plans"}
    assert [c["name"] for c in body["categories"]] == ["Racket Sports"]
    assert [t["name"] for t in body["facility_types"]] == ["Tennis Court"]


def test_catalogue_facility_type_carries_a_slot_price(api, bookable):
    body = api.get("/api/v1/website/public/catalogue/").json()
    item = body["facility_types"][0]
    assert Decimal(item["price"]) == Decimal("60.000000")
    assert "wash_area" not in item and "from_price" not in item


def test_catalogue_category_exposes_its_kind(api, bookable):
    category = api.get("/api/v1/website/public/catalogue/").json()["categories"][0]
    assert category["kind"] == "outdoor_court"
    assert category["kind_display"] == "Outdoor Court"
    assert "delivery_mode" not in category


def test_offline_facility_types_are_hidden(api, bookable):
    bookable.online_booking_enabled = False
    bookable.save()
    assert api.get("/api/v1/website/public/catalogue/").json()["facility_types"] == []


def test_public_clubs_list(api, club):
    body = api.get("/api/v1/website/public/clubs/").json()
    assert [c["code"] for c in body["clubs"]] == ["riverside"]


def test_inactive_clubs_are_hidden(api, club):
    club.is_active = False
    club.save()
    assert api.get("/api/v1/website/public/clubs/").json()["clubs"] == []


def test_public_availability_for_a_club(api, bookable, club, facilities):
    on_date = (date.today() + timedelta(days=2)).isoformat()
    resp = api.get(f"/api/v1/website/public/availability/?club={club.id}&date={on_date}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["date"] == on_date
    assert body["closed"] is False
    assert all({"time", "end", "available"} == set(s) for s in body["slots"])


def test_public_availability_404s_for_an_unknown_club(api, bookable):
    assert api.get("/api/v1/website/public/availability/?club=9999").status_code == 404


def test_public_quote_prices_a_selection(api, bookable, club):
    resp = api.post("/api/v1/website/public/quote/",
                    {"facility_type": bookable.id, "club": club.id}, format="json")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert Decimal(body["base_amount"]) == Decimal("60.000")
    assert Decimal(body["tax_amount"]) == Decimal("3.000")
    assert Decimal(body["total_amount"]) == Decimal("63.000")


def test_public_quote_rejects_an_unknown_facility_type(api, club):
    resp = api.post("/api/v1/website/public/quote/",
                    {"facility_type": 9999, "club": club.id}, format="json")
    assert resp.status_code == 400


# --------------------------------------------------------------------------- #
# Public booking creation
# --------------------------------------------------------------------------- #
def _payload(facility_type, club, **extra):
    return {
        "facility_type": facility_type.id,
        "club": club.id,
        "date": (date.today() + timedelta(days=2)).isoformat(),
        "time": "10:00",
        "name": "Layla Ahmed",
        "email": "newbooker@riversideclub.ae",
        "phone": "+971500000009",
        **extra,
    }


def test_website_booking_creates_a_customer_and_booking(api, bookable, club, facilities):
    resp = api.post("/api/v1/website/public/bookings/",
                    _payload(bookable, club), format="json")
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["reference"].startswith("BK-")

    booking = Booking.objects.get(reference=body["reference"])
    assert booking.source == BookingSource.WEBSITE
    assert booking.club == club
    assert booking.customer.email == "newbooker@riversideclub.ae"
    assert booking.customer_was_new is True


def test_website_booking_requires_the_core_fields(api, bookable, club, facilities):
    payload = _payload(bookable, club)
    del payload["name"]
    resp = api.post("/api/v1/website/public/bookings/", payload, format="json")
    assert resp.status_code == 400
    assert "name" in resp.json()["detail"]


def test_website_booking_rejects_an_invalid_phone(api, bookable, club, facilities):
    resp = api.post("/api/v1/website/public/bookings/",
                    _payload(bookable, club, phone="12345"), format="json")
    assert resp.status_code == 400


def test_website_booking_404s_for_an_unbookable_facility_type(api, bookable, club, facilities):
    bookable.online_booking_enabled = False
    bookable.save()
    resp = api.post("/api/v1/website/public/bookings/",
                    _payload(bookable, club), format="json")
    assert resp.status_code == 404


def test_website_booking_is_refused_when_the_slot_is_full(api, bookable, club,
                                                          facilities, booking_on):
    from datetime import time as time_cls
    on_date = date.today() + timedelta(days=2)
    for _ in range(3):                                  # fill all three courts
        booking_on(on_date=on_date, at_time=time_cls(10, 0))
    resp = api.post("/api/v1/website/public/bookings/",
                    _payload(bookable, club), format="json")
    assert resp.status_code == 409


def test_the_same_customer_cannot_double_book_one_slot(api, bookable, club, facilities):
    payload = _payload(bookable, club)
    assert api.post("/api/v1/website/public/bookings/", payload, format="json").status_code == 201
    second = api.post("/api/v1/website/public/bookings/", payload, format="json")
    assert second.status_code == 409


def test_home_payload_uses_the_organization_key(api, bookable):
    body = api.get("/api/v1/website/public/home/").json()
    assert "organization" in body
    assert "site" not in body
    assert "app" not in body.get("organization", {})
