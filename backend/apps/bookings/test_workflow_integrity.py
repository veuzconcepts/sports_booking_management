"""The invariants that make this one booking system rather than several.

Availability, pricing and the rest are tested in their own files. What is
pinned here is that every ENTRY POINT obeys them: the admin API, the public
website and the multi-slot order path must refuse the same booking for the
same reason, and nothing bolted on beside them (a promo, an offer, an add-on)
may quietly create a slot that the schedule does not have.

The concurrency half of this lives in `test_booking_concurrency.py`, which
needs real threads and a real commit.
"""

from datetime import date, time, timedelta
from decimal import Decimal

import pytest
from django.core.cache import cache

from apps.bookings import availability_cache
from apps.bookings.models import (
    ACTIVE_STATUSES, SLOT_BLOCKING_STATUSES, Booking, BookingStatus,
)

pytestmark = pytest.mark.django_db

ADMIN = "/api/v1/bookings/"
PUBLIC = "/api/v1/website/public/bookings/"


def _open_all_week(open_at="08:00", close_at="22:00"):
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": open_at, "close": close_at}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture(autouse=True)
def _fresh_cache():
    cache.clear()
    availability_cache.invalidate()


@pytest.fixture
def venue(db, tax_rate):
    """One club, one activity, ONE court, so every clash is unambiguous."""
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.save()

    club = Club.objects.create(name="Integrity Club", code="INTG", is_active=True,
                               booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Padel Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Court 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customers = [
        Customer.objects.create(full_name=f"Player {i}", email=f"i{i}@integrity.test",
                                mobile_number=f"+96652000{i:04d}")
        for i in range(3)
    ]
    return {"club": club, "activity": activity, "court": court,
            "customers": customers}


def soon(days=6):
    from django.utils import timezone
    return timezone.localdate() + timedelta(days=days)


def admin_payload(venue, customer, at="19:00", on=None):
    return {
        "customer": customer.id, "club": venue["club"].id,
        "facility_type": venue["activity"].id,
        "scheduled_date": (on or soon()).isoformat(), "scheduled_time": at,
    }


def public_payload(venue, at="19:00", on=None, **extra):
    return {
        "club": venue["club"].id, "facility_type": venue["activity"].id,
        "date": (on or soon()).isoformat(), "time": at,
        "name": "Web Customer", "email": "web@integrity.test",
        "phone": "+966520009999", **extra,
    }


# --------------------------------------------------------------------------- #
# Section 7: one definition of "this slot is taken"
# --------------------------------------------------------------------------- #
def test_the_database_constraint_blocks_exactly_the_active_statuses():
    """The index and the engine must agree on which bookings hold a slot.

    The constraint spells its statuses out as strings in a migration, because
    an index cannot import a Python set. That makes it the one place that can
    silently drift from `ACTIVE_STATUSES`: add a status to the set and the
    database quietly stops protecting it.
    """
    constraint = next(
        c for c in Booking._meta.constraints
        if c.name == "unique_live_booking_per_facility_slot")
    # Pull the status list back out of the constraint's condition.
    in_clause = constraint.condition.children[0]
    assert set(in_clause[1]) == {s.value for s in SLOT_BLOCKING_STATUSES}, (
        "the unique index and SLOT_BLOCKING_STATUSES disagree about which "
        "bookings occupy a slot")


# --------------------------------------------------------------------------- #
# Sections 10 and 11: the admin is not a way round the rules
# --------------------------------------------------------------------------- #
class TestAdminCannotBypass:
    def test_admin_cannot_book_a_slot_that_is_already_taken(self, auth_api, venue):
        first = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0]),
                              format="json")
        assert first.status_code == 201, first.content
        second = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][1]),
                               format="json")
        assert second.status_code == 400, second.content
        assert "scheduled_time" in second.json()
        assert Booking.objects.filter(status__in=ACTIVE_STATUSES).count() == 1

    def test_admin_cannot_book_a_court_that_is_out_for_maintenance(self, auth_api, venue):
        from apps.facilities.models import MaintenanceBlock
        day = soon()
        MaintenanceBlock.objects.create(facility=venue["court"], start_date=day,
                                        end_date=day, reason="Resurfacing")
        resp = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0], on=day),
                             format="json")
        assert resp.status_code == 400, resp.content

    def test_admin_cannot_book_a_closed_day(self, auth_api, venue):
        from apps.settings_app.models import ScheduleException
        day = soon()
        ScheduleException.objects.create(
            name="Eid", club=venue["club"], start_date=day, end_date=day,
            closed=True, is_active=True)
        resp = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0], on=day),
                             format="json")
        assert resp.status_code == 400, resp.content

    def test_admin_cannot_book_outside_business_hours(self, auth_api, venue):
        resp = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0], at="03:00"),
                             format="json")
        assert resp.status_code == 400, resp.content

    def test_admin_cannot_pin_a_court_from_another_club(self, auth_api, venue):
        """Section 45: a facility id from the wrong club is refused server-side."""
        from apps.clubs.models import Club
        from apps.facilities.models import Facility
        other = Club.objects.create(name="Elsewhere", code="ELSE2", is_active=True,
                                    booking_hours=_open_all_week())
        stranger = Facility.objects.create(name="Far Court", club=other, is_active=True)
        stranger.facility_types.add(venue["activity"])
        payload = {**admin_payload(venue, venue["customers"][0]),
                   "facility": stranger.id}
        resp = auth_api.post(ADMIN, payload, format="json")
        assert resp.status_code == 400, resp.content
        assert "facility" in resp.json()

    def test_a_double_clicked_admin_form_creates_one_booking(self, auth_api, venue):
        """Section 11: the second identical submit must not land."""
        payload = admin_payload(venue, venue["customers"][0])
        first = auth_api.post(ADMIN, payload, format="json")
        second = auth_api.post(ADMIN, payload, format="json")
        assert first.status_code == 201
        assert second.status_code == 400, second.content
        assert Booking.objects.filter(status__in=ACTIVE_STATUSES).count() == 1


