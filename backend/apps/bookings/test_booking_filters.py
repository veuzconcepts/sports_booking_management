"""The bookings list filters, as the toolbar and the calendar actually send them.

`source` shipped as a dropdown the API silently ignored - every option returned
the full list. The calendar view depends on `date_from`/`date_to` being honoured
exactly, so those are pinned here too.
"""

from datetime import date, time, timedelta

import pytest


@pytest.fixture
def spread(db, booking_on, facilities):
    """Bookings across three days so a range query has edges to get wrong."""
    base = date.today()
    return {
        "before": booking_on(on_date=base, at_time=time(9, 0)),
        "inside": booking_on(on_date=base + timedelta(days=1), at_time=time(9, 0)),
        "after": booking_on(on_date=base + timedelta(days=2), at_time=time(9, 0)),
    }


def _refs(resp):
    return {r["reference"] for r in resp.json()["results"]}


def test_source_filter_actually_narrows_the_list(auth_api, spread):
    b = spread["inside"]
    b.source = "website"
    b.save(update_fields=["source"])

    assert _refs(auth_api.get("/api/v1/bookings/", {"source": "website"})) == {b.reference}
    assert b.reference not in _refs(auth_api.get("/api/v1/bookings/", {"source": "phone"}))


def test_an_unknown_source_is_rejected_not_ignored(auth_api, spread):
    """Silently returning everything is what made the broken filter invisible."""
    resp = auth_api.get("/api/v1/bookings/", {"source": "carrier-pigeon"})
    assert resp.status_code == 400


def test_payment_status_and_booking_type_filter(auth_api, spread):
    b = spread["inside"]
    b.booking_type = "walk_in"
    b.save(update_fields=["booking_type"])
    assert _refs(auth_api.get("/api/v1/bookings/", {"booking_type": "walk_in"})) == {b.reference}


def test_date_range_is_inclusive_at_both_ends(auth_api, spread):
    """The calendar asks for exactly the visible days - an exclusive edge would
    drop bookings off the first or last column."""
    start = date.today()
    end = start + timedelta(days=2)
    got = _refs(auth_api.get("/api/v1/bookings/",
                             {"date_from": start.isoformat(), "date_to": end.isoformat()}))
    assert got == {b.reference for b in spread.values()}


def test_date_range_excludes_what_falls_outside(auth_api, spread):
    only = date.today() + timedelta(days=1)
    got = _refs(auth_api.get("/api/v1/bookings/",
                             {"date_from": only.isoformat(), "date_to": only.isoformat()}))
    assert got == {spread["inside"].reference}


def test_filters_combine_rather_than_replace_each_other(auth_api, spread, club):
    b = spread["inside"]
    b.source = "website"
    b.save(update_fields=["source"])
    day = b.scheduled_date.isoformat()

    # Right day, wrong source -> nothing.
    assert _refs(auth_api.get("/api/v1/bookings/",
                              {"date_from": day, "date_to": day, "source": "phone"})) == set()
    # Right day, right source -> just that one.
    assert _refs(auth_api.get("/api/v1/bookings/",
                              {"date_from": day, "date_to": day, "source": "website",
                               "club": club.id})) == {b.reference}


def test_the_calendar_can_pull_a_whole_week_in_one_page(auth_api, spread):
    """The calendar is not paginated - it asks for the range in one go."""
    start = date.today()
    resp = auth_api.get("/api/v1/bookings/", {
        "date_from": start.isoformat(),
        "date_to": (start + timedelta(days=6)).isoformat(),
        "page_size": 500,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["results"]) == body["count"] == 3
