"""Bookings: the slot/availability engine, pricing snapshot and lifecycle."""

from datetime import date, time, timedelta
from decimal import Decimal

import pytest

from apps.bookings.models import (
    ACTIVE_STATUSES,
    Booking,
    BookingStatus,
    BookingType,
    generate_reference,
)
from apps.bookings.services import (
    _capacity_for,
    available_slots,
    can_transition,
    public_availability,
    slot_is_available,
    transition_booking,
)

# 2026-06-04 is a Thursday; 2026-06-06 a Saturday.
THURSDAY = date(2026, 6, 4)


@pytest.fixture
def org(db):
    from apps.settings_app.models import Organization
    return Organization.get_solo()


# --------------------------------------------------------------------------- #
# Reference + model shape
# --------------------------------------------------------------------------- #
def test_reference_uses_the_neutral_booking_prefix():
    ref = generate_reference()
    assert ref.startswith("BK-")
    assert len(ref) == 9


def test_booking_gets_a_unique_reference_on_save(booking_on):
    a, b = booking_on(), booking_on(at_time=time(12, 0))
    assert a.reference and b.reference and a.reference != b.reference


def test_booking_has_no_vehicle_or_channel_fields():
    field_names = {f.name for f in Booking._meta.get_fields()}
    assert not field_names & {"vehicle", "channel", "bay", "site", "address",  # legacy-term-guard: allow
                              "walk_in_vehicle", "walk_in_vehicle_category"}
    assert {"club", "facility", "facility_type", "facility_category"} <= field_names


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def test_booking_needs_exactly_one_bookable_target(db, customer, club, facility_type,
                                                   facility_category):
    from django.core.exceptions import ValidationError

    both = Booking(customer=customer, club=club, facility_type=facility_type,
                   facility_category=facility_category,
                   scheduled_date=THURSDAY, scheduled_time=time(10, 0))
    with pytest.raises(ValidationError):
        both.clean()

    neither = Booking(customer=customer, club=club,
                      scheduled_date=THURSDAY, scheduled_time=time(10, 0))
    with pytest.raises(ValidationError):
        neither.clean()


def test_non_walk_in_booking_needs_a_customer(db, club, facility_type):
    from django.core.exceptions import ValidationError
    b = Booking(club=club, facility_type=facility_type,
                scheduled_date=THURSDAY, scheduled_time=time(10, 0))
    with pytest.raises(ValidationError):
        b.clean()


def test_walk_in_booking_may_omit_the_customer(db, club, facility_type):
    b = Booking(club=club, facility_type=facility_type,
                booking_type=BookingType.WALK_IN, walk_in_name="Guest",
                scheduled_date=THURSDAY, scheduled_time=time(10, 0))
    b.clean()                                    # must not raise


def test_facility_must_belong_to_the_booking_club(db, customer, club, facility_type):
    from django.core.exceptions import ValidationError
    from apps.clubs.models import Club
    from apps.facilities.models import Facility

    other = Club.objects.create(code="north", name="Northside")
    foreign = Facility.objects.create(club=other, name="Pitch 1")

    b = Booking(customer=customer, club=club, facility_type=facility_type,
                facility=foreign, scheduled_date=THURSDAY, scheduled_time=time(10, 0))
    with pytest.raises(ValidationError):
        b.clean()


# --------------------------------------------------------------------------- #
# Capacity + availability
# --------------------------------------------------------------------------- #
def test_capacity_is_the_club_active_facility_count(db, club, facilities):
    assert _capacity_for(club=club) == 3


def test_inactive_facilities_do_not_count(db, club, facilities):
    facilities[0].is_active = False
    facilities[0].save()
    assert _capacity_for(club=club) == 2


def test_a_club_with_no_facilities_has_no_capacity(db, club):
    assert _capacity_for(club=club) == 0


def test_capacity_is_scoped_per_club(db, club, facilities):
    from apps.clubs.models import Club
    from apps.facilities.models import Facility
    other = Club.objects.create(code="north", name="Northside")
    Facility.objects.create(club=other, name="Pitch 1")

    assert _capacity_for(club=club) == 3
    assert _capacity_for(club=other) == 1
    assert _capacity_for() == 4                  # organisation-wide