# --------------------------------------------------------------------------- #
# Section 12: the website obeys the same answers
# --------------------------------------------------------------------------- #
class TestWebsiteAndAdminAgree:
    def test_the_website_cannot_take_a_slot_the_admin_booked(self, api, auth_api, venue):
        assert auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0]),
                             format="json").status_code == 201
        resp = api.post(PUBLIC, public_payload(venue), format="json")
        assert resp.status_code == 409, resp.content

    def test_the_admin_cannot_take_a_slot_the_website_booked(self, api, auth_api, venue):
        assert api.post(PUBLIC, public_payload(venue), format="json").status_code == 201
        resp = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0]),
                             format="json")
        assert resp.status_code == 400, resp.content

    def test_both_refuse_a_closed_day(self, api, auth_api, venue):
        from apps.settings_app.models import ScheduleException
        day = soon()
        ScheduleException.objects.create(
            name="National Day", club=venue["club"], start_date=day, end_date=day,
            closed=True, is_active=True)
        assert api.post(PUBLIC, public_payload(venue, on=day),
                        format="json").status_code in (400, 409)
        assert auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0], on=day),
                             format="json").status_code == 400


# --------------------------------------------------------------------------- #
# Sections 8, 17, 18, 21: nothing bolted on the side creates a slot
# --------------------------------------------------------------------------- #
class TestNothingElseCreatesAvailability:
    def _fill(self, auth_api, venue, at="19:00"):
        resp = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0], at=at),
                             format="json")
        assert resp.status_code == 201, resp.content

    def test_a_promo_code_cannot_unlock_a_taken_slot(self, api, auth_api, venue):
        from apps.promotions.models import PromoCode
        PromoCode.objects.create(
            code="OPENSESAME", is_active=True, discount_type="percent",
            discount_value=Decimal("50"), valid_from=soon(-1), valid_to=soon(30))
        self._fill(auth_api, venue)
        resp = api.post(PUBLIC, public_payload(venue, coupon="OPENSESAME"),
                        format="json")
        assert resp.status_code == 409, resp.content

    def test_an_offer_cannot_unlock_a_taken_slot(self, api, auth_api, venue):
        from apps.facilities.models import (
            PricingAdjustmentType, PricingRule, PricingRuleType,
        )
        rule = PricingRule.objects.create(
            name="Half price", code="half-price", is_active=True,
            rule_type=PricingRuleType.DATE_RANGE,
            adjustment_type=PricingAdjustmentType.PERCENT_DISCOUNT,
            adjustment_value=Decimal("50"), valid_from=soon(-1), valid_to=soon(30))
        rule.clubs.add(venue["club"])
        self._fill(auth_api, venue)
        assert api.post(PUBLIC, public_payload(venue),
                        format="json").status_code == 409

    def test_add_ons_cannot_unlock_a_taken_slot(self, api, auth_api, venue):
        from apps.facilities.models import AddOn
        extra = AddOn.objects.create(name="Ball Set", price=Decimal("10.000"),
                                     is_active=True)
        venue["activity"].add_ons.add(extra)
        self._fill(auth_api, venue)
        resp = api.post(PUBLIC, public_payload(venue, add_ons=[extra.id]),
                        format="json")
        assert resp.status_code == 409, resp.content


