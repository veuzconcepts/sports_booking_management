"""The shared listing contract every admin list endpoint answers.

`page_size` and `group_by` are tested here rather than per app because they come
from `config.listing` and must behave identically everywhere - that is the whole
point of having one table component in front of them.
"""

from datetime import date, time, timedelta

import pytest

MONDAY = date(2026, 9, 21)


@pytest.fixture
def many_bookings(db, booking_on, facilities, club):
    """More bookings than one default page, across two clubs and two statuses."""
    from apps.clubs.models import Club

    other = Club.objects.create(code="north", name="Northside")
    made = []
    for i in range(25):
        made.append(booking_on(on_date=MONDAY + timedelta(days=i % 5),
                               at_time=time(8 + (i % 10), 0)))
    for i, b in enumerate(made):
        b.status = "confirmed" if i % 2 else "booked"
        if i % 3 == 0:
            b.club = other
        b.save(update_fields=["status", "club"])
    return made


# --------------------------------------------------------------------------- #
# Page size
# --------------------------------------------------------------------------- #
def test_page_size_is_honoured(auth_api, many_bookings):
    """It was silently ignored: asking for 100 returned the default 20, with no
    sign that the rest existed."""
    body = auth_api.get("/api/v1/bookings/", {"page_size": 5}).json()
    assert body["count"] == 25
    assert len(body["results"]) == 5


@pytest.mark.parametrize("size", [25, 50, 100])
def test_the_offered_page_sizes_all_work(auth_api, many_bookings, size):
    body = auth_api.get("/api/v1/bookings/", {"page_size": size}).json()
    assert len(body["results"]) == min(size, 25)


def test_a_large_page_size_is_capped_rather_than_refused(auth_api, many_bookings):
    """The booking calendar asks for a whole month in one request; the cap keeps
    that bounded without breaking the caller."""
    body = auth_api.get("/api/v1/bookings/", {"page_size": 5000}).json()
    assert len(body["results"]) == 25


def test_the_calendar_can_load_a_whole_range_in_one_page(auth_api, many_bookings):
    """Regression: the calendar requested page_size=500 while the parameter was
    ignored, so a busy week silently showed only the first 20 bookings."""
    body = auth_api.get("/api/v1/bookings/", {
        "date_from": MONDAY.isoformat(),
        "date_to": (MONDAY + timedelta(days=6)).isoformat(),
        "page_size": 500,
    }).json()
    assert len(body["results"]) == body["count"] == 25


def test_the_default_page_size_is_unchanged(auth_api, many_bookings):
    body = auth_api.get("/api/v1/bookings/").json()
    assert len(body["results"]) == 20


def test_paging_still_walks_the_whole_set(auth_api, many_bookings):
    first = auth_api.get("/api/v1/bookings/", {"page_size": 10, "page": 1}).json()
    third = auth_api.get("/api/v1/bookings/", {"page_size": 10, "page": 3}).json()
    assert len(first["results"]) == 10
    assert len(third["results"]) == 5
    assert not ({r["id"] for r in first["results"]}
                & {r["id"] for r in third["results"]})


# --------------------------------------------------------------------------- #
# Grouping
# --------------------------------------------------------------------------- #
def test_grouping_returns_buckets_not_rows(auth_api, many_bookings):
    """Group headers only. Rows arrive when a group is expanded, so opening one
    group never pulls the whole dataset into the browser."""
    body = auth_api.get("/api/v1/bookings/", {"group_by": "status"}).json()
    assert "results" not in body
    assert body["group_by"] == "status"
    assert {g["key"] for g in body["groups"]} == {"booked", "confirmed"}
    assert sum(g["count"] for g in body["groups"]) == 25


def test_group_counts_match_what_expanding_the_group_returns(auth_api, many_bookings):
    groups = auth_api.get("/api/v1/bookings/", {"group_by": "status"}).json()
    confirmed = next(g for g in groups["groups"] if g["key"] == "confirmed")

    rows = auth_api.get("/api/v1/bookings/", {
        groups["filter_param"]: confirmed["key"], "page_size": 100,
    }).json()
    assert rows["count"] == confirmed["count"]


