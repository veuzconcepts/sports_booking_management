"""Booking several slots as one checkout.

The interesting cases are the ones where a set of slots is individually fine
but collectively wrong (too many, spread over dates that are not allowed, with
a gap where the rules demand none), and the ones where the world moves between
choosing and paying. Those get explicit tests; the happy path gets one.
"""

from datetime import date, time, timedelta
from decimal import Decimal

import pytest

from apps.bookings import multi_slot
from apps.bookings.models import ACTIVE_STATUSES, Booking, BookingOrder, BookingPolicy
from apps.bookings.services import resolve_slot_rules

pytestmark = pytest.mark.django_db

MONDAY = date(2026, 6, 1)


def _open_all_week():
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture
def venue(db):
    """A club with two identical courts, so capacity is 2 per slot."""
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.save()
    club = Club.objects.create(name="Court Club", is_active=True,
                               booking_hours=_open_all_week())
    ftype = FacilityType.objects.create(
        name="Badminton Court", price=Decimal("35.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    courts = []
    for name in ("Court 1", "Court 2"):
        unit = Facility.objects.create(name=name, club=club, is_active=True)
        unit.facility_types.add(ftype)
        courts.append(unit)
    customer = Customer.objects.create(
        full_name="Layla", email="layla@courtclub.sa", mobile_number="+966500000010")
    return {"club": club, "type": ftype, "courts": courts, "customer": customer}


def allow(venue, **overrides):
    """Set the organization-wide multi-slot rules."""
    policy = BookingPolicy.objects.filter(is_default=True).first()
    if policy is None:
        policy = BookingPolicy.objects.create(is_default=True)
    policy.allow_multiple_slots = True
    policy.max_slots_per_booking = 4
    for key, value in overrides.items():
        setattr(policy, key, value)
    policy.save()
    return policy


def slots(*pairs, on=MONDAY):
    return [{"date": (d or on).isoformat(), "time": t} for d, t in pairs]


# --------------------------------------------------------------------------- #
# Effective rules
# --------------------------------------------------------------------------- #
class TestRuleResolution:
    def test_a_fresh_install_books_one_slot_at_a_time(self, venue):
        rules = resolve_slot_rules(club=venue["club"])
        assert rules["allow_multiple_slots"] is False
        assert rules["max_slots_per_booking"] == 1

    def test_a_facility_overrides_only_what_it_states(self, venue):
        """Section 48: the facility caps itself without restating the rest."""
        allow(venue, max_slots_per_booking=4, allow_multiple_dates=True)
        BookingPolicy.objects.create(
            facility=venue["courts"][0], max_slots_per_booking=2)

        rules = resolve_slot_rules(club=venue["club"], facility=venue["courts"][0])
        assert rules["max_slots_per_booking"] == 2        # the override
        assert rules["allow_multiple_slots"] is True      # inherited
        assert rules["allow_multiple_dates"] is True      # inherited

    def test_a_club_sits_between_the_organization_and_the_facility(self, venue):
        allow(venue, max_slots_per_booking=6)
        BookingPolicy.objects.create(club=venue["club"], max_slots_per_booking=3)
        assert resolve_slot_rules(club=venue["club"])["max_slots_per_booking"] == 3

    def test_switching_multi_slot_off_collapses_the_limits(self, venue):
        allow(venue, allow_multiple_slots=False, max_slots_per_booking=9,
              allow_multiple_dates=True)
        rules = resolve_slot_rules(club=venue["club"])
        # A max of nine is meaningless when only one slot may be booked.
        assert rules["max_slots_per_booking"] == 1
        assert rules["allow_multiple_dates"] is False

    def test_a_maximum_below_the_minimum_cannot_lock_everybody_out(self, venue):
        allow(venue, min_slots_per_booking=3, max_slots_per_booking=2)
        rules = resolve_slot_rules(club=venue["club"])
        assert rules["max_slots_per_booking"] >= rules["min_slots_per_booking"]


# --------------------------------------------------------------------------- #
# The shape of a selection
# --------------------------------------------------------------------------- #
class TestSelectionShape:
    def _check(self, venue, raw, **overrides):
        allow(venue, **overrides)
        rules = resolve_slot_rules(club=venue["club"])
        parsed = multi_slot.parse_slots(raw)
        multi_slot.check_selection_shape(parsed, rules, duration=60)
        return parsed

    def test_two_slots_on_one_date(self, venue):
        assert len(self._check(venue, slots((None, "18:00"), (None, "19:00")))) == 2

    def test_four_slots_on_one_date(self, venue):
        picked = self._check(venue, slots(
            (None, "18:00"), (None, "19:00"), (None, "20:00"), (None, "21:00")))
        assert len(picked) == 4

    def test_a_fifth_slot_is_refused_with_the_limit_named(self, venue):
        with pytest.raises(multi_slot.SelectionError) as exc:
            self._check(venue, slots(
                (None, "17:00"), (None, "18:00"), (None, "19:00"),
                (None, "20:00"), (None, "21:00")))
        assert "up to 4" in str(exc.value)

    def test_a_minimum_is_stated_rather_than_just_blocking(self, venue):
        with pytest.raises(multi_slot.SelectionError) as exc:
            self._check(venue, slots((None, "18:00")), min_slots_per_booking=2)
        assert "at least 2" in str(exc.value)

    def test_slots_across_dates_when_allowed(self, venue):
        picked = self._check(
            venue,
            slots((MONDAY, "18:00"), (MONDAY + timedelta(days=1), "19:00")),
            allow_multiple_dates=True)
        assert len({entry[0] for entry in picked}) == 2

    def test_slots_across_dates_when_not_allowed(self, venue):
        with pytest.raises(multi_slot.SelectionError) as exc:
            self._check(
                venue,
                slots((MONDAY, "18:00"), (MONDAY + timedelta(days=1), "19:00")),
                allow_multiple_dates=False)
        assert "same date" in str(exc.value)

    def test_consecutive_required_accepts_a_run(self, venue):
        picked = self._check(
            venue, slots((None, "18:00"), (None, "19:00"), (None, "20:00")),
            require_consecutive_slots=True)
        assert len(picked) == 3

    def test_consecutive_required_rejects_a_gap(self, venue):
        with pytest.raises(multi_slot.SelectionError) as exc:
            self._check(venue, slots((None, "18:00"), (None, "20:00")),
                        require_consecutive_slots=True)
        assert "back to back" in str(exc.value)

    def test_a_gap_is_fine_when_consecutive_is_not_required(self, venue):
        assert len(self._check(venue, slots((None, "18:00"), (None, "20:00")))) == 2

    def test_multi_slot_disabled_refuses_a_second_slot(self, venue):
        """Section 3: the single-slot flow is untouched."""
        with pytest.raises(multi_slot.SelectionError) as exc:
            self._check(venue, slots((None, "18:00"), (None, "19:00")),
                        allow_multiple_slots=False)
        assert exc.value.code == "multiple_not_allowed"

    def test_an_empty_selection_is_refused(self, venue):
        with pytest.raises(multi_slot.SelectionError) as exc:
            self._check(venue, [])
        assert exc.value.code == "no_slots"


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
class TestParsing:
    def test_the_same_slot_twice_counts_once(self, venue):
        """Section 36: a duplicate is dropped here and rejected by the index."""
        picked = multi_slot.parse_slots(slots((None, "18:00"), (None, "18:00")))
        assert len(picked) == 1

    def test_slots_come_back_in_time_order_not_click_order(self, venue):
        """Section 35: click order would make the confirmation read oddly."""
        picked = multi_slot.parse_slots(slots(
            (None, "21:00"), (None, "18:00"), (None, "19:00")))
        assert [t.strftime("%H:%M") for _d, t in picked] == ["18:00", "19:00", "21:00"]

    def test_dates_sort_before_times(self, venue):
        tuesday = MONDAY + timedelta(days=1)
        picked = multi_slot.parse_slots(
            slots((tuesday, "09:00"), (MONDAY, "21:00")))
        assert picked[0][0] == MONDAY

    def test_unreadable_input_is_refused_rather_than_guessed(self, venue):
        with pytest.raises(multi_slot.SelectionError) as exc:
            multi_slot.parse_slots([{"date": "not-a-date", "time": "18:00"}])
        assert exc.value.code == "invalid_slots"


# --------------------------------------------------------------------------- #
# Discount allocation
# --------------------------------------------------------------------------- #
class TestDiscountAllocation:
    def test_the_parts_add_back_to_the_whole(self):
        shares = multi_slot.allocate_discount(
            [Decimal("50"), Decimal("50"), Decimal("60")], Decimal("10"))
        assert sum(shares) == Decimal("10.000")

    def test_a_dearer_slot_carries_more_of_the_discount(self):
        cheap, dear = multi_slot.allocate_discount(
            [Decimal("50"), Decimal("150")], Decimal("20"))
        assert dear > cheap
        assert cheap + dear == Decimal("20.000")

    def test_an_indivisible_discount_still_balances(self):
        shares = multi_slot.allocate_discount(
            [Decimal("100"), Decimal("100"), Decimal("100")], Decimal("10"))
        assert sum(shares) == Decimal("10.000")

    def test_nothing_to_discount_allocates_nothing(self):
        assert multi_slot.allocate_discount([Decimal("0")], Decimal("5")) == [Decimal("0.000")]


# --------------------------------------------------------------------------- #
# Creating the order
# --------------------------------------------------------------------------- #
class TestCreateOrder:
    def _make(self, venue, picked, **kwargs):
        allow(venue, allow_multiple_dates=True)
        parsed = multi_slot.parse_slots(picked)
        return multi_slot.create_order(
            customer=venue["customer"], club=venue["club"],
            facility_type=venue["type"], slots=parsed, **kwargs)

    def _fill(self, venue, at):
        """Take every court at one time, so that slot cannot be served."""
        from apps.bookings.models import BookingStatus
        for court in venue["courts"]:
            Booking.objects.create(
                customer=venue["customer"], club=venue["club"],
                facility_type=venue["type"], facility=court,
                scheduled_date=MONDAY, scheduled_time=at,
                duration_minutes=60, status=BookingStatus.CONFIRMED)

    def test_one_order_holds_one_booking_per_slot(self, venue):
        order, bookings = self._make(venue, slots((None, "18:00"), (None, "19:00")))
        assert order.reference.startswith("ORD-")
        assert len(bookings) == 2
        assert order.slot_count == 2
        # Each slot is an ordinary booking, so everything else keeps working.
        assert all(b.order_id == order.id for b in bookings)
        assert {b.scheduled_time.strftime("%H:%M") for b in bookings} == {"18:00", "19:00"}

    def test_each_slot_gets_its_own_allocated_court(self, venue):
        _order, bookings = self._make(venue, slots((None, "18:00"), (None, "19:00")))
        assert all(b.facility_id for b in bookings), "a slot was left unallocated"

    def test_the_order_total_is_the_sum_of_its_slots(self, venue):
        order, bookings = self._make(venue, slots((None, "18:00"), (None, "19:00")))
        assert order.total_amount == sum(b.total_amount for b in bookings)
        assert order.total_duration_minutes == sum(b.duration_minutes for b in bookings)

    def test_slots_across_dates_become_one_order(self, venue):
        tuesday = MONDAY + timedelta(days=1)
        order, bookings = self._make(
            venue, slots((MONDAY, "18:00"), (tuesday, "19:00")))
        assert len({b.scheduled_date for b in bookings}) == 2
        assert order.slot_count == 2

    def test_a_taken_slot_takes_the_whole_order_with_it(self, venue):
        """Section 19: two thirds of a booking is worse than none of it."""
        self._fill(venue, time(19, 0))
        before = Booking.objects.count()
        with pytest.raises(multi_slot.SelectionError) as exc:
            self._make(venue, slots((None, "18:00"), (None, "19:00")))
        assert exc.value.code == "slot_unavailable"
        # The 18:00 slot must NOT have been created on its own.
        assert Booking.objects.count() == before
        assert not BookingOrder.objects.exists()

    def test_the_unavailable_slot_is_named_not_the_whole_selection(self, venue):
        """Section 17: a generic failure makes the customer re-pick everything."""
        self._fill(venue, time(19, 0))
        with pytest.raises(multi_slot.SelectionError) as exc:
            self._make(venue, slots((None, "18:00"), (None, "19:00")))
        assert [s["time"] for s in exc.value.slots] == ["19:00"]
        assert "19:00" in str(exc.value)

    def test_capacity_is_respected_across_orders(self, venue):
        """Two courts means two concurrent bookings, not unlimited."""
        _first, one = self._make(venue, slots((None, "18:00")))
        assert len(one) == 1
        second, _ = multi_slot.create_order(
            customer=venue["customer"], club=venue["club"],
            facility_type=venue["type"],
            slots=multi_slot.parse_slots(slots((None, "18:00"))))
        assert second.slot_count == 1
        with pytest.raises(multi_slot.SelectionError):
            multi_slot.create_order(
                customer=venue["customer"], club=venue["club"],
                facility_type=venue["type"],
                slots=multi_slot.parse_slots(slots((None, "18:00"))))


# --------------------------------------------------------------------------- #
# Promo codes across an order
# --------------------------------------------------------------------------- #
class TestOrderPromo:
    def _promo(self, **kwargs):
        from apps.promotions.models import PromoCode
        defaults = dict(code="SAVE10", discount_type=PromoCode.DiscountType.PERCENT,
                        discount_value=Decimal("10"), is_active=True)
        defaults.update(kwargs)
        return PromoCode.objects.create(**defaults)

    def _order(self, venue, picked, code="SAVE10"):
        allow(venue, allow_multiple_dates=True)
        return multi_slot.create_order(
            customer=venue["customer"], club=venue["club"],
            facility_type=venue["type"],
            slots=multi_slot.parse_slots(picked), promo_input=code)

    def test_a_promo_is_redeemed_once_for_the_whole_order(self, venue):
        """Section 24: per-slot redemption would spend the limit N times."""
        from apps.promotions.models import PromoRedemption

        promo = self._promo()
        self._order(venue, slots((None, "18:00"), (None, "19:00")))
        assert PromoRedemption.objects.count() == 1
        promo.refresh_from_db()
        assert promo.used_count == 1

    def test_the_discount_is_shared_across_the_slots(self, venue):
        self._promo()
        _order, bookings = self._order(venue, slots((None, "18:00"), (None, "19:00")))
        # Every slot carries its share, so refunding one returns the right net.
        assert all(b.promo_discount > 0 for b in bookings)
        assert all(b.promo_code_id for b in bookings)

    def test_a_maximum_discount_caps_the_order_not_each_slot(self, venue):
        """Four slots would otherwise apply a SAR 5 cap four times over."""
        self._promo(max_discount_amount=Decimal("5.000"))
        _order, bookings = self._order(venue, slots(
            (None, "18:00"), (None, "19:00"), (None, "20:00"), (None, "21:00")))
        total = sum(b.promo_discount for b in bookings)
        assert total <= Decimal("5.000"), total

    def test_a_minimum_order_value_reads_the_order_not_one_slot(self, venue):
        """One slot may sit under the minimum while the order clears it."""
        self._promo(min_order_amount=Decimal("60.000"))
        _order, bookings = self._order(venue, slots((None, "18:00"), (None, "19:00")))
        assert sum(b.promo_discount for b in bookings) > 0

    def test_an_unusable_promo_does_not_cost_the_customer_the_booking(self, venue):
        allow(venue)
        order, bookings = multi_slot.create_order(
            customer=venue["customer"], club=venue["club"],
            facility_type=venue["type"],
            slots=multi_slot.parse_slots(slots((None, "18:00"))),
            promo_input="NOSUCHCODE")
        assert order.slot_count == 1
        assert all(b.promo_discount == 0 for b in bookings)