# --------------------------------------------------------------------------- #
# Sections 33, 34, 35: releasing and moving a slot
# --------------------------------------------------------------------------- #
class TestReleaseAndReschedule:
    def test_cancelling_frees_the_slot_for_somebody_else(self, auth_api, venue):
        created = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0]),
                                format="json").json()
        booking = Booking.objects.get(pk=created["id"])
        booking.status = BookingStatus.CANCELLED
        booking.save()
        again = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][1]),
                              format="json")
        assert again.status_code == 201, again.content

    def test_completing_a_booking_keeps_its_slot_blocked(self, auth_api, venue):
        """A completed booking used that court for that hour.

        Releasing the slot on completion meant staff closing a booking a few
        minutes early handed the court to somebody else while it was still in
        use. Completed and closed therefore still occupy the slot.
        """
        created = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0]),
                                format="json").json()
        booking = Booking.objects.get(pk=created["id"])
        booking.status = BookingStatus.COMPLETED
        booking.save()
        again = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][1]),
                              format="json")
        assert again.status_code == 400, again.content

    def test_a_no_show_releases_the_slot(self, auth_api, venue):
        """Nobody came, so the club may resell the time."""
        created = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0]),
                                format="json").json()
        booking = Booking.objects.get(pk=created["id"])
        booking.status = BookingStatus.NO_SHOW
        booking.save()
        again = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][1]),
                              format="json")
        assert again.status_code == 201, again.content

    def test_moving_a_booking_onto_a_taken_slot_is_refused(self, auth_api, venue):
        first = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0], at="19:00"),
                              format="json").json()
        second = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][1], at="20:00"),
                               format="json").json()
        moved = auth_api.patch(f"{ADMIN}{second['id']}/",
                               {"scheduled_time": "19:00"}, format="json")
        assert moved.status_code == 400, moved.content
        # And the booking is untouched, not half-moved.
        assert Booking.objects.get(pk=second["id"]).scheduled_time == time(20, 0)

    def test_moving_a_booking_releases_the_slot_it_left(self, auth_api, venue):
        created = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0], at="19:00"),
                                format="json").json()
        moved = auth_api.patch(f"{ADMIN}{created['id']}/",
                               {"scheduled_time": "20:00"}, format="json")
        assert moved.status_code == 200, moved.content
        # 19:00 is free again for somebody else.
        taken = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][1], at="19:00"),
                              format="json")
        assert taken.status_code == 201, taken.content

    def test_a_booking_can_be_moved_onto_its_own_slot(self, auth_api, venue):
        """Editing something else must not trip over the booking itself."""
        created = auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0]),
                                format="json").json()
        resp = auth_api.patch(f"{ADMIN}{created['id']}/",
                              {"internal_notes": "Called ahead"}, format="json")
        assert resp.status_code == 200, resp.content


