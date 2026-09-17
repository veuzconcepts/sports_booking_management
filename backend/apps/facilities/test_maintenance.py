"""API surface for facility <-> type links, maintenance blocks and the
free-facilities picker that drives the staff override."""

from datetime import date, time, timedelta

import pytest

from apps.facilities.models import Facility, MaintenanceBlock

THURSDAY = date(2026, 6, 4)


@pytest.fixture
def court(db, club, facility_type):
    f = Facility.objects.create(club=club, name="Court 1")
    f.facility_types.set([facility_type])
    return f


# --------------------------------------------------------------------------- #
# Facility <-> facility type
# --------------------------------------------------------------------------- #
def test_facility_payload_lists_the_types_it_serves(auth_api, court, facility_type):
    body = auth_api.get(f"/api/v1/facilities/{court.id}/").json()
    assert body["facility_types"] == [facility_type.id]
    assert body["facility_type_names"] == ["Tennis Court"]


def test_a_facility_can_be_created_with_several_types(auth_api, club, facility_type,
                                                      facility_category):
    from apps.facilities.models import FacilityType
    hall_use = FacilityType.objects.create(name="Function Hall", duration_minutes=120)
    hall_use.categories.set([facility_category])

    resp = auth_api.post("/api/v1/facilities/", {
        "club": club.id, "name": "Hall A",
        "facility_types": [facility_type.id, hall_use.id],
    }, format="json")
    assert resp.status_code == 201, resp.content
    assert sorted(resp.json()["facility_type_names"]) == ["Function Hall", "Tennis Court"]


def test_facilities_can_be_filtered_by_type(auth_api, club, court, facility_type):
    Facility.objects.create(club=club, name="Pool Lane 1")     # no types -> universal
    resp = auth_api.get(f"/api/v1/facilities/?facility_types={facility_type.id}")
    assert resp.status_code == 200
    assert [r["name"] for r in resp.json()["results"]] == ["Court 1"]


def test_a_facility_with_no_types_serves_everything(db, court, facility_type, club):
    universal = Facility.objects.create(club=club, name="Spare")
    assert universal.serves(facility_type) is True
    assert court.serves(facility_type) is True


# --------------------------------------------------------------------------- #
# Maintenance blocks
# --------------------------------------------------------------------------- #
def test_maintenance_endpoint_requires_authentication(api):
    assert api.get("/api/v1/facilities/maintenance-blocks/").status_code == 401


def test_create_an_all_day_block(auth_api, court):
    resp = auth_api.post("/api/v1/facilities/maintenance-blocks/", {
        "facility": court.id, "start_date": THURSDAY.isoformat(),
        "end_date": THURSDAY.isoformat(), "reason": "Resurfacing",
    }, format="json")
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["is_all_day"] is True
    assert body["facility_name"] == "Court 1"
    assert body["club_name"] == "Riverside Club"


def test_create_a_timed_block(auth_api, court):
    resp = auth_api.post("/api/v1/facilities/maintenance-blocks/", {
        "facility": court.id, "start_date": THURSDAY.isoformat(),
        "end_date": THURSDAY.isoformat(),
        "start_time": "12:00", "end_time": "14:00", "reason": "Net replacement",
    }, format="json")
    assert resp.status_code == 201, resp.content
    assert resp.json()["is_all_day"] is False


def test_block_records_who_created_it(auth_api, court, admin_user):
    auth_api.post("/api/v1/facilities/maintenance-blocks/", {
        "facility": court.id, "start_date": THURSDAY.isoformat(),
        "end_date": THURSDAY.isoformat(),
    }, format="json")
    assert MaintenanceBlock.objects.get().created_by == admin_user


def test_block_rejects_a_backwards_date_range(auth_api, court):
    resp = auth_api.post("/api/v1/facilities/maintenance-blocks/", {
        "facility": court.id,
        "start_date": THURSDAY.isoformat(),
        "end_date": (THURSDAY - timedelta(days=1)).isoformat(),
    }, format="json")
    assert resp.status_code == 400
    assert "end_date" in resp.json()


