"""Booking rules as they are actually enforced: through the admin API, the
public website booking, and the cancel action."""

from datetime import date, time, timedelta

import pytest
from django.utils import timezone

from apps.bookings.models import Booking, BookingPolicy, BookingStatus
from apps.bookings.services import resolve_policy
from apps.facilities.models import Facility


@pytest.fixture
def court(db, club, facility_type):
    f = Facility.objects.create(club=club, name="Court 1")
    f.facility_types.set([facility_type])
    return f


@pytest.fixture
def policy(db):
    return resolve_policy()


def _payload(customer, club, facility_type, days_ahead=3, at="10:00"):
    return {
        "customer": customer.id, "club": club.id, "facility_type": facility_type.id,
        "scheduled_date": (date.today() + timedelta(days=days_ahead)).isoformat(),
        "scheduled_time": at,
    }


# --------------------------------------------------------------------------- #
# Policy API
# --------------------------------------------------------------------------- #
def test_policy_endpoint_requires_authentication(api):
    assert api.get("/api/v1/bookings/policies/").status_code == 401


def test_staff_can_read_the_policy(auth_api, policy):
    resp = auth_api.get("/api/v1/bookings/policies/")
    assert resp.status_code == 200
    row = resp.json()["results"][0]
    assert row["is_default"] is True
    assert row["scope"] == "Organization default"


def test_listing_creates_the_default_on_a_fresh_install(auth_api, db):
    """The settings page must always have a row to edit."""
    assert BookingPolicy.objects.count() == 0
    resp = auth_api.get("/api/v1/bookings/policies/")
    assert resp.status_code == 200
    assert resp.json()["count"] == 1
    assert BookingPolicy.objects.filter(is_default=True).count() == 1


def test_a_club_override_can_be_created(auth_api, club, policy):
    resp = auth_api.post("/api/v1/bookings/policies/", {
        "club": club.id, "max_advance_days": 7, "min_lead_minutes": 60,
    }, format="json")
    assert resp.status_code == 201, resp.content
    assert resp.json()["scope"] == "Riverside Club"


def test_a_second_default_policy_is_refused(auth_api, policy):
    resp = auth_api.post("/api/v1/bookings/policies/", {"is_default": True}, format="json")
    assert resp.status_code == 400
    assert "is_default" in resp.json()


def test_a_second_policy_for_one_club_is_refused(auth_api, club, policy):
    auth_api.post("/api/v1/bookings/policies/", {"club": club.id}, format="json")
    resp = auth_api.post("/api/v1/bookings/policies/", {"club": club.id}, format="json")
    assert resp.status_code == 400
    assert "club" in resp.json()


def test_a_policy_must_have_a_scope(auth_api, policy):
    resp = auth_api.post("/api/v1/bookings/policies/", {"max_advance_days": 5},
                         format="json")
    assert resp.status_code == 400
    assert "club" in resp.json()


def test_the_default_policy_cannot_be_deleted(auth_api, policy):
    resp = auth_api.delete(f"/api/v1/bookings/policies/{policy.id}/")
    assert resp.status_code == 409


def test_a_club_policy_can_be_deleted(auth_api, club, policy):
    created = auth_api.post("/api/v1/bookings/policies/", {"club": club.id},
                            format="json").json()
    assert auth_api.delete(f"/api/v1/bookings/policies/{created['id']}/").status_code == 204


def test_booking_window_endpoint_reports_the_bounds(auth_api, club, policy):
    policy.max_advance_days = 10
    policy.min_lead_minutes = 30
    policy.save()
    body = auth_api.get(f"/api/v1/bookings/booking-window/?club={club.id}").json()
    assert body["max_advance_days"] == 10
    assert body["min_lead_minutes"] == 30
    assert body["latest_date"] == (date.today() + timedelta(days=10)).isoformat()


# --------------------------------------------------------------------------- #
# Admin bookings: exempt by default, bound when enforcement is on
# --------------------------------------------------------------------------- #
def test_staff_may_book_beyond_the_horizon_by_default(auth_api, customer, club,
                                                      court, facility_type, policy):
    policy.max_advance_days = 2
    policy.save()
    resp = auth_api.post("/api/v1/bookings/",
                         _payload(customer, club, facility_type, days_ahead=200),
                         format="json")
    assert resp.status_code == 201, resp.content


def test_staff_are_bound_once_enforcement_is_on(auth_api, customer, club, court,
                                                facility_type, policy):
    policy.max_advance_days = 2
    policy.enforce_for_staff = True
    policy.save()
    resp = auth_api.post("/api/v1/bookings/",
                         _payload(customer, club, facility_type, days_ahead=200),
                         format="json")
    assert resp.status_code == 400
    assert "scheduled_date" in resp.json()


def test_the_per_customer_cap_binds_staff_when_enforced(auth_api, customer, club,
                                                        court, facility_type, policy):
    policy.max_active_bookings_per_customer = 1
    policy.enforce_for_staff = True
    policy.save()
    first = auth_api.post("/api/v1/bookings/",
                          _payload(customer, club, facility_type, days_ahead=3),
                          format="json")
    assert first.status_code == 201, first.content

    second = auth_api.post("/api/v1/bookings/",
                           _payload(customer, club, facility_type, days_ahead=4),
                           format="json")
    assert second.status_code == 400
    assert "maximum of 1" in str(second.json())


def test_a_club_override_beats_the_default_through_the_api(auth_api, customer, club,
                                                           court, facility_type, policy):
    policy.max_advance_days = 2
    policy.enforce_for_staff = True
    policy.save()
    BookingPolicy.objects.create(club=club, max_advance_days=365,
                                 enforce_for_staff=True)
    resp = auth_api.post("/api/v1/bookings/",
                         _payload(customer, club, facility_type, days_ahead=200),
                         format="json")
    assert resp.status_code == 201, resp.content


