"""Schedule validation and the API surface: overrides, exceptions, permissions.

The validation half matters because organization and club hours previously had
NO validation at all - overlapping or reversed shifts were accepted and then
silently discarded by the slot engine, so a club could look open and offer
nothing.
"""

from datetime import date, timedelta

import pytest

from apps.facilities.models import Facility
from apps.settings_app import schedule as sched
from apps.settings_app.models import Organization, ScheduleException

MONDAY = date(2026, 9, 21)
FRIDAY = MONDAY + timedelta(days=4)


def day(open_t, close_t, breaks=None):
    return {"closed": False, "shifts": [{"open": open_t, "close": close_t}],
            "breaks": breaks or []}


def full_week(**days):
    base = {d: day("08:00", "22:00") for d in sched.DAY_KEYS}
    base.update(days)
    return base


@pytest.fixture
def org(db):
    o = Organization.get_solo()
    o.booking_hours = full_week()
    o.slot_minutes = 60
    o.save()
    return o


@pytest.fixture
def court(db, club, facility_type):
    f = Facility.objects.create(club=club, name="Court 1")
    f.facility_types.set([facility_type])
    return f


# --------------------------------------------------------------------------- #
# 16: validation
# --------------------------------------------------------------------------- #
def test_a_reversed_shift_is_rejected(db):
    # Reversed now MEANS overnight, so it is only invalid when overnight is off.
    with pytest.raises(sched.ScheduleValidationError) as exc:
        sched.validate_week({"mon": day("20:00", "08:00")}, allow_overnight=False)
    assert "mon" in exc.value.message_dict


def test_overlapping_shifts_are_rejected(db):
    with pytest.raises(sched.ScheduleValidationError) as exc:
        sched.validate_week({"mon": {"closed": False, "shifts": [
            {"open": "08:00", "close": "13:00"},
            {"open": "12:00", "close": "18:00"}]}})
    assert "overlap" in str(exc.value.message_dict["mon"]).lower()


def test_duplicate_shifts_are_rejected(db):
    with pytest.raises(sched.ScheduleValidationError) as exc:
        sched.validate_week({"mon": {"closed": False, "shifts": [
            {"open": "08:00", "close": "13:00"},
            {"open": "08:00", "close": "13:00"}]}})
    assert "duplicate" in str(exc.value.message_dict["mon"]).lower()


def test_a_break_outside_the_operating_hours_is_rejected(db):
    with pytest.raises(sched.ScheduleValidationError) as exc:
        sched.validate_week({"mon": day("08:00", "12:00",
                                        breaks=[{"open": "14:00", "close": "15:00"}])})
    assert "inside" in str(exc.value.message_dict["mon"]).lower()


def test_overlapping_breaks_are_rejected(db):
    with pytest.raises(sched.ScheduleValidationError) as exc:
        sched.validate_week({"mon": day("08:00", "20:00", breaks=[
            {"open": "12:00", "close": "14:00"},
            {"open": "13:00", "close": "15:00"}])})
    assert "overlap" in str(exc.value.message_dict["mon"]).lower()


def test_an_unparseable_time_is_rejected(db):
    with pytest.raises(sched.ScheduleValidationError):
        sched.validate_week({"mon": day("nonsense", "12:00")})


def test_an_open_day_with_no_shifts_is_rejected_for_a_venue(db):
    with pytest.raises(sched.ScheduleValidationError) as exc:
        sched.validate_week({"mon": {"closed": False, "shifts": []}})
    assert "mon" in exc.value.message_dict


def test_an_open_day_with_no_shifts_is_simply_off_for_a_roster(db):
    """A roster reads the same document but means something different by it."""
    cleaned = sched.validate_week({"mon": {"closed": False, "shifts": []}},
                                  require_shift_when_open=False)
    assert cleaned["mon"]["closed"] is True


def test_a_24_hour_day_is_accepted_only_on_its_own(db):
    cleaned = sched.validate_week({"mon": day("00:00", "00:00")})
    assert cleaned["mon"]["shifts"] == [{"open": "00:00", "close": "00:00"}]

    with pytest.raises(sched.ScheduleValidationError):
        sched.validate_week({"mon": {"closed": False, "shifts": [
            {"open": "00:00", "close": "00:00"},
            {"open": "10:00", "close": "12:00"}]}})


