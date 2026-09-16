"""Every report endpoint, hit for real.

These exist because `bookings_report` and `top_services` shipped querying fields
that no longer exist (`site__name`, `service_item__name`) - a 500 on page load
that no test caught, since reports had no coverage at all. Each report is
exercised against real rows so a stale field or renamed dict key fails here
rather than in the browser.
"""

from datetime import date, time, timedelta

import pytest

from apps.bookings.models import Booking

REPORTS = ["summary", "revenue", "bookings", "services", "performance", "memberships"]


@pytest.fixture
def booked(db, booking_on, facilities):
    """A couple of bookings so the aggregates have something to group."""
    return [
        booking_on(on_date=date.today() + timedelta(days=1), at_time=time(9, 0)),
        booking_on(on_date=date.today() + timedelta(days=2), at_time=time(11, 0)),
    ]


@pytest.mark.parametrize("report", REPORTS)
def test_every_report_loads(auth_api, booked, report):
    """A stale field reference surfaces as a 500 - this is the guard against it."""
    resp = auth_api.get(f"/api/v1/reports/{report}/")
    assert resp.status_code == 200, f"{report}: {resp.content[:300]}"


@pytest.mark.parametrize("report", REPORTS)
def test_every_report_accepts_a_date_range_and_club(auth_api, booked, club, report):
    span = {"date_from": (date.today() - timedelta(days=30)).isoformat(),
            "date_to": (date.today() + timedelta(days=30)).isoformat(),
            "club": club.id}
    resp = auth_api.get(f"/api/v1/reports/{report}/", span)
    assert resp.status_code == 200, f"{report}: {resp.content[:300]}"


def test_reports_require_authentication(api):
    assert api.get("/api/v1/reports/bookings/").status_code == 401


def test_bookings_report_groups_by_club_with_names(auth_api, booked, club):
    """`by_club` carries the club's NAME - the bug was reading it off a stale
    `site` relation, which cannot resolve at all."""
    body = auth_api.get("/api/v1/reports/bookings/", {
        "date_from": (date.today() - timedelta(days=1)).isoformat(),
        "date_to": (date.today() + timedelta(days=10)).isoformat(),
    }).json()
    assert body["total"] == len(booked)
    rows = {r["club"]: r for r in body["by_club"]}
    assert rows[club.id]["name"] == club.name
    assert rows[club.id]["count"] == len(booked)


def test_top_services_labels_rows_by_facility_type(auth_api, booked, facility_type):
    """Grouped by facility type, so the label must come from that same relation."""
    body = auth_api.get("/api/v1/reports/services/", {
        "date_from": (date.today() - timedelta(days=1)).isoformat(),
        "date_to": (date.today() + timedelta(days=10)).isoformat(),
    }).json()
    assert body, "expected at least one facility type row"
    assert body[0]["name"] == facility_type.name
    assert body[0]["bookings"] >= 1


def test_a_report_with_no_data_is_empty_not_an_error(auth_api, db):
    """An empty window must return empty aggregates rather than blowing up."""
    body = auth_api.get("/api/v1/reports/bookings/", {
        "date_from": "2001-01-01", "date_to": "2001-01-31",
    }).json()
    assert body["total"] == 0
    assert body["by_club"] == []


# --------------------------------------------------------------------------- #
# Exports - these read keys off the report dicts, so a renamed key breaks them
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("report", ["revenue", "club", "services"])
@pytest.mark.parametrize("fmt", ["xlsx", "pdf"])
def test_exports_produce_a_file(auth_api, booked, report, fmt):
    resp = auth_api.get("/api/v1/reports/export/", {"report": report, "fmt": fmt})
    assert resp.status_code == 200, f"{report}/{fmt}: {resp.content[:300]}"
    assert len(b"".join(resp.streaming_content) if resp.streaming
               else resp.content) > 0


def test_an_unknown_export_is_rejected(auth_api, db):
    resp = auth_api.get("/api/v1/reports/export/", {"report": "nonsense"})
    assert resp.status_code == 400


def test_a_club_scoped_user_only_sees_their_club(auth_api, booked, club, make_user):
    """`scope_clubs` must not leak another club's numbers into the totals."""
    from rest_framework.test import APIClient
    from apps.accounts.models import Role
    from apps.clubs.models import Club

    other = Club.objects.create(name="Elsewhere FC", code="ELS")
    user = make_user("manager@riversideclub.ae", role=Role.MANAGER)
    user.assigned_clubs.set([other])
    client = APIClient()
    client.force_authenticate(user=user)

    body = client.get("/api/v1/reports/bookings/", {
        "date_from": (date.today() - timedelta(days=1)).isoformat(),
        "date_to": (date.today() + timedelta(days=10)).isoformat(),
    }).json()
    assert club.id not in {r["club"] for r in body["by_club"]}