def test_block_rejects_a_half_specified_window(auth_api, court):
    resp = auth_api.post("/api/v1/facilities/maintenance-blocks/", {
        "facility": court.id, "start_date": THURSDAY.isoformat(),
        "end_date": THURSDAY.isoformat(), "start_time": "12:00",
    }, format="json")
    assert resp.status_code == 400
    assert "start_time" in resp.json()


def test_block_rejects_a_backwards_time_window(auth_api, court):
    resp = auth_api.post("/api/v1/facilities/maintenance-blocks/", {
        "facility": court.id, "start_date": THURSDAY.isoformat(),
        "end_date": THURSDAY.isoformat(), "start_time": "14:00", "end_time": "12:00",
    }, format="json")
    assert resp.status_code == 400
    assert "end_time" in resp.json()


def test_blocks_can_be_filtered_to_a_given_day(auth_api, court):
    MaintenanceBlock.objects.create(
        facility=court, start_date=THURSDAY, end_date=THURSDAY + timedelta(days=2))
    MaintenanceBlock.objects.create(
        facility=court, start_date=THURSDAY - timedelta(days=9),
        end_date=THURSDAY - timedelta(days=7))

    on_day = auth_api.get(
        f"/api/v1/facilities/maintenance-blocks/?active_on={(THURSDAY + timedelta(days=1)).isoformat()}")
    assert on_day.status_code == 200
    assert on_day.json()["count"] == 1


def test_a_club_admin_only_sees_their_clubs_blocks(db, make_user, club, court):
    from rest_framework.test import APIClient
    from apps.accounts.models import Role
    from apps.clubs.models import Club

    other_club = Club.objects.create(code="north", name="Northside")
    other_facility = Facility.objects.create(club=other_club, name="Far Court")
    MaintenanceBlock.objects.create(facility=court, start_date=THURSDAY, end_date=THURSDAY)
    MaintenanceBlock.objects.create(facility=other_facility,
                                    start_date=THURSDAY, end_date=THURSDAY)

    user = make_user("clubadmin@example.com", role=Role.CLUB_ADMIN)
    user.assigned_clubs.set([club])
    client = APIClient()
    client.force_authenticate(user=user)

    body = client.get("/api/v1/facilities/maintenance-blocks/").json()
    assert body["count"] == 1
    assert body["results"][0]["facility_name"] == "Court 1"


def test_deleting_a_facility_removes_its_blocks(db, court):
    MaintenanceBlock.objects.create(facility=court, start_date=THURSDAY, end_date=THURSDAY)
    court.delete()
    assert MaintenanceBlock.objects.count() == 0


# --------------------------------------------------------------------------- #
# Availability + allocation through the API
# --------------------------------------------------------------------------- #
def test_availability_is_reported_per_facility_type(auth_api, club, court,
                                                    facility_type, facility_category):
    from apps.facilities.models import FacilityType
    other = FacilityType.objects.create(name="Padel Court", duration_minutes=60)
    other.categories.set([facility_category])

    on_date = (date.today() + timedelta(days=3)).isoformat()
    tennis = auth_api.get(
        f"/api/v1/bookings/availability/?club={club.id}&date={on_date}"
        f"&facility_type={facility_type.id}").json()
    padel = auth_api.get(
        f"/api/v1/bookings/availability/?club={club.id}&date={on_date}"
        f"&facility_type={other.id}").json()

    assert tennis["facility_type"] == facility_type.id
    assert tennis["slots"] and tennis["slots"][0]["capacity"] == 1
    # Court 1 is tennis-only, so there is nothing to host a padel booking.
    assert padel["slots"] == []


def test_availability_404s_for_an_unknown_facility_type(auth_api, club, court):
    on_date = (date.today() + timedelta(days=3)).isoformat()
    resp = auth_api.get(
        f"/api/v1/bookings/availability/?club={club.id}&date={on_date}&facility_type=9999")
    assert resp.status_code == 404


