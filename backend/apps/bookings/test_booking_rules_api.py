"""Booking rules as they are actually enforced: through the admin API, the
public website booking, and the cancel action."""

from datetime import date, time, timedelta

import pytest
from django.utils import timezone

from apps.bookings.models import Booking, BookingPolicy, BookingStatus
from apps.bookings.services import resolve_policy
from apps.facilities.models import Facility

def today():
    """The service works in the configured timezone, so the tests must too:
    the machine's local date differs from it between the two midnights."""
    return timezone.localdate()



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
        "scheduled_date": (today() + timedelta(days=days_ahead)).isoformat(),
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
    assert body["latest_date"] == (today() + timedelta(days=10)).isoformat()


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
        "date": (today() + timedelta(days=days_ahead)).isoformat(),
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
    on_date = (today() + timedelta(days=2)).isoformat()
    body = api.get(f"/api/v1/website/public/availability/?club={club.id}"
                   f"&date={on_date}&facility_type={facility_type.id}").json()
    assert body["window"]["max_advance_days"] == 21
    assert body["window"]["latest_date"] == (today() + timedelta(days=21)).isoformat()


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
    b = booking_on(on_date=today() + timedelta(days=5), at_time=time(10, 0))
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
    b = booking_on(on_date=today() + timedelta(days=5), at_time=time(10, 0))
    body = auth_api.get(f"/api/v1/bookings/{b.id}/").json()
    assert body["cancellation"]["cutoff_hours"] == 24
    assert body["cancellation"]["customer_can_cancel"] is True
    assert body["cancellation"]["deadline"]


# --------------------------------------------------------------------------- #
# Effective multi-slot rules
# --------------------------------------------------------------------------- #
def test_effective_rules_answer_without_a_row_existing(auth_api, court, db):
    """The normal case: a facility inherits everything and has no row at all.

    The settings panel asks this to show what "inherit" would give, so it has
    to answer for a scope that has never been configured.
    """
    resp = auth_api.get(f"/api/v1/bookings/policies/effective/?facility={court.id}")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["has_own_policy"] is False
    assert body["policy"] is None
    # A fresh install books one slot at a time.
    assert body["rules"]["allow_multiple_slots"] is False
    assert body["rules"]["max_slots_per_booking"] == 1


def test_effective_rules_for_a_club(auth_api, club, db):
    resp = auth_api.get(f"/api/v1/bookings/policies/effective/?club={club.id}")
    assert resp.status_code == 200, resp.content
    assert resp.json()["rules"]["allow_multiple_slots"] is False


def test_effective_rules_for_the_organization(auth_api, db):
    resp = auth_api.get("/api/v1/bookings/policies/effective/")
    assert resp.status_code == 200, resp.content
    assert "rules" in resp.json()


def test_effective_rules_merge_down_the_chain(auth_api, club, court, db):
    """Section 48: the facility overrides only what it states."""
    BookingPolicy.objects.create(
        is_default=True, allow_multiple_slots=True, max_slots_per_booking=4,
        allow_multiple_dates=True)
    BookingPolicy.objects.create(facility=court, max_slots_per_booking=2)

    body = auth_api.get(
        f"/api/v1/bookings/policies/effective/?facility={court.id}").json()
    assert body["has_own_policy"] is True
    rules = body["rules"]
    assert rules["max_slots_per_booking"] == 2        # the override
    assert rules["allow_multiple_slots"] is True      # inherited
    assert rules["allow_multiple_dates"] is True      # inherited


def test_effective_rules_reject_an_unknown_facility(auth_api, db):
    resp = auth_api.get("/api/v1/bookings/policies/effective/?facility=999999")
    assert resp.status_code == 404


def test_a_facility_policy_can_be_created_and_removed(auth_api, court, db):
    """What the settings panel does: write an override, then reset it."""
    created = auth_api.post("/api/v1/bookings/policies/", {
        "facility": court.id, "allow_multiple_slots": True,
        "max_slots_per_booking": 3,
    }, format="json")
    assert created.status_code == 201, created.content
    assert created.json()["scope"] == court.name

    removed = auth_api.delete(f"/api/v1/bookings/policies/{created.json()['id']}/")
    assert removed.status_code == 204
    # Back to inheriting.
    body = auth_api.get(
        f"/api/v1/bookings/policies/effective/?facility={court.id}").json()
    assert body["has_own_policy"] is False


def test_a_policy_cannot_claim_two_scopes(auth_api, club, court, db):
    resp = auth_api.post("/api/v1/bookings/policies/", {
        "club": club.id, "facility": court.id,
    }, format="json")
    assert resp.status_code == 400


