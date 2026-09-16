"""Facility catalogue: model shape, API surface and the pricing engine."""

from datetime import date
from decimal import Decimal

import pytest

from apps.facilities.models import (
    AddOn,
    Facility,
    FacilityCategory,
    FacilityKind,
    FacilityType,
    PricingAdjustmentType,
    PricingRule,
    PricingRuleType,
)
from apps.facilities.pricing import apply_adjustment, calculate_price


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
def test_facility_is_unique_per_club(db, club):
    Facility.objects.create(club=club, name="Court 1")
    with pytest.raises(Exception):
        Facility.objects.create(club=club, name="Court 1")


def test_same_facility_name_allowed_at_another_club(db, club):
    from apps.clubs.models import Club
    other = Club.objects.create(code="north", name="Northside")
    Facility.objects.create(club=club, name="Court 1")
    Facility.objects.create(club=other, name="Court 1")      # no clash across clubs
    assert Facility.objects.filter(name="Court 1").count() == 2


def test_facility_type_belongs_to_categories(db, facility_type, facility_category):
    assert list(facility_type.categories.all()) == [facility_category]
    assert list(facility_category.facility_types.all()) == [facility_type]


def test_facility_category_kind_choices_are_domain_neutral():
    values = set(FacilityKind.values)
    assert values == {
        "outdoor_court", "indoor_court", "pitch", "aquatic",
        "hall", "meeting_room", "other",
    }


# --------------------------------------------------------------------------- #
# Pricing engine
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("adj_type,value,expected", [
    (PricingAdjustmentType.FIXED_INCREASE, 10, 110),
    (PricingAdjustmentType.FIXED_DISCOUNT, 10, 90),
    (PricingAdjustmentType.PERCENT_INCREASE, 10, 110),
    (PricingAdjustmentType.PERCENT_DISCOUNT, 10, 90),
    (PricingAdjustmentType.OVERRIDE, 42, 42),
])
def test_apply_adjustment(adj_type, value, expected):
    new_price, _delta = apply_adjustment(100, adj_type, value)
    assert Decimal(new_price) == Decimal(expected)


def test_calculate_price_with_no_rules_is_a_passthrough(db):
    result = calculate_price(Decimal("100"))
    assert Decimal(str(result["final_price"])) == Decimal("100")
    assert result["applied_rules"] == []


def test_club_scoped_rule_only_applies_to_that_club(db, club, facility_type):
    from apps.clubs.models import Club
    other = Club.objects.create(code="north", name="Northside")
    rule = PricingRule.objects.create(
        name="Riverside surcharge", code="RIVER10",
        rule_type=PricingRuleType.CLUB,
        adjustment_type=PricingAdjustmentType.PERCENT_INCREASE,
        adjustment_value=Decimal("10"),
    )
    rule.clubs.set([club])

    hit = calculate_price(Decimal("100"), club_id=club.id)
    miss = calculate_price(Decimal("100"), club_id=other.id)

    assert Decimal(str(hit["final_price"])) == Decimal("110")
    assert Decimal(str(miss["final_price"])) == Decimal("100")


def test_weekend_rule_matches_only_its_days(db):
    rule = PricingRule.objects.create(
        name="Weekend", code="WKND",
        rule_type=PricingRuleType.WEEKEND,
        adjustment_type=PricingAdjustmentType.PERCENT_INCREASE,
        adjustment_value=Decimal("20"),
        days_of_week=[5, 6],                       # Sat, Sun
    )
    assert rule.days_of_week == [5, 6]
    saturday = date(2026, 6, 6)                    # weekday() == 5
    thursday = date(2026, 6, 4)                    # weekday() == 3

    on = calculate_price(Decimal("100"), booking_date=saturday)
    off = calculate_price(Decimal("100"), booking_date=thursday)

    assert Decimal(str(on["final_price"])) == Decimal("120")
    assert Decimal(str(off["final_price"])) == Decimal("100")


