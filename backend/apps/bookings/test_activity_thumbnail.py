"""The activity photo on a booking payload.

A booking listing is a wall of near-identical rows. The activity's own photo
is the fastest way to tell a padel court from a swimming lane without reading
anything, so the same image the catalogue already holds is carried on every
booking view: listing, board and detail.

The risk in a listing is not correctness, it is cost. A thumbnail per row is
worthless if it costs a query per row, so the query count is pinned here.
"""

from datetime import time, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings.models import Booking, BookingStatus

pytestmark = pytest.mark.django_db

BOOKINGS = "/api/v1/bookings/"


@pytest.fixture
def venue(db, tax_rate):
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType

    club = Club.objects.create(name="Thumb Club", code="THMB", is_active=True)
    activity = FacilityType.objects.create(
        name="Padel Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True)
    court = Facility.objects.create(name="Padel 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customer = Customer.objects.create(
        full_name="Thumb Player", email="thumb@nadena.sa",
        mobile_number="+966500000123")
    return {"club": club, "activity": activity, "court": court,
            "customer": customer}


def make_booking(venue, at=time(19, 0), **extra):
    fields = dict(
        customer=venue["customer"], club=venue["club"],
        facility_type=venue["activity"], facility=venue["court"],
        scheduled_date=timezone.localdate() + timedelta(days=3),
        scheduled_time=at, end_time=time(at.hour + 1, 0), duration_minutes=60,
        status=BookingStatus.CONFIRMED, currency="SAR",
        total_amount=Decimal("100.000"))
    fields.update(extra)
    return Booking.objects.create(**fields)


def a_picture():
    """A real one-pixel PNG, so the field stores something a browser accepts."""
    import base64

    from django.core.files.uploadedfile import SimpleUploadedFile
    raw = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
    return SimpleUploadedFile("court.png", raw, content_type="image/png")


class TestTheActivityPhotoReachesTheBooking:
    def test_a_booking_carries_its_activity_photo(self, auth_api, venue):
        venue["activity"].image = a_picture()
        venue["activity"].save()
        make_booking(venue)

        row = auth_api.get(BOOKINGS).data["results"][0]
        assert row["facility_type_image"], row.get("facility_type_image")
        assert ".png" in row["facility_type_image"]

    def test_the_url_is_absolute_so_the_browser_can_load_it(self, auth_api, venue):
        """A relative path breaks the moment the admin is served from
        somewhere other than the API."""
        venue["activity"].image = a_picture()
        venue["activity"].save()
        make_booking(venue)

        url = auth_api.get(BOOKINGS).data["results"][0]["facility_type_image"]
        assert url.startswith("http://") or url.startswith("https://"), url

    def test_an_activity_with_no_photo_reports_nothing_rather_than_breaking(
            self, auth_api, venue):
        make_booking(venue)
        assert auth_api.get(BOOKINGS).data["results"][0]["facility_type_image"] is None

    def test_a_booking_with_no_activity_at_all_is_fine(self, auth_api, venue):
        """A draft may have no activity yet, and it still has to list."""
        make_booking(venue, facility_type=None, facility=None,
                     status=BookingStatus.DRAFT)
        rows = auth_api.get(BOOKINGS).data["results"]
        assert any(r["facility_type_image"] is None for r in rows)

    def test_the_detail_view_carries_it_too(self, auth_api, venue):
        venue["activity"].image = a_picture()
        venue["activity"].save()
        booking = make_booking(venue)

        body = auth_api.get(f"{BOOKINGS}{booking.id}/").data
        assert body["facility_type_image"]


class TestItCostsNothingPerRow:
    """A thumbnail per row is worthless if it is a query per row."""

    def test_a_page_of_bookings_does_not_query_per_thumbnail(self, auth_api, venue):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        venue["activity"].image = a_picture()
        venue["activity"].save()
        for hour in range(9, 14):
            make_booking(venue, at=time(hour, 0))

        auth_api.get(BOOKINGS)                      # warm caches and config
        with CaptureQueriesContext(connection) as first:
            five = auth_api.get(BOOKINGS)

        for hour in range(14, 19):
            make_booking(venue, at=time(hour, 0))
        with CaptureQueriesContext(connection) as second:
            ten = auth_api.get(BOOKINGS)

        assert len(five.data["results"]) == 5
        assert len(ten.data["results"]) == 10
        # Twice the rows must not mean more queries. The image comes off the
        # already `select_related` activity, so the count is flat.
        assert len(second) <= len(first), (
            f"{len(first)} queries for 5 rows, {len(second)} for 10")