def test_a_group_carries_the_parameter_needed_to_expand_it(auth_api, many_bookings, club):
    body = auth_api.get("/api/v1/bookings/", {"group_by": "club"}).json()
    assert body["filter_param"] == "club"
    target = next(g for g in body["groups"] if g["key"] == club.id)

    rows = auth_api.get("/api/v1/bookings/", {"club": club.id, "page_size": 100}).json()
    assert rows["count"] == target["count"]


def test_a_choice_field_is_grouped_with_readable_labels(auth_api, many_bookings):
    body = auth_api.get("/api/v1/bookings/", {"group_by": "status"}).json()
    labels = {g["key"]: g["label"] for g in body["groups"]}
    assert labels["booked"] == "Pending"      # not the raw code
    assert labels["confirmed"] == "Confirmed"


def test_grouping_respects_the_active_filters(auth_api, many_bookings, club):
    """Grouping runs over the SAME filtered queryset the list would return, so a
    count can never disagree with the filters on screen."""
    all_groups = auth_api.get("/api/v1/bookings/", {"group_by": "status"}).json()
    scoped = auth_api.get("/api/v1/bookings/",
                          {"group_by": "status", "club": club.id}).json()
    assert sum(g["count"] for g in scoped["groups"]) < sum(
        g["count"] for g in all_groups["groups"])


def test_grouping_respects_the_search_term(auth_api, many_bookings):
    one = many_bookings[0]
    body = auth_api.get("/api/v1/bookings/",
                        {"group_by": "status", "search": one.reference}).json()
    assert sum(g["count"] for g in body["groups"]) == 1


def test_an_unsupported_group_is_refused_with_the_allowed_list(auth_api, many_bookings):
    resp = auth_api.get("/api/v1/bookings/", {"group_by": "nonsense"})
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "nonsense" in detail and "club" in detail


def test_grouping_is_scoped_like_the_list_itself(db, many_bookings, club, make_user):
    """A club-restricted user must not learn another club's counts."""
    from rest_framework.test import APIClient
    from apps.accounts.models import Role

    user = make_user("manager@riversideclub.ae", role=Role.MANAGER)
    user.assigned_clubs.set([club])
    api = APIClient()
    api.force_authenticate(user=user)

    body = api.get("/api/v1/bookings/", {"group_by": "club"}).json()
    assert {g["key"] for g in body["groups"]} <= {club.id}


def test_grouping_requires_authentication(api):
    assert api.get("/api/v1/bookings/", {"group_by": "club"}).status_code == 401


def test_an_empty_result_groups_to_nothing(auth_api, db):
    body = auth_api.get("/api/v1/bookings/", {"group_by": "status"}).json()
    assert body["groups"] == []


# --------------------------------------------------------------------------- #
# Search and ordering still behave (the table drives both)
# --------------------------------------------------------------------------- #
def test_search_covers_the_fields_the_listing_page_offers(auth_api, many_bookings, club):
    one = many_bookings[0]
    by_ref = auth_api.get("/api/v1/bookings/", {"search": one.reference}).json()
    assert by_ref["count"] == 1

    by_club = auth_api.get("/api/v1/bookings/", {"search": club.name}).json()
    assert by_club["count"] > 0


def test_ordering_can_be_reversed(auth_api, many_bookings):
    asc = auth_api.get("/api/v1/bookings/",
                       {"ordering": "reference", "page_size": 100}).json()["results"]
    desc = auth_api.get("/api/v1/bookings/",
                        {"ordering": "-reference", "page_size": 100}).json()["results"]
    assert [r["reference"] for r in asc] == sorted(r["reference"] for r in asc)
    assert [r["reference"] for r in desc] == list(reversed([r["reference"] for r in asc]))