def test_an_overnight_shift_that_wraps_into_the_morning_shift_is_rejected(db):
    with pytest.raises(sched.ScheduleValidationError) as exc:
        sched.validate_week({"mon": {"closed": False, "shifts": [
            {"open": "06:00", "close": "10:00"},
            {"open": "20:00", "close": "08:00"}]}})     # runs back over 06:00
    assert "mon" in exc.value.message_dict


@pytest.mark.parametrize("value", [0, -30, "abc"])
def test_an_invalid_slot_duration_is_rejected(db, value):
    from rest_framework import serializers as drf
    with pytest.raises(drf.ValidationError):
        sched.validate_slot_minutes(value, allow_blank=False)


def test_a_custom_slot_duration_is_allowed(db):
    assert sched.validate_slot_minutes(35) == 35


def test_a_partial_week_validates_and_stores_only_what_was_sent(db):
    cleaned = sched.validate_partial_week({"fri": day("14:00", "23:00")})
    assert set(cleaned) == {"fri"}


# --------------------------------------------------------------------------- #
# Validation through the API
# --------------------------------------------------------------------------- #
def test_the_organization_rejects_overlapping_hours(auth_api, org):
    resp = auth_api.put("/api/v1/settings/organization/", {
        "booking_hours": full_week(mon={"closed": False, "shifts": [
            {"open": "08:00", "close": "13:00"},
            {"open": "12:00", "close": "18:00"}]}),
    }, format="json")
    assert resp.status_code == 400
    assert "mon" in str(resp.json())


def test_the_organization_requires_a_complete_week(auth_api, org):
    """The base everything falls back to cannot have a day missing."""
    resp = auth_api.put("/api/v1/settings/organization/",
                        {"booking_hours": {"mon": day("08:00", "18:00")}},
                        format="json")
    assert resp.status_code == 400


def test_a_club_may_send_a_partial_override(auth_api, org, club):
    resp = auth_api.patch(f"/api/v1/clubs/{club.id}/",
                          {"booking_hours": {"fri": day("14:00", "23:00")}},
                          format="json")
    assert resp.status_code == 200, resp.content
    club.refresh_from_db()
    assert set(club.booking_hours) == {"fri"}
    assert resp.json()["schedule_source"] == "club"


def test_a_club_override_is_validated_too(auth_api, org, club):
    resp = auth_api.patch(f"/api/v1/clubs/{club.id}/",
                          {"booking_hours": {"fri": day("23:00", "23:00",
                                                        breaks=[{"open": "01:00",
                                                                 "close": "02:00"}])}},
                          format="json")
    assert resp.status_code == 400


def test_clearing_a_club_override_restores_inheritance(auth_api, org, club):
    club.booking_hours = {"fri": day("14:00", "23:00")}
    club.save()
    resp = auth_api.patch(f"/api/v1/clubs/{club.id}/", {"booking_hours": {}},
                          format="json")
    assert resp.status_code == 200
    assert resp.json()["schedule_source"] == "organization"


def test_a_facility_may_override_a_single_day(auth_api, org, club, court):
    resp = auth_api.patch(f"/api/v1/facilities/{court.id}/",
                          {"booking_hours": {"fri": day("15:00", "23:00")}},
                          format="json")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["schedule_source"] == "facility"
    assert body["effective_schedule"]["fri"]["source"] == "facility"
    assert body["effective_schedule"]["mon"]["source"] == "organization"


# --------------------------------------------------------------------------- #
# Effective schedule endpoint
# --------------------------------------------------------------------------- #
def test_the_effective_endpoint_reports_the_organization_week(auth_api, org):
    body = auth_api.get("/api/v1/settings/schedule/effective/").json()
    assert body["scope"] == "organization"
    assert body["parent"] is None
    assert body["week"]["mon"]["shifts"] == [{"open": "08:00", "close": "22:00"}]


