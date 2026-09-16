"""Clubs: model constraints, club scoping and the API surface.

Opening hours are NOT tested here: a club's hours are the `booking_hours`
document resolved by `apps.settings_app.schedule`, covered in
apps/settings_app/test_schedule.py. The old per-weekday `ClubHours` table was a
second, unused source of truth and has been removed.
"""

import pytest

from apps.clubs.models import Club


def test_club_code_is_unique(db, club):
    with pytest.raises(Exception):
        Club.objects.create(code="riverside", name="Duplicate")


def test_deleting_a_club_cascades_its_facilities(db, club, facilities):
    from apps.facilities.models import Facility
    club.delete()
    assert Facility.objects.count() == 0


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
def test_clubs_endpoint_requires_authentication(api):
    assert api.get("/api/v1/clubs/").status_code == 401


def test_admin_sees_every_club(auth_api, club):
    Club.objects.create(code="north", name="Northside")
    resp = auth_api.get("/api/v1/clubs/")
    assert resp.status_code == 200
    assert {r["code"] for r in resp.json()["results"]} == {"riverside", "north"}


def test_club_payload_includes_its_facilities(auth_api, club, facilities):
    resp = auth_api.get(f"/api/v1/clubs/{club.id}/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["facility_count"] == 3
    assert {f["name"] for f in body["facilities"]} == {"Court 1", "Court 2", "Court 3"}


def test_club_admin_only_sees_assigned_clubs(db, make_user, club):
    from rest_framework.test import APIClient
    from apps.accounts.models import Role

    Club.objects.create(code="north", name="Northside")
    user = make_user("clubadmin@example.com", role=Role.CLUB_ADMIN)
    user.assigned_clubs.set([club])

    client = APIClient()
    client.force_authenticate(user=user)
    resp = client.get("/api/v1/clubs/")
    assert resp.status_code == 200
    assert {r["code"] for r in resp.json()["results"]} == {"riverside"}


def test_a_club_in_use_cannot_be_deleted(auth_api, club, facility_type, booking_on):
    booking_on()
    resp = auth_api.delete(f"/api/v1/clubs/{club.id}/")
    assert resp.status_code == 409
    assert "bookings" in resp.json()["detail"]


def test_an_unused_club_can_be_deleted(auth_api, club):
    assert auth_api.delete(f"/api/v1/clubs/{club.id}/").status_code == 204
    assert Club.objects.count() == 0