def test_available_slots_follow_the_org_schedule(db, org, club, facilities):
    org.slot_minutes = 120
    org.booking_hours = {**(org.booking_hours or {}),
                         "thu": {"closed": False, "shifts": [{"open": "09:00", "close": "13:00"}]}}
    org.save()
    assert [s["time"] for s in available_slots(THURSDAY, club=club)] == ["09:00", "11:00"]


def test_club_hours_override_the_org_default(db, org, club, facilities):
    org.slot_minutes = 60
    org.booking_hours = {**(org.booking_hours or {}),
                         "thu": {"closed": False, "shifts": [{"open": "08:00", "close": "10:00"}]}}
    org.save()
    club.booking_hours = {"thu": {"closed": False, "shifts": [{"open": "14:00", "close": "16:00"}]}}
    club.save()
    assert [s["time"] for s in available_slots(THURSDAY, club=club)] == ["14:00", "15:00"]


def test_multiple_shifts_are_merged_and_sorted(db, org, club, facilities):
    org.slot_minutes = 60
    org.booking_hours = {**(org.booking_hours or {}), "thu": {"closed": False, "shifts": [
        {"open": "08:00", "close": "10:00"}, {"open": "14:00", "close": "16:00"}]}}
    org.save()
    assert [s["time"] for s in available_slots(THURSDAY, club=club)] == \
        ["08:00", "09:00", "14:00", "15:00"]


def test_a_closed_weekday_offers_no_slots(db, org, club, facilities):
    org.booking_hours = {**(org.booking_hours or {}), "thu": {"closed": True}}
    org.save()
    assert available_slots(THURSDAY, club=club) == []


def test_booked_slots_reduce_remaining_availability(db, org, club, facilities, booking_on):
    org.slot_minutes = 60
    org.booking_hours = {**(org.booking_hours or {}),
                         "thu": {"closed": False, "shifts": [{"open": "09:00", "close": "11:00"}]}}
    org.save()
    booking_on(on_date=THURSDAY, at_time=time(9, 0))

    slots = {s["time"]: s for s in available_slots(THURSDAY, club=club)}
    assert slots["09:00"]["booked"] == 1
    assert slots["09:00"]["available"] == 2      # 3 courts - 1 taken
    assert slots["10:00"]["available"] == 3


def test_slot_is_unavailable_once_capacity_is_full(db, club, facilities, booking_on):
    for _ in range(3):
        booking_on(on_date=THURSDAY, at_time=time(9, 0))
    assert slot_is_available(THURSDAY, time(9, 0), club=club) is False
    assert slot_is_available(THURSDAY, time(10, 0), club=club) is True


def test_cancelled_bookings_release_their_slot(db, club, facilities, booking_on):
    made = [booking_on(on_date=THURSDAY, at_time=time(9, 0)) for _ in range(3)]
    assert slot_is_available(THURSDAY, time(9, 0), club=club) is False
    made[0].status = BookingStatus.CANCELLED
    made[0].save()
    assert slot_is_available(THURSDAY, time(9, 0), club=club) is True


def test_public_availability_shape_has_no_legacy_keys(db, org, club, facilities):
    payload = public_availability(THURSDAY, club=club)
    assert set(payload) == {"date", "closed", "slot_minutes", "time_format_24h",
                            "timezone", "weekdays", "slots", "exception", "breaks"}
    assert "heat_window" not in payload
    assert "channel" not in payload


# --------------------------------------------------------------------------- #
# Pricing snapshot
# --------------------------------------------------------------------------- #
def test_price_comes_from_the_facility_type(db, booking_on, facility_type):
    b = booking_on()
    assert b.base_amount == Decimal("60.000")


def test_tax_is_added_on_top_when_exclusive(db, tax_rate, booking_on):
    b = booking_on()
    assert b.tax_amount == Decimal("3.000")      # 5% of 60
    assert b.total_amount == Decimal("63.000")


def test_facility_type_discount_reduces_the_base(db, facility_type, booking_on):
    facility_type.discount_percent = Decimal("10")
    facility_type.save()
    b = booking_on()
    assert b.discount_amount == Decimal("6.000")


def test_duration_comes_from_the_facility_type(db, facility_type, booking_on):
    facility_type.duration_minutes = 90
    facility_type.save()
    b = booking_on()
    assert b.duration_minutes == 90


def test_category_booking_prices_from_the_category(db, customer, club, facility_category):
    b = Booking(customer=customer, club=club, facility_category=facility_category,
                scheduled_date=THURSDAY, scheduled_time=time(10, 0))
    b.save()
    b.compute_pricing()
    assert b.base_amount == Decimal("60.000")