def test_a_floor_above_the_ceiling_is_refused(auth_api, court, db):
    resp = auth_api.post("/api/v1/bookings/policies/", {
        "facility": court.id, "allow_multiple_slots": True,
        "min_slots_per_booking": 4, "max_slots_per_booking": 2,
    }, format="json")
    assert resp.status_code == 400


# --------------------------------------------------------------------------- #
# Managing many scopes at once
# --------------------------------------------------------------------------- #
def test_effective_at_the_organization_scope_returns_its_own_row(auth_api, db):
    """"All clubs" is a real scope, not the absence of one.

    The editor needs a row id to save against, and the organization default is
    created on first access, so this scope always has one.
    """
    body = auth_api.get("/api/v1/bookings/policies/effective/").json()
    assert body["has_own_policy"] is True
    assert body["policy"]["is_default"] is True


def test_overrides_below_a_scope_are_counted(auth_api, club, court, db):
    """What stops a change here from reaching everything below it."""
    empty = auth_api.get("/api/v1/bookings/policies/effective/").json()
    assert empty["overrides"] == {"clubs": 0, "facilities": 0}

    BookingPolicy.objects.create(club=club, allow_multiple_slots=True)
    BookingPolicy.objects.create(facility=court, max_slots_per_booking=2)

    body = auth_api.get("/api/v1/bookings/policies/effective/").json()
    assert body["overrides"] == {"clubs": 1, "facilities": 1}

    # From the club's own point of view only the facility below it counts.
    scoped = auth_api.get(
        f"/api/v1/bookings/policies/effective/?club={club.id}").json()
    assert scoped["overrides"] == {"clubs": 0, "facilities": 1}

    # Nothing is more specific than a facility.
    leaf = auth_api.get(
        f"/api/v1/bookings/policies/effective/?facility={court.id}").json()
    assert leaf["overrides"] == {"clubs": 0, "facilities": 0}


def test_a_row_that_states_no_slot_rule_is_not_an_override(auth_api, club, db):
    """A club row that only changes the lead time is not overriding slots."""
    BookingPolicy.objects.create(club=club, min_lead_minutes=90)
    body = auth_api.get("/api/v1/bookings/policies/effective/").json()
    assert body["overrides"] == {"clubs": 0, "facilities": 0}


def test_clearing_overrides_makes_facilities_follow_the_club_again(
        auth_api, club, court, db):
    BookingPolicy.objects.create(club=club, allow_multiple_slots=True,
                                 max_slots_per_booking=5)
    BookingPolicy.objects.create(facility=court, max_slots_per_booking=2)

    resp = auth_api.post("/api/v1/bookings/policies/clear-overrides/",
                         {"club": club.id}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["cleared"] == 1
    assert resp.json()["affected"] == [court.name]

    rules = auth_api.get(
        f"/api/v1/bookings/policies/effective/?facility={court.id}").json()["rules"]
    assert rules["max_slots_per_booking"] == 5      # the club's number now


def test_clearing_overrides_keeps_the_rows_other_settings(auth_api, club, court, db):
    """Only the slot fields are cleared. A facility that also sets its own
    cancellation window keeps it: the operator asked for one set of slot rules,
    not for the row to be thrown away."""
    own = BookingPolicy.objects.create(facility=court, max_slots_per_booking=2,
                                       min_lead_minutes=45)
    auth_api.post("/api/v1/bookings/policies/clear-overrides/",
                  {"club": club.id}, format="json")
    own.refresh_from_db()
    assert own.max_slots_per_booking is None
    assert own.min_lead_minutes == 45


def test_clearing_at_the_organization_scope_reaches_club_rows(
        auth_api, club, court, db):
    BookingPolicy.objects.create(club=club, allow_multiple_slots=True)
    BookingPolicy.objects.create(facility=court, max_slots_per_booking=2)

    resp = auth_api.post("/api/v1/bookings/policies/clear-overrides/", {},
                         format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["cleared"] == 2

    body = auth_api.get("/api/v1/bookings/policies/effective/").json()
    assert body["overrides"] == {"clubs": 0, "facilities": 0}


def test_clearing_never_touches_the_organization_default(auth_api, policy, db):
    policy.allow_multiple_slots = True
    policy.max_slots_per_booking = 6
    policy.save()
    auth_api.post("/api/v1/bookings/policies/clear-overrides/", {}, format="json")
    policy.refresh_from_db()
    assert policy.allow_multiple_slots is True
    assert policy.max_slots_per_booking == 6


def test_clearing_overrides_requires_authentication(api):
    resp = api.post("/api/v1/bookings/policies/clear-overrides/", {}, format="json")
    assert resp.status_code == 401


def test_clearing_overrides_rejects_an_unknown_club(auth_api, db):
    resp = auth_api.post("/api/v1/bookings/policies/clear-overrides/",
                         {"club": 999999}, format="json")
    assert resp.status_code == 404