# --------------------------------------------------------------------------- #
# Public website booking: always bound
# --------------------------------------------------------------------------- #
def _public(facility_type, club, days_ahead=3, at="10:00", **extra):
    return {
        "facility_type": facility_type.id, "club": club.id,
        "date": (date.today() + timedelta(days=days_ahead)).isoformat(),
        "time": at, "name": "Layla Ahmed",
        "email": "web@riversideclub.ae", "phone": "+971500000009",
        **extra,
    }


def test_a_website_booking_beyond_the_horizon_is_refused(api, club, court,
                                                         facility_type, policy, tax_rate):
    policy.max_advance_days = 5
    policy.save()
    resp = api.post("/api/v1/website/public/bookings/",
                    _public(facility_type, club, days_ahead=60), format="json")
    assert resp.status_code == 400
    assert "5 days ahead" in resp.json()["detail"]
    assert resp.json()["rules"]


def test_a_website_booking_inside_the_horizon_succeeds(api, club, court,
                                                       facility_type, policy, tax_rate):
    policy.max_advance_days = 30
    policy.save()
    resp = api.post("/api/v1/website/public/bookings/",
                    _public(facility_type, club, days_ahead=3), format="json")
    assert resp.status_code == 201, resp.content


def test_a_website_booking_inside_the_lead_time_is_refused(api, club, court,
                                                           facility_type, policy, tax_rate):
    policy.min_lead_minutes = 300
    policy.save()
    soon = timezone.localtime() + timedelta(minutes=30)
    resp = api.post("/api/v1/website/public/bookings/", {
        **_public(facility_type, club),
        "date": soon.date().isoformat(), "time": soon.strftime("%H:%M"),
    }, format="json")
    assert resp.status_code == 400
    assert "notice" in resp.json()["detail"]


def test_a_returning_guest_is_held_to_the_per_customer_cap(api, club, court,
                                                           facility_type, policy, tax_rate):
    policy.max_active_bookings_per_customer = 1
    policy.save()
    first = api.post("/api/v1/website/public/bookings/",
                     _public(facility_type, club, days_ahead=3), format="json")
    assert first.status_code == 201, first.content

    # Same contact -> resolves to the same Customer -> the cap now bites.
    second = api.post("/api/v1/website/public/bookings/",
                      _public(facility_type, club, days_ahead=4), format="json")
    assert second.status_code == 400
    assert "maximum of 1" in second.json()["detail"]


def test_public_availability_carries_the_booking_window(api, club, court,
                                                        facility_type, policy):
    policy.max_advance_days = 21
    policy.save()
    on_date = (date.today() + timedelta(days=2)).isoformat()
    body = api.get(f"/api/v1/website/public/availability/?club={club.id}"
                   f"&date={on_date}&facility_type={facility_type.id}").json()
    assert body["window"]["max_advance_days"] == 21
    assert body["window"]["latest_date"] == (date.today() + timedelta(days=21)).isoformat()


# --------------------------------------------------------------------------- #
# Cancellation window through the API
# --------------------------------------------------------------------------- #
@pytest.fixture
def customer_client(db, customer, make_user):
    """A signed-in customer who owns `customer`."""
    from rest_framework.test import APIClient
    from apps.accounts.models import Role

    user = make_user("member@example.com", role=Role.CUSTOMER)
    customer.linked_user = user
    customer.save()
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_a_customer_can_cancel_inside_the_window(customer_client, booking_on,
                                                 court, policy):
    policy.cancellation_cutoff_hours = 12
    policy.save()
    b = booking_on(on_date=date.today() + timedelta(days=5), at_time=time(10, 0))
    resp = customer_client.post(f"/api/v1/bookings/{b.id}/cancel/", {}, format="json")
    assert resp.status_code == 200, resp.content
    b.refresh_from_db()
    assert b.status == BookingStatus.CANCELLED


def test_a_customer_cannot_cancel_past_the_cutoff(customer_client, booking_on,
                                                  court, policy):
    policy.cancellation_cutoff_hours = 48
    policy.save()
    soon = timezone.localtime() + timedelta(hours=3)
    b = booking_on(on_date=soon.date(), at_time=soon.time().replace(microsecond=0))
    resp = customer_client.post(f"/api/v1/bookings/{b.id}/cancel/", {}, format="json")
    assert resp.status_code == 409
    assert "no longer be cancelled online" in resp.json()["detail"]
    b.refresh_from_db()
    assert b.status != BookingStatus.CANCELLED


def test_staff_can_still_cancel_past_the_cutoff(auth_api, booking_on, court, policy):
    policy.cancellation_cutoff_hours = 48
    policy.save()
    soon = timezone.localtime() + timedelta(hours=3)
    b = booking_on(on_date=soon.date(), at_time=soon.time().replace(microsecond=0))
    resp = auth_api.post(f"/api/v1/bookings/{b.id}/cancel/", {}, format="json")
    assert resp.status_code == 200, resp.content
    b.refresh_from_db()
    assert b.status == BookingStatus.CANCELLED


def test_the_booking_payload_reports_the_cancellation_state(auth_api, booking_on,
                                                            court, policy):
    policy.cancellation_cutoff_hours = 24
    policy.save()
    b = booking_on(on_date=date.today() + timedelta(days=5), at_time=time(10, 0))
    body = auth_api.get(f"/api/v1/bookings/{b.id}/").json()
    assert body["cancellation"]["cutoff_hours"] == 24
    assert body["cancellation"]["customer_can_cancel"] is True
    assert body["cancellation"]["deadline"]