def test_creating_a_booking_allocates_a_facility(auth_api, customer, club, court,
                                                 facility_type):
    on_date = (date.today() + timedelta(days=3)).isoformat()
    resp = auth_api.post("/api/v1/bookings/", {
        "customer": customer.id, "club": club.id, "facility_type": facility_type.id,
        "scheduled_date": on_date, "scheduled_time": "10:00",
    }, format="json")
    assert resp.status_code == 201, resp.content
    assert resp.json()["facility"] == court.id
    assert resp.json()["facility_name"] == "Court 1"


def test_a_second_booking_is_refused_when_the_only_unit_is_taken(
        auth_api, customer, club, court, facility_type):
    on_date = (date.today() + timedelta(days=3)).isoformat()
    payload = {"customer": customer.id, "club": club.id,
               "facility_type": facility_type.id,
               "scheduled_date": on_date, "scheduled_time": "10:00"}
    assert auth_api.post("/api/v1/bookings/", payload, format="json").status_code == 201

    second = auth_api.post("/api/v1/bookings/", payload, format="json")
    assert second.status_code == 400
    assert "scheduled_time" in second.json()


def test_a_booking_cannot_pin_a_facility_that_cannot_host_the_type(
        auth_api, customer, club, court, facility_type, facility_category):
    from apps.facilities.models import FacilityType
    pool = Facility.objects.create(club=club, name="Pool Lane 1")
    swim = FacilityType.objects.create(name="Swimming Lane", duration_minutes=60)
    swim.categories.set([facility_category])
    pool.facility_types.set([swim])

    on_date = (date.today() + timedelta(days=3)).isoformat()
    resp = auth_api.post("/api/v1/bookings/", {
        "customer": customer.id, "club": club.id, "facility_type": facility_type.id,
        "facility": pool.id, "scheduled_date": on_date, "scheduled_time": "10:00",
    }, format="json")
    assert resp.status_code == 400
    assert "facility" in resp.json()


def test_a_blocked_facility_is_not_allocated(auth_api, customer, club, court,
                                             facility_type):
    on_date = date.today() + timedelta(days=3)
    MaintenanceBlock.objects.create(facility=court, start_date=on_date, end_date=on_date)
    resp = auth_api.post("/api/v1/bookings/", {
        "customer": customer.id, "club": club.id, "facility_type": facility_type.id,
        "scheduled_date": on_date.isoformat(), "scheduled_time": "10:00",
    }, format="json")
    assert resp.status_code == 400          # nothing free to allocate


def test_free_facilities_endpoint_lists_valid_overrides(auth_api, customer, club,
                                                        court, facility_type):
    hall = Facility.objects.create(club=club, name="Hall A")
    hall.facility_types.set([facility_type])
    pool = Facility.objects.create(club=club, name="Pool Lane 1")
    pool.facility_types.set([])                      # universal -> also eligible

    on_date = (date.today() + timedelta(days=3)).isoformat()
    created = auth_api.post("/api/v1/bookings/", {
        "customer": customer.id, "club": club.id, "facility_type": facility_type.id,
        "scheduled_date": on_date, "scheduled_time": "10:00",
    }, format="json").json()

    resp = auth_api.get(f"/api/v1/bookings/{created['id']}/free-facilities/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["current"] == created["facility"]
    # The allocated unit is excluded from the clash check, so it stays offered.
    names = {r["name"] for r in body["results"]}
    assert names == {"Court 1", "Hall A", "Pool Lane 1"}


def test_free_facilities_excludes_a_unit_taken_by_another_booking(
        auth_api, customer, club, court, facility_type):
    hall = Facility.objects.create(club=club, name="Hall A")
    hall.facility_types.set([facility_type])

    on_date = (date.today() + timedelta(days=3)).isoformat()
    payload = {"customer": customer.id, "club": club.id,
               "facility_type": facility_type.id,
               "scheduled_date": on_date, "scheduled_time": "10:00"}
    first = auth_api.post("/api/v1/bookings/", payload, format="json").json()
    auth_api.post("/api/v1/bookings/", payload, format="json")   # takes the other unit

    body = auth_api.get(f"/api/v1/bookings/{first['id']}/free-facilities/").json()
    assert {r["id"] for r in body["results"]} == {first["facility"]}