def test_the_effective_endpoint_tags_each_day_with_its_source(auth_api, org, club, court):
    club.booking_hours = {"mon": day("09:00", "23:00")}
    club.save()
    court.booking_hours = {"fri": day("15:00", "23:00")}
    court.save()

    body = auth_api.get(f"/api/v1/settings/schedule/effective/?facility={court.id}").json()
    assert body["scope"] == "facility"
    assert body["parent"] == "club"
    assert body["parent_label"] == club.name
    assert body["week"]["mon"]["source"] == "club"
    assert body["week"]["fri"]["source"] == "facility"
    assert body["week"]["tue"]["source"] == "organization"


def test_the_effective_endpoint_reports_the_resolved_slot_interval(auth_api, org,
                                                                   club, court):
    court.slot_minutes = 15
    court.save()
    body = auth_api.get(f"/api/v1/settings/schedule/effective/?facility={court.id}").json()
    assert body["slot_minutes"] == 15
    assert body["slot_minutes_source"] == "facility"


def test_the_effective_endpoint_requires_authentication(api):
    assert api.get("/api/v1/settings/schedule/effective/").status_code == 401


# --------------------------------------------------------------------------- #
# Exceptions through the API
# --------------------------------------------------------------------------- #
def test_an_exception_can_be_created_and_listed(auth_api, org, club):
    resp = auth_api.post("/api/v1/settings/schedule-exceptions/", {
        "name": "National Day", "club": club.id,
        "start_date": MONDAY.isoformat(), "closed": True,
    }, format="json")
    assert resp.status_code == 201, resp.content
    assert resp.json()["scope"] == "club"
    assert resp.json()["scope_label"] == club.name

    listed = auth_api.get("/api/v1/settings/schedule-exceptions/").json()
    assert listed["count"] == 1


def test_an_exception_with_custom_hours_is_validated(auth_api, org, club):
    resp = auth_api.post("/api/v1/settings/schedule-exceptions/", {
        "name": "Ramadan hours", "club": club.id,
        "start_date": MONDAY.isoformat(), "end_date": FRIDAY.isoformat(),
        "closed": False, "shifts": [{"open": "16:00", "close": "02:00"}],
    }, format="json")
    assert resp.status_code == 201, resp.content
    assert resp.json()["shifts"] == [{"open": "16:00", "close": "02:00"}]


def test_an_open_exception_without_hours_is_rejected(auth_api, org, club):
    resp = auth_api.post("/api/v1/settings/schedule-exceptions/", {
        "name": "Half day", "club": club.id,
        "start_date": MONDAY.isoformat(), "closed": False, "shifts": [],
    }, format="json")
    assert resp.status_code == 400
    assert "shifts" in resp.json()


def test_an_end_date_before_the_start_is_rejected(auth_api, org, club):
    resp = auth_api.post("/api/v1/settings/schedule-exceptions/", {
        "name": "Backwards", "club": club.id,
        "start_date": FRIDAY.isoformat(), "end_date": MONDAY.isoformat(),
        "closed": True,
    }, format="json")
    assert resp.status_code == 400
    assert "end_date" in resp.json()


def test_both_a_club_and_a_facility_cannot_be_set(auth_api, org, club, court):
    resp = auth_api.post("/api/v1/settings/schedule-exceptions/", {
        "name": "Confused scope", "club": club.id, "facility": court.id,
        "start_date": MONDAY.isoformat(), "closed": True,
    }, format="json")
    assert resp.status_code == 400


# --------------------------------------------------------------------------- #
# 29: permissions, enforced on the server
# --------------------------------------------------------------------------- #
@pytest.fixture
def club_manager(db, club, make_user):
    from rest_framework.test import APIClient
    from apps.accounts.models import Role

    user = make_user("manager@riversideclub.ae", role=Role.CLUB_ADMIN)
    user.assigned_clubs.set([club])
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_a_club_manager_cannot_create_an_organization_wide_closure(club_manager, org):
    resp = club_manager.post("/api/v1/settings/schedule-exceptions/", {
        "name": "Everything shut", "start_date": MONDAY.isoformat(), "closed": True,
    }, format="json")
    assert resp.status_code == 403