def test_clearing_the_sort_falls_back_to_the_default_order(auth_api, many_bookings):
    """The third click on a header sends no ordering at all; the endpoint's own
    default must then apply rather than an arbitrary database order."""
    body = auth_api.get("/api/v1/bookings/", {"page_size": 100}).json()["results"]
    created = [r["created_at"] for r in body]
    assert created == sorted(created, reverse=True)


def test_search_and_filter_and_sort_combine(auth_api, many_bookings, club):
    body = auth_api.get("/api/v1/bookings/", {
        "club": club.id, "status": "confirmed",
        "ordering": "-scheduled_date", "page_size": 100,
    }).json()
    assert body["count"] > 0
    assert all(r["club"] == club.id and r["status"] == "confirmed"
               for r in body["results"])
    dates = [r["scheduled_date"] for r in body["results"]]
    assert dates == sorted(dates, reverse=True)


def test_the_list_does_not_scale_queries_with_page_size(
        auth_api, many_bookings, django_assert_max_num_queries):
    """select_related/prefetch_related must keep a 25-row page to a fixed number
    of queries rather than one per row."""
    with django_assert_max_num_queries(15):
        auth_api.get("/api/v1/bookings/", {"page_size": 25})


# --------------------------------------------------------------------------- #
# The contract holds across every endpoint the admin lists, not just bookings
# --------------------------------------------------------------------------- #
LIST_ENDPOINTS = [
    ("/api/v1/bookings/", "status"),
    ("/api/v1/customers/", "loyalty_tier"),
    ("/api/v1/auth/users/", "role"),
    ("/api/v1/staff/", "user__role"),
    ("/api/v1/payments/", "status"),
    ("/api/v1/payments/invoices/", "status"),
    ("/api/v1/payments/credit-notes/", "status"),
    ("/api/v1/promotions/", "discount_type"),
    ("/api/v1/auditlogs/", "method"),
    ("/api/v1/notifications/", "channel"),
    ("/api/v1/facilities/categories/", "kind"),
    ("/api/v1/facilities/types/", "is_active"),
    ("/api/v1/facilities/addons/", "is_active"),
    ("/api/v1/facilities/pricing-rules/", "rule_type"),
]


@pytest.mark.parametrize("path,group", LIST_ENDPOINTS)
def test_every_listing_endpoint_supports_the_shared_contract(auth_api, db, path, group):
    """One table component drives all of these, so they must all answer the
    same parameters. A viewset that silently ignores `page_size` or `group_by`
    breaks the toolbar with no error to notice."""
    paged = auth_api.get(path, {"page_size": 25})
    assert paged.status_code == 200, f"{path}: {paged.content[:200]}"
    assert "results" in paged.json()

    grouped = auth_api.get(path, {"group_by": group})
    assert grouped.status_code == 200, f"{path}: {grouped.content[:200]}"
    body = grouped.json()
    assert body["group_by"] == group
    assert "filter_param" in body
    assert isinstance(body["groups"], list)


@pytest.mark.parametrize("path,group", LIST_ENDPOINTS)
def test_every_listing_endpoint_rejects_an_unknown_group(auth_api, db, path, group):
    resp = auth_api.get(path, {"group_by": "definitely-not-a-field"})
    assert resp.status_code == 400


def test_a_boolean_group_is_labelled_as_a_state(auth_api, db, customer):
    """"True" and "False" are Python, not a label an operator should read."""
    body = auth_api.get("/api/v1/customers/", {"group_by": "is_corporate"}).json()
    labels = {g["label"] for g in body["groups"]}
    assert labels <= {"Corporate", "Individual"}
    assert "True" not in labels and "False" not in labels


def test_a_grouped_key_round_trips_as_a_filter(auth_api, db, customer):
    """Whatever `key` a group carries must be usable as the filter value, or
    expanding the group silently returns the wrong rows."""
    body = auth_api.get("/api/v1/customers/", {"group_by": "loyalty_tier"}).json()
    for group in body["groups"]:
        rows = auth_api.get("/api/v1/customers/",
                            {body["filter_param"]: group["key"]}).json()
        assert rows["count"] == group["count"]
