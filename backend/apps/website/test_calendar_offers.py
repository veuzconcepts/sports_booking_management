"""Offer badges on the calendar, and hot/cold classification of the hours.

Two rules hold everything here together:

* an offer never creates availability, so a discount on a day nobody can book
  is not advertised at all;
* a classification never changes a price, so marking an evening "hot" costs a
  customer nothing until somebody writes a pricing rule that asks for it.

Both are easy to break by accident, so both are tested directly.
"""

from datetime import date, time, timedelta
from decimal import Decimal

import pytest
from django.core.cache import cache

from apps.bookings import availability_cache
from apps.bookings.models import Booking, BookingStatus
from apps.bookings.services import (
    date_availability_summary, public_availability, slot_period,
)
from apps.facilities.models import (
    PricingAdjustmentType, PricingRule, PricingRuleType,
)
from apps.settings_app import schedule as sched

pytestmark = pytest.mark.django_db

CALENDAR = "/api/v1/website/public/availability/calendar/"


def _week(shifts):
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": shifts} for day in BOOKING_DAY_KEYS}


@pytest.fixture(autouse=True)
def _fresh_cache():
    cache.clear()
    availability_cache.invalidate()


@pytest.fixture
def venue(db, tax_rate):
    from apps.clubs.models import Club
    from apps.facilities.models import Facility, FacilityCategory, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _week([{"open": "08:00", "close": "20:00"}])
    org.save()

    club = Club.objects.create(
        name="Offer Club", code="OFFER", is_active=True,
        booking_hours=_week([{"open": "08:00", "close": "20:00"}]))
    category = FacilityCategory.objects.create(name="Racquet", is_active=True)
    activity = FacilityType.objects.create(
        name="Padel Court", price=Decimal("200.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    activity.categories.add(category)
    court = Facility.objects.create(name="Court A", club=club, is_active=True)
    court.facility_types.add(activity)
    return {"club": club, "activity": activity, "court": court,
            "category": category}


def soon(days=7):
    from django.utils import timezone
    return timezone.localdate() + timedelta(days=days)


def make_offer(venue, *, name="Ramadan Offer", percent=20, fixed=None,
               first=None, last=None, club=None, facility_type=None,
               start_time=None, end_time=None, priority=100, **extra):
    rule = PricingRule.objects.create(
        name=name, code=name.lower().replace(" ", "-") + str(priority),
        is_active=True, priority=priority,
        rule_type=PricingRuleType.DATE_RANGE,
        adjustment_type=(PricingAdjustmentType.FIXED_DISCOUNT if fixed is not None
                         else PricingAdjustmentType.PERCENT_DISCOUNT),
        adjustment_value=Decimal(str(fixed if fixed is not None else percent)),
        valid_from=first or soon(1), valid_to=last or soon(10),
        start_time=start_time, end_time=end_time, **extra)
    if club is not None:
        rule.clubs.add(club)
    if facility_type is not None:
        rule.facility_types.add(facility_type)
    return rule


def summary(venue, first=None, last=None):
    return date_availability_summary(
        first or soon(1), last or soon(12),
        club=venue["club"], facility_type=venue["activity"])


# --------------------------------------------------------------------------- #
# Task A: offers on the calendar
# --------------------------------------------------------------------------- #
class TestOfferBadges:
    def test_a_percentage_offer_appears_on_its_dates(self, venue):
        make_offer(venue, percent=20, first=soon(2), last=soon(4))
        days = summary(venue)
        assert days[soon(3).isoformat()]["offer"]["label"] == "-20%"
        assert days[soon(3).isoformat()]["offer"]["type"] == "percentage"
        # And nowhere else.
        assert days[soon(8).isoformat()]["offer"] is None

    def test_a_fixed_offer_shows_an_amount(self, venue):
        make_offer(venue, name="Eid Offer", fixed=25, first=soon(2), last=soon(3))
        offer = summary(venue)[soon(2).isoformat()]["offer"]
        assert offer["type"] == "fixed"
        assert "25" in offer["label"]

    def test_a_ramadan_range_covers_every_day_in_it(self, venue):
        make_offer(venue, name="Ramadan Offer", percent=15,
                   first=soon(2), last=soon(6))
        days = summary(venue)
        for offset in range(2, 7):
            assert days[soon(offset).isoformat()]["offer"] is not None
        assert days[soon(7).isoformat()]["offer"] is None

    def test_a_club_offer_does_not_reach_another_club(self, venue):
        from apps.clubs.models import Club
        other = Club.objects.create(
            name="Elsewhere", code="ELSE", is_active=True,
            booking_hours=_week([{"open": "08:00", "close": "20:00"}]))
        make_offer(venue, percent=20, club=other)
        assert summary(venue)[soon(3).isoformat()]["offer"] is None

    def test_a_facility_offer_does_not_reach_another_activity(self, venue):
        from apps.facilities.models import FacilityType
        other = FacilityType.objects.create(
            name="Squash", price=Decimal("50.000"), duration_minutes=60,
            is_active=True, online_booking_enabled=True)
        make_offer(venue, percent=20, facility_type=other)
        assert summary(venue)[soon(3).isoformat()]["offer"] is None

    def test_the_offer_for_the_right_activity_is_shown(self, venue):
        make_offer(venue, percent=20, facility_type=venue["activity"])
        assert summary(venue)[soon(3).isoformat()]["offer"]["label"] == "-20%"

    def test_the_highest_priority_offer_wins_and_the_rest_are_counted(self, venue):
        make_offer(venue, name="Small", percent=5, priority=200)
        make_offer(venue, name="Big", percent=30, priority=10)
        offer = summary(venue)[soon(3).isoformat()]["offer"]
        # Priority is the pricing engine's own ordering, so the badge and the
        # money agree about which offer matters most.
        assert offer["name"] == "Big"
        assert offer["others"] == 1

    def test_a_part_of_day_offer_is_marked_rather_than_generalised(self, venue):
        """Section 12: "20% off" on a date that only discounts the morning
        would be a lie, so the date says only that an offer exists."""
        make_offer(venue, percent=20, start_time=time(10, 0), end_time=time(12, 0))
        offer = summary(venue)[soon(3).isoformat()]["offer"]
        assert offer is not None
        assert offer["time_limited"] is True

    def test_a_whole_day_offer_is_not_marked_time_limited(self, venue):
        make_offer(venue, percent=20)
        assert summary(venue)[soon(3).isoformat()]["offer"]["time_limited"] is False

    def test_a_surcharge_is_not_an_offer(self, venue):
        PricingRule.objects.create(
            name="Peak surcharge", code="peak-surcharge", is_active=True,
            rule_type=PricingRuleType.PEAK_HOUR,
            adjustment_type=PricingAdjustmentType.PERCENT_INCREASE,
            adjustment_value=Decimal("20"),
            valid_from=soon(1), valid_to=soon(10))
        assert summary(venue)[soon(3).isoformat()]["offer"] is None

    def test_a_membership_only_offer_is_not_advertised_to_everyone(self, venue):
        """It cannot be promised before we know who is booking."""
        from apps.payments.models import MembershipPlan
        plan = MembershipPlan.objects.create(name="Gold", code="gold",
                                             price=Decimal("100.000"))
        rule = make_offer(venue, percent=20)
        rule.membership_plans.add(plan)
        assert summary(venue)[soon(3).isoformat()]["offer"] is None

    def test_an_inactive_offer_is_not_advertised(self, venue):
        rule = make_offer(venue, percent=20)
        rule.is_active = False
        rule.save()
        assert summary(venue)[soon(3).isoformat()]["offer"] is None


class TestOfferNeverCreatesAvailability:
    def test_a_fully_booked_date_carries_no_offer(self, venue):
        """Section 8: a discount badge on a date nobody can book is an advert
        for a disappointment."""
        from apps.customers.models import Customer
        target = soon(3)
        make_offer(venue, percent=20, first=target, last=target)
        customer = Customer.objects.create(
            full_name="Filler", email="fill@offer.test", mobile_number="+966500001111")
        for hour in range(8, 20):
            Booking.objects.create(
                customer=customer, club=venue["club"],
                facility_type=venue["activity"], facility=venue["court"],
                scheduled_date=target, scheduled_time=time(hour, 0),
                end_time=time(hour + 1, 0), status=BookingStatus.CONFIRMED,
                currency="SAR", total_amount=Decimal("200.000"))
        day = summary(venue)[target.isoformat()]
        assert day["available"] is False
        assert "offer" not in day or day.get("offer") is None

    def test_a_holiday_closure_carries_no_offer(self, venue):
        from apps.settings_app.models import ScheduleException
        target = soon(4)
        make_offer(venue, name="National Day Offer", percent=25,
                   first=target, last=target)
        ScheduleException.objects.create(
            name="National Day", club=venue["club"], start_date=target,
            end_date=target, closed=True, is_active=True)
        day = summary(venue)[target.isoformat()]
        assert day["available"] is False
        assert day.get("offer") is None


class TestSlotLevelOffers:
    def test_only_the_discounted_hours_are_marked(self, venue):
        make_offer(venue, percent=20, start_time=time(10, 0), end_time=time(12, 0))
        payload = public_availability(soon(3), club=venue["club"],
                                      facility_type=venue["activity"])
        by_time = {s["time"]: s for s in payload["slots"]}
        assert by_time["10:00"]["offer"]["label"] == "-20%"
        assert by_time["15:00"]["offer"] is None

    def test_a_day_with_no_offer_marks_nothing(self, venue):
        payload = public_availability(soon(3), club=venue["club"],
                                      facility_type=venue["activity"])
        assert all(s["offer"] is None for s in payload["slots"])


class TestCalendarEndpointOffers:
    def test_the_offer_travels_to_the_browser(self, api, venue):
        make_offer(venue, percent=20)
        resp = api.get(CALENDAR, {
            "club": venue["club"].id, "facility_type": venue["activity"].id,
            "from": soon(1).isoformat(), "to": soon(6).isoformat()})
        assert resp.status_code == 200, resp.content
        day = resp.json()["days"][soon(3).isoformat()]
        assert day["offer"]["label"] == "-20%"
        # Internals stay behind: a rule id or its conditions are nobody's
        # business on a public endpoint.
        assert set(day["offer"]) == {"type", "value", "label", "name",
                                     "time_limited", "others"}


# --------------------------------------------------------------------------- #
# Task B: hot / cold classification
# --------------------------------------------------------------------------- #
class TestClassificationOnTheSchedule:
    def _classified(self, venue):
        venue["club"].booking_hours = _week([
            {"open": "08:00", "close": "16:00", "period": "cold"},
            {"open": "16:00", "close": "23:00", "period": "hot"},
        ])
        venue["club"].save()

    def test_a_shift_keeps_its_classification(self, venue):
        self._classified(venue)
        day = sched.resolve_for_date(soon(3), club=venue["club"])
        assert [w.period for w in day.shifts] == ["cold", "hot"]

    def test_periods_differ_within_one_day(self, venue):
        self._classified(venue)
        day = sched.resolve_for_date(soon(3), club=venue["club"])
        assert slot_period(day, 9 * 60, 10 * 60) == "cold"
        assert slot_period(day, 18 * 60, 19 * 60) == "hot"

    def test_an_unclassified_shift_is_normal(self, venue):
        day = sched.resolve_for_date(soon(3), club=venue["club"])
        assert slot_period(day, 9 * 60, 10 * 60) == "normal"

    def test_a_facility_overrides_its_clubs_classification(self, venue):
        self._classified(venue)
        venue["court"].booking_hours = _week([
            {"open": "08:00", "close": "23:00", "period": "hot"}])
        venue["court"].save()
        day = sched.resolve_for_date(soon(3), club=venue["club"],
                                     facility=venue["court"])
        assert slot_period(day, 9 * 60, 10 * 60) == "hot"

    def test_a_special_date_replaces_the_classification_with_the_hours(self, venue):
        """Section 27: Ramadan hours bring their own classification."""
        from apps.settings_app.models import ScheduleException
        self._classified(venue)
        target = soon(4)
        ScheduleException.objects.create(
            name="Ramadan", club=venue["club"], start_date=target, end_date=target,
            is_active=True, closed=False,
            shifts=[{"open": "16:00", "close": "19:00", "period": "cold"},
                    {"open": "20:00", "close": "23:00", "period": "hot"}])
        day = sched.resolve_for_date(target, club=venue["club"])
        assert slot_period(day, 17 * 60, 18 * 60) == "cold"
        assert slot_period(day, 21 * 60, 22 * 60) == "hot"

    def test_an_overnight_shift_keeps_its_classification_after_midnight(self, venue):
        venue["club"].booking_hours = _week([
            {"open": "18:00", "close": "02:00", "period": "hot"}])
        venue["club"].save()
        day = sched.resolve_for_date(soon(3), club=venue["club"])
        # The small hours belong to the previous evening's hot shift.
        assert slot_period(day, 0 * 60, 1 * 60) == "hot"

    def test_the_classification_reaches_the_customer_slot_list(self, venue):
        self._classified(venue)
        payload = public_availability(soon(3), club=venue["club"],
                                      facility_type=venue["activity"])
        by_time = {s["time"]: s["period"] for s in payload["slots"]}
        assert by_time["09:00"] == "cold"
        assert by_time["18:00"] == "hot"


class TestClassificationDoesNotPrice:
    def _booking(self, venue, at_hour):
        from apps.customers.models import Customer
        customer = Customer.objects.create(
            full_name="Buyer", email=f"b{at_hour}@offer.test",
            mobile_number=f"+96650000{at_hour:04d}")
        booking = Booking(
            customer=customer, club=venue["club"],
            facility_type=venue["activity"], scheduled_date=soon(3),
            scheduled_time=time(at_hour, 0))
        booking.compute_pricing(addons=[])
        return booking

    def test_marking_a_shift_hot_changes_no_price(self, venue):
        """Section 30: classification alone must never move money."""
        before = self._booking(venue, 18).total_amount
        venue["club"].booking_hours = _week([
            {"open": "08:00", "close": "16:00", "period": "cold"},
            {"open": "16:00", "close": "23:00", "period": "hot"},
        ])
        venue["club"].save()
        assert self._booking(venue, 18).total_amount == before

    def test_a_rule_that_names_a_period_applies_only_there(self, venue):
        venue["club"].booking_hours = _week([
            {"open": "08:00", "close": "16:00", "period": "cold"},
            {"open": "16:00", "close": "23:00", "period": "hot"},
        ])
        venue["club"].save()
        rule = PricingRule.objects.create(
            name="Hot hour surcharge", code="hot-hour", is_active=True,
            rule_type=PricingRuleType.PEAK_HOUR,
            adjustment_type=PricingAdjustmentType.PERCENT_INCREASE,
            adjustment_value=Decimal("50"), period_types=["hot"],
            valid_from=soon(1), valid_to=soon(10))
        rule.clubs.add(venue["club"])

        hot = self._booking(venue, 18).total_amount
        cold = self._booking(venue, 9).total_amount
        assert hot > cold

    def test_a_rule_naming_no_period_still_applies_everywhere(self, venue):
        """The default must not change: an existing rule keeps its reach."""
        venue["club"].booking_hours = _week([
            {"open": "08:00", "close": "16:00", "period": "cold"},
            {"open": "16:00", "close": "23:00", "period": "hot"},
        ])
        venue["club"].save()
        rule = PricingRule.objects.create(
            name="Flat surcharge", code="flat-surcharge", is_active=True,
            rule_type=PricingRuleType.CUSTOM,
            adjustment_type=PricingAdjustmentType.PERCENT_INCREASE,
            adjustment_value=Decimal("10"),
            valid_from=soon(1), valid_to=soon(10))
        rule.clubs.add(venue["club"])
        assert self._booking(venue, 9).total_amount > Decimal("200")
        assert self._booking(venue, 18).total_amount > Decimal("200")


class TestClassificationValidation:
    def test_a_valid_classification_round_trips(self):
        week = {"mon": {"shifts": [
            {"open": "08:00", "close": "16:00", "period": "cold"},
            {"open": "16:00", "close": "23:00", "period": "hot"}]}}
        cleaned = sched.validate_week(week, require_complete_week=False)
        assert [s.get("period") for s in cleaned["mon"]["shifts"]] == ["cold", "hot"]

    def test_an_unclassified_shift_stays_unclassified(self):
        """Existing schedule documents must not grow a field they never had."""
        cleaned = sched.validate_week(
            {"mon": {"shifts": [{"open": "08:00", "close": "20:00"}]}},
            require_complete_week=False)
        assert "period" not in cleaned["mon"]["shifts"][0]

    def test_an_unknown_classification_is_refused(self):
        with pytest.raises(sched.ScheduleValidationError):
            sched.validate_week(
                {"mon": {"shifts": [{"open": "08:00", "close": "20:00",
                                     "period": "lukewarm"}]}},
                require_complete_week=False)

    def test_overlapping_shifts_are_still_refused(self, venue):
        """Adding a classification must not weaken the existing checks."""
        with pytest.raises(sched.ScheduleValidationError):
            sched.validate_week(
                {"mon": {"shifts": [
                    {"open": "08:00", "close": "17:00", "period": "cold"},
                    {"open": "16:00", "close": "23:00", "period": "hot"}]}},
                require_complete_week=False)

    def test_the_api_refuses_an_unknown_period_on_a_pricing_rule(self, auth_api, db):
        resp = auth_api.post("/api/v1/facilities/pricing-rules/", {
            "name": "Bad", "code": "bad-period",
            "rule_type": PricingRuleType.CUSTOM,
            "adjustment_type": PricingAdjustmentType.PERCENT_DISCOUNT,
            "adjustment_value": "10", "period_types": ["tepid"],
            "valid_from": soon(1).isoformat(), "valid_to": soon(9).isoformat(),
        }, format="json")
        assert resp.status_code == 400
        assert "period_types" in resp.json()


# --------------------------------------------------------------------------- #
# Reporting (section 33)
# --------------------------------------------------------------------------- #
class TestClassificationReachesReports:
    """The classification is snapshotted on the booking when it is priced.

    Resolving it at report time would be both an N+1 and historically wrong:
    schedules get re-classified, and a report about last quarter has to
    describe the hours as they actually were.
    """

    def _book(self, venue, at_hour):
        from apps.customers.models import Customer
        customer = Customer.objects.create(
            full_name=f'Player {at_hour}', email=f'r{at_hour}@offer.test',
            mobile_number=f'+96651000{at_hour:04d}')
        booking = Booking(
            customer=customer, club=venue['club'],
            facility_type=venue['activity'], scheduled_date=soon(3),
            scheduled_time=time(at_hour, 0), status=BookingStatus.CONFIRMED)
        booking.compute_pricing(addons=[])
        booking.save()
        return booking

    def test_a_booking_records_how_its_hour_was_classified(self, venue):
        venue['club'].booking_hours = _week([
            {'open': '08:00', 'close': '16:00', 'period': 'cold'},
            {'open': '16:00', 'close': '23:00', 'period': 'hot'},
        ])
        venue['club'].save()
        assert self._book(venue, 9).period_type == 'cold'
        assert self._book(venue, 18).period_type == 'hot'

    def test_an_unclassified_hour_records_normal(self, venue):
        assert self._book(venue, 9).period_type == 'normal'

    def test_the_bookings_report_splits_by_classification(self, venue):
        from apps.reports.services import bookings_report
        venue['club'].booking_hours = _week([
            {'open': '08:00', 'close': '16:00', 'period': 'cold'},
            {'open': '16:00', 'close': '23:00', 'period': 'hot'},
        ])
        venue['club'].save()
        self._book(venue, 9)
        self._book(venue, 10)
        self._book(venue, 18)
        report = bookings_report(date_from=soon(1), date_to=soon(5))
        assert report['by_period']['cold'] == 2
        assert report['by_period']['hot'] == 1

    def test_a_reclassified_schedule_does_not_rewrite_history(self, venue):
        from apps.reports.services import bookings_report
        venue['club'].booking_hours = _week([
            {'open': '08:00', 'close': '23:00', 'period': 'cold'}])
        venue['club'].save()
        self._book(venue, 18)
        # The operator later decides the evening is peak after all.
        venue['club'].booking_hours = _week([
            {'open': '08:00', 'close': '23:00', 'period': 'hot'}])
        venue['club'].save()
        report = bookings_report(date_from=soon(1), date_to=soon(5))
        assert report['by_period'].get('cold') == 1
        assert 'hot' not in report['by_period']


class TestOfferCacheFreshness:
    """An offer edit has to reach the calendar at once.

    The date summary carries the badge, so it is cached with it. Re-targeting
    a rule is an M2M write and fires no post_save on the rule itself, which
    is the case most likely to be missed.
    """

    def test_switching_an_offer_off_removes_the_badge(self, venue):
        rule = make_offer(venue, percent=20)
        assert summary(venue)[soon(3).isoformat()]['offer'] is not None
        rule.is_active = False
        rule.save()
        assert summary(venue)[soon(3).isoformat()]['offer'] is None

    def test_retargeting_an_offer_moves_the_badge(self, venue):
        from apps.facilities.models import FacilityCategory
        rule = make_offer(venue, percent=20)
        assert summary(venue)[soon(3).isoformat()]['offer'] is not None
        # Point it at a category this activity is not in. `set`, not `add`:
        # adding would leave the original target in place and the rule would
        # still match, which is what this test is trying to rule out.
        elsewhere = FacilityCategory.objects.create(
            name='Aquatics', slug='aquatics', is_active=True)
        rule.categories.set([elsewhere])
        assert summary(venue)[soon(3).isoformat()]['offer'] is None

    def test_redating_an_offer_moves_the_badge(self, venue):
        rule = make_offer(venue, percent=20, first=soon(2), last=soon(4))
        assert summary(venue)[soon(3).isoformat()]['offer'] is not None
        rule.valid_from = soon(8)
        rule.valid_to = soon(9)
        rule.save()
        assert summary(venue)[soon(3).isoformat()]['offer'] is None
        assert summary(venue)[soon(8).isoformat()]['offer'] is not None


class TestQuoteRespectsTheChosenDate:
    """The price a customer is shown must be the price they will be charged.

    The quote used to price a booking with NO date, so every date-scoped and
    time-scoped rule was skipped: an offer that ended in September was quoted
    against a December booking, and the real booking then charged more.
    """

    QUOTE = '/api/v1/website/public/quote/'

    def _quote(self, api, venue, **extra):
        return api.post(self.QUOTE, {
            'facility_type': venue['activity'].id, 'club': venue['club'].id,
            'add_ons': [], **extra,
        }, format='json').json()

    def test_a_date_inside_the_offer_is_discounted(self, api, venue):
        make_offer(venue, percent=20, first=soon(2), last=soon(4))
        body = self._quote(api, venue, date=soon(3).isoformat(), time='09:00')
        assert [r['name'] for r in body['applied_rules']] == ['Ramadan Offer']

    def test_a_date_outside_the_offer_is_not_discounted(self, api, venue):
        make_offer(venue, percent=20, first=soon(2), last=soon(4))
        body = self._quote(api, venue, date=soon(30).isoformat(), time='09:00')
        assert body['applied_rules'] == []

    def test_the_quote_matches_what_the_booking_will_actually_cost(self, api, venue):
        from apps.bookings.models import Booking
        make_offer(venue, percent=20, first=soon(2), last=soon(4))
        outside = soon(30)
        quoted = Decimal(self._quote(
            api, venue, date=outside.isoformat(), time='09:00')['total_amount'])
        real = Booking(facility_type=venue['activity'], club=venue['club'],
                       scheduled_date=outside, scheduled_time=time(9, 0))
        real.compute_pricing(addons=[])
        assert quoted == real.total_amount

    def test_each_slot_is_priced_on_its_own_date(self, api, venue):
        """A selection straddling the end of an offer must total honestly."""
        make_offer(venue, percent=20, first=soon(2), last=soon(4))
        body = self._quote(api, venue, slots=[
            {'date': soon(3).isoformat(), 'time': '09:00'},
            {'date': soon(30).isoformat(), 'time': '09:00'},
        ])
        assert body['slot_count'] == 2
        discounted, full = (Decimal(v) for v in body['slot_totals'])
        assert discounted < full
        assert Decimal(body['order_total']) == discounted + full

    def test_a_quote_with_no_date_still_answers(self, api, venue):
        """The older shape is still accepted, for anything not yet updated."""
        body = self._quote(api, venue)
        assert body['slot_count'] == 1
        assert Decimal(body['order_total']) == Decimal(body['total_amount'])