# --------------------------------------------------------------------------- #
# Lifecycle
# --------------------------------------------------------------------------- #
def test_quality_check_status_is_gone():
    assert "qc" not in BookingStatus.values


def test_active_statuses_hold_a_slot():
    assert BookingStatus.BOOKED in ACTIVE_STATUSES
    assert BookingStatus.CANCELLED not in ACTIVE_STATUSES
    assert BookingStatus.COMPLETED not in ACTIVE_STATUSES


@pytest.mark.parametrize("current,target,allowed", [
    (BookingStatus.BOOKED, BookingStatus.CONFIRMED, True),
    (BookingStatus.BOOKED, BookingStatus.COMPLETED, False),
    (BookingStatus.CONFIRMED, BookingStatus.ASSIGNED, True),
    (BookingStatus.ASSIGNED, BookingStatus.IN_PROGRESS, True),
    (BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED, True),
    (BookingStatus.COMPLETED, BookingStatus.CLOSED, True),
    (BookingStatus.CLOSED, BookingStatus.CONFIRMED, False),
])
def test_status_transitions(current, target, allowed):
    assert can_transition(current, target) is allowed


def test_illegal_transition_is_rejected(db, booking_on):
    b = booking_on()
    with pytest.raises(ValueError):
        transition_booking(b, BookingStatus.CLOSED)


def test_confirming_a_booking_records_history(db, booking_on, admin_user):
    b = booking_on()
    transition_booking(b, BookingStatus.CONFIRMED, actor=admin_user)
    b.refresh_from_db()
    assert b.status == BookingStatus.CONFIRMED
    assert b.status_history.filter(to_status=BookingStatus.CONFIRMED).exists()


def test_completion_is_blocked_while_money_is_outstanding(db, tax_rate, booking_on, admin_user):
    b = booking_on()
    transition_booking(b, BookingStatus.CONFIRMED, actor=admin_user)
    transition_booking(b, BookingStatus.ASSIGNED, actor=admin_user)
    transition_booking(b, BookingStatus.IN_PROGRESS, actor=admin_user)
    with pytest.raises(ValueError, match="payment"):
        transition_booking(b, BookingStatus.COMPLETED, actor=admin_user)


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
def test_bookings_endpoint_requires_authentication(api):
    assert api.get("/api/v1/bookings/").status_code == 401


def test_availability_endpoint_returns_slots(auth_api, club, facilities):
    on_date = (date.today() + timedelta(days=2)).isoformat()
    resp = auth_api.get(f"/api/v1/bookings/availability/?club={club.id}&date={on_date}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["club"] == club.id and body["date"] == on_date
    assert all({"time", "capacity", "booked", "available"} <= set(s) for s in body["slots"])


def test_create_booking_through_the_api(auth_api, customer, club, facility_type, facilities):
    on_date = (date.today() + timedelta(days=2)).isoformat()
    resp = auth_api.post("/api/v1/bookings/", {
        "customer": customer.id, "club": club.id, "facility_type": facility_type.id,
        "scheduled_date": on_date, "scheduled_time": "10:00",
    }, format="json")
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["reference"].startswith("BK-")
    assert body["facility_type_name"] == "Tennis Court"
    assert body["club_name"] == "Riverside Club"


def test_booking_api_rejects_two_targets(auth_api, customer, club, facility_type,
                                         facility_category):
    on_date = (date.today() + timedelta(days=2)).isoformat()
    resp = auth_api.post("/api/v1/bookings/", {
        "customer": customer.id, "club": club.id,
        "facility_type": facility_type.id, "facility_category": facility_category.id,
        "scheduled_date": on_date, "scheduled_time": "10:00",
    }, format="json")
    assert resp.status_code == 400


def test_price_preview_does_not_persist_a_booking(auth_api, tax_rate, customer, club,
                                                  facility_type):
    before = Booking.objects.count()
    resp = auth_api.post("/api/v1/bookings/price-preview/", {
        "facility_type": facility_type.id, "customer": customer.id, "club": club.id,
    }, format="json")
    assert resp.status_code == 200, resp.content
    assert Decimal(resp.json()["final_amount"]) == Decimal("63.000")
    assert Booking.objects.count() == before