def test_a_club_manager_cannot_touch_another_club(club_manager, org, db):
    from apps.clubs.models import Club

    other = Club.objects.create(code="north", name="Northside")
    resp = club_manager.post("/api/v1/settings/schedule-exceptions/", {
        "name": "Not mine", "club": other.id,
        "start_date": MONDAY.isoformat(), "closed": True,
    }, format="json")
    assert resp.status_code == 403


def test_a_club_manager_only_lists_rows_that_apply_to_them(club_manager, org, club, db):
    from apps.clubs.models import Club

    other = Club.objects.create(code="north", name="Northside")
    ScheduleException.objects.create(name="Mine", club=club, start_date=MONDAY)
    ScheduleException.objects.create(name="Theirs", club=other, start_date=MONDAY)
    ScheduleException.objects.create(name="Everyone", start_date=MONDAY)

    names = {r["name"] for r in club_manager.get(
        "/api/v1/settings/schedule-exceptions/").json()["results"]}
    assert names == {"Mine", "Everyone"}


def test_exceptions_require_authentication(api):
    assert api.get("/api/v1/settings/schedule-exceptions/").status_code == 401


# --------------------------------------------------------------------------- #
# 27: existing bookings are protected, never silently destroyed
# --------------------------------------------------------------------------- #
def test_narrowing_the_hours_reports_the_bookings_it_would_orphan(
        auth_api, org, club, court, booking_on):
    booking = booking_on(on_date=MONDAY, at_time=__import__("datetime").time(9, 0))
    club.booking_hours = {"mon": day("14:00", "22:00")}      # 09:00 now outside
    club.save()

    body = auth_api.get(f"/api/v1/settings/schedule/impact/?club={club.id}"
                        f"&from={MONDAY.isoformat()}&to={MONDAY.isoformat()}").json()
    assert body["count"] == 1
    assert body["bookings"][0]["reference"] == booking.reference
    assert body["bookings"][0]["reason"] == "outside hours"


def test_a_closure_reports_every_booking_on_that_date(auth_api, org, club, court,
                                                      booking_on):
    booking_on(on_date=MONDAY, at_time=__import__("datetime").time(9, 0))
    ScheduleException.objects.create(name="Closed", club=club,
                                     start_date=MONDAY, closed=True)
    body = auth_api.get(f"/api/v1/settings/schedule/impact/?club={club.id}"
                        f"&from={MONDAY.isoformat()}&to={MONDAY.isoformat()}").json()
    assert body["count"] == 1
    assert body["bookings"][0]["reason"] == "closed"


def test_a_booking_still_inside_the_hours_is_not_reported(auth_api, org, club, court,
                                                          booking_on):
    booking_on(on_date=MONDAY, at_time=__import__("datetime").time(9, 0))
    body = auth_api.get(f"/api/v1/settings/schedule/impact/?club={club.id}"
                        f"&from={MONDAY.isoformat()}&to={MONDAY.isoformat()}").json()
    assert body["count"] == 0


def test_reporting_never_modifies_the_booking(auth_api, org, club, court, booking_on):
    booking = booking_on(on_date=MONDAY, at_time=__import__("datetime").time(9, 0))
    ScheduleException.objects.create(name="Closed", club=club,
                                     start_date=MONDAY, closed=True)
    auth_api.get(f"/api/v1/settings/schedule/impact/?club={club.id}")
    booking.refresh_from_db()
    assert booking.status != "cancelled"


# --------------------------------------------------------------------------- #
# 26: auditability
# --------------------------------------------------------------------------- #
def test_creating_an_exception_is_audited(auth_api, org, club, db):
    """The event name lives in `payload_summary`, alongside enough detail to
    read the change without opening the row."""
    from apps.auditlogs.models import AuditLog

    auth_api.post("/api/v1/settings/schedule-exceptions/", {
        "name": "National Day", "club": club.id,
        "start_date": MONDAY.isoformat(), "closed": True,
    }, format="json")
    entry = AuditLog.objects.filter(
        payload_summary__event="schedule_exception_created").first()
    assert entry is not None
    assert entry.payload_summary["name"] == "National Day"
    assert entry.payload_summary["scope"] == "club"
    assert entry.subject_type == "schedule_exception"