# --------------------------------------------------------------------------- #
# Section 46: the calendar cannot keep offering what was just taken
# --------------------------------------------------------------------------- #
class TestAvailabilityStaysHonest:
    def test_a_confirmed_booking_disappears_from_the_slot_list(self, api, auth_api, venue):
        from apps.bookings.services import public_availability
        day = soon()
        before = {s["time"]: s["available"] for s
                  in public_availability(day, club=venue["club"],
                                         facility_type=venue["activity"])["slots"]}
        assert before["19:00"] == 1

        auth_api.post(ADMIN, admin_payload(venue, venue["customers"][0], on=day),
                      format="json")
        after = {s["time"]: s["available"] for s
                 in public_availability(day, club=venue["club"],
                                        facility_type=venue["activity"])["slots"]}
        assert after["19:00"] == 0

    def test_the_month_summary_reflects_a_booking_at_once(self, auth_api, venue):
        """No cache may outlive the booking that invalidates it."""
        from apps.bookings.services import date_availability_summary
        day = soon()
        summary = date_availability_summary(day, day, club=venue["club"],
                                            facility_type=venue["activity"])
        assert summary[day.isoformat()]["available"] is True

        # Fill every hour the club is open.
        for hour in range(8, 22):
            auth_api.post(ADMIN, admin_payload(
                venue, venue["customers"][0], at=f"{hour:02d}:00", on=day), format="json")

        summary = date_availability_summary(day, day, club=venue["club"],
                                            facility_type=venue["activity"])
        assert summary[day.isoformat()]["available"] is False


# --------------------------------------------------------------------------- #
# Section 19: how an automatic offer and a promo code combine
# --------------------------------------------------------------------------- #
class TestOfferAndPromoCompose:
    """The order is: catalogue price, then automatic offers, then the promo
    code on what is left, then loyalty, then VAT.

    That is the conventional arrangement (item-level promotions first, a
    cart-level coupon on top) and it is what the engine already did. It was
    undocumented and untested, which is the only reason it counted as a gap:
    nothing stopped a later change from making the promo apply to the
    undiscounted price and quietly overcharge or undercharge everybody.
    """

    def _offer(self, venue, percent):
        from apps.facilities.models import (
            PricingAdjustmentType, PricingRule, PricingRuleType,
        )
        rule = PricingRule.objects.create(
            name='Automatic offer', code='auto-offer', is_active=True,
            rule_type=PricingRuleType.DATE_RANGE,
            adjustment_type=PricingAdjustmentType.PERCENT_DISCOUNT,
            adjustment_value=Decimal(str(percent)),
            valid_from=soon(-30), valid_to=soon(30))
        rule.clubs.add(venue['club'])
        return rule

    def _promo(self, code='TAKE10', percent=10, **extra):
        from apps.promotions.models import PromoCode
        return PromoCode.objects.create(
            code=code, is_active=True, discount_type='percent',
            discount_value=Decimal(str(percent)),
            valid_from=soon(-30), valid_to=soon(30), **extra)

    def _price(self, venue, promo=None):
        booking = Booking(
            customer=venue['customers'][0], club=venue['club'],
            facility_type=venue['activity'], scheduled_date=soon(),
            scheduled_time=time(19, 0), promo_code=promo)
        booking.compute_pricing(addons=[])
        return booking

    def test_a_promo_applies_to_the_price_after_the_offer(self, venue):
        self._offer(venue, 50)          # 100 -> 50
        promo = self._promo(percent=10)  # 10% of 50, not of 100
        booking = self._price(venue, promo)
        assert booking.promo_discount == Decimal('5.000')

    def test_they_stack_rather_than_one_replacing_the_other(self, venue):
        self._offer(venue, 50)
        promo = self._promo(percent=10)
        with_both = self._price(venue, promo).total_amount
        offer_only = self._price(venue).total_amount
        assert with_both < offer_only

    def test_the_offer_alone_still_applies_with_no_promo(self, venue):
        self._offer(venue, 50)
        booking = self._price(venue)
        assert booking.discount_amount > 0
        assert booking.promo_discount == Decimal('0.000')

    def test_the_two_together_can_never_drive_the_total_below_zero(self, venue):
        self._offer(venue, 90)
        promo = self._promo(percent=100)
        booking = self._price(venue, promo)
        assert booking.total_amount >= Decimal('0')

    def test_the_promo_is_not_applied_twice_by_repricing(self, venue):
        """Recomputing must be idempotent: the discount is derived, not added."""
        self._offer(venue, 50)
        promo = self._promo(percent=10)
        booking = self._price(venue, promo)
        first = booking.total_amount
        booking.compute_pricing(addons=[])
        assert booking.total_amount == first