def test_allow_stacking_false_stops_the_chain(db):
    PricingRule.objects.create(
        name="First", code="ONE", priority=1,
        rule_type=PricingRuleType.CUSTOM,
        adjustment_type=PricingAdjustmentType.PERCENT_INCREASE,
        adjustment_value=Decimal("10"), allow_stacking=False,
    )
    PricingRule.objects.create(
        name="Second", code="TWO", priority=2,
        rule_type=PricingRuleType.CUSTOM,
        adjustment_type=PricingAdjustmentType.PERCENT_INCREASE,
        adjustment_value=Decimal("10"),
    )
    result = calculate_price(Decimal("100"))
    assert Decimal(str(result["final_price"])) == Decimal("110")   # not 121
    assert len(result["applied_rules"]) == 1


def test_price_never_goes_negative(db):
    PricingRule.objects.create(
        name="Huge discount", code="HUGE",
        rule_type=PricingRuleType.CUSTOM,
        adjustment_type=PricingAdjustmentType.FIXED_DISCOUNT,
        adjustment_value=Decimal("500"),
    )
    result = calculate_price(Decimal("100"))
    assert Decimal(str(result["final_price"])) == Decimal("0")


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
def test_catalogue_endpoints_require_authentication(api):
    for path in ("/api/v1/facilities/", "/api/v1/facilities/categories/",
                 "/api/v1/facilities/types/", "/api/v1/facilities/addons/"):
        assert api.get(path).status_code == 401, path


def test_admin_can_list_facility_types(auth_api, facility_type):
    resp = auth_api.get("/api/v1/facilities/types/")
    assert resp.status_code == 200
    names = [r["name"] for r in resp.json()["results"]]
    assert "Tennis Court" in names


def test_facility_type_create_requires_a_category(auth_api):
    resp = auth_api.post("/api/v1/facilities/types/", {
        "name": "Padel Court", "categories": [], "price": "80.00",
    }, format="json")
    assert resp.status_code == 400
    assert "categories" in resp.json()


def test_facility_type_create_round_trip(auth_api, facility_category):
    resp = auth_api.post("/api/v1/facilities/types/", {
        "name": "Padel Court", "categories": [facility_category.id],
        "price": "80.00", "duration_minutes": 60,
    }, format="json")
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["name"] == "Padel Court"
    assert body["category_names"] == ["Racket Sports"]


def test_facility_list_is_scoped_to_the_club_filter(auth_api, club, facilities):
    from apps.clubs.models import Club
    other = Club.objects.create(code="north", name="Northside")
    Facility.objects.create(club=other, name="Pitch 1")

    resp = auth_api.get(f"/api/v1/facilities/?club={club.id}")
    assert resp.status_code == 200
    assert {r["name"] for r in resp.json()["results"]} == {"Court 1", "Court 2", "Court 3"}


def test_addon_blank_code_is_stored_as_null(auth_api):
    resp = auth_api.post("/api/v1/facilities/addons/",
                         {"name": "Racket hire", "code": "", "price": "15.00"}, format="json")
    assert resp.status_code == 201, resp.content
    assert AddOn.objects.get(name="Racket hire").code is None


def test_pricing_rule_requires_a_validity_window(auth_api):
    resp = auth_api.post("/api/v1/facilities/pricing-rules/", {
        "name": "No dates", "code": "NODATES",
        "rule_type": "custom", "adjustment_type": "percent_discount",
        "adjustment_value": "10", "days_of_week": [5],
    }, format="json")
    assert resp.status_code == 400
    assert "valid_from" in resp.json()


def test_category_slug_is_derived_from_the_name(auth_api):
    resp = auth_api.post("/api/v1/facilities/categories/",
                         {"name": "Indoor Spaces", "kind": "hall"}, format="json")
    assert resp.status_code == 201, resp.content
    assert FacilityCategory.objects.get(name="Indoor Spaces").slug == "indoor-spaces"
