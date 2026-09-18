"""Reservation timeouts, split rules and payment methods, resolved once.

A hold, a split arrangement and the checkout all need the same answers. If any
of them read a setting directly they will eventually disagree, and the way
that shows up is a payment link still collecting money for a court that was
released and resold. So there is one resolver, and this is what pins it.
"""

import pytest

from apps.settings_app.models import Organization
from apps.settings_app.schedule import hold_minutes_for, resolve_booking_policy

pytestmark = pytest.mark.django_db


@pytest.fixture
def org(db):
    return Organization.get_solo()


@pytest.fixture
def venue_club(db):
    from apps.clubs.models import Club
    return Club.objects.create(name="Policy Club", code="POL", is_active=True)


class TestInheritance:
    def test_a_club_that_sets_nothing_follows_the_organization(self, org, venue_club):
        org.hold_unpaid_minutes = 7
        org.save()
        assert resolve_booking_policy(venue_club)["hold_unpaid_minutes"] == 7

    def test_a_club_overrides_only_what_it_states(self, org, venue_club):
        org.hold_unpaid_minutes = 10
        org.hold_partly_paid_minutes = 30
        org.save()
        venue_club.hold_unpaid_minutes = 5
        venue_club.save()

        policy = resolve_booking_policy(venue_club)
        assert policy["hold_unpaid_minutes"] == 5       # the override
        assert policy["hold_partly_paid_minutes"] == 30  # still inherited

    def test_no_club_at_all_resolves_the_organization(self, org):
        org.hold_unpaid_minutes = 12
        org.save()
        assert resolve_booking_policy()["hold_unpaid_minutes"] == 12


class TestSwitchingSomethingOff:
    """False is an answer, not an absence.

    Tested on its own because the obvious implementation checks the value for
    truthiness, and then a club that turns cash off silently inherits the
    organization's "on" and keeps offering to hold courts for money that will
    never arrive.
    """

    def test_a_club_can_turn_cash_off_while_the_organization_has_it_on(
            self, org, venue_club):
        org.cash_enabled = True
        org.save()
        venue_club.cash_enabled = False
        venue_club.save()
        assert resolve_booking_policy(venue_club)["cash_enabled"] is False

    def test_a_club_can_turn_cash_on_while_the_organization_has_it_off(
            self, org, venue_club):
        org.cash_enabled = False
        org.save()
        venue_club.cash_enabled = True
        venue_club.save()
        assert resolve_booking_policy(venue_club)["cash_enabled"] is True

    def test_a_club_can_turn_split_off(self, org, venue_club):
        org.split_enabled = True
        org.save()
        venue_club.split_enabled = False
        venue_club.save()
        assert resolve_booking_policy(venue_club)["split_enabled"] is False

    def test_an_unset_club_boolean_still_inherits(self, org, venue_club):
        org.cash_enabled = False
        org.save()
        assert venue_club.cash_enabled is None
        assert resolve_booking_policy(venue_club)["cash_enabled"] is False


class TestTheSplitWindowCannotOutliveTheCourt:
    """The one combination that loses money.

    A split deadline longer than the reservation would let payment links keep
    collecting after the slot had been released to somebody else.
    """

    def test_a_split_window_longer_than_the_ceiling_is_clamped(self, org):
        org.hold_max_minutes = 60
        org.split_hold_minutes = 999
        org.save()
        assert resolve_booking_policy()["split_hold_minutes"] == 60

    def test_a_split_window_inside_the_ceiling_is_left_alone(self, org):
        org.hold_max_minutes = 120
        org.split_hold_minutes = 45
        org.save()
        assert resolve_booking_policy()["split_hold_minutes"] == 45

    def test_a_club_cannot_raise_the_split_window_past_the_ceiling(
            self, org, venue_club):
        org.hold_max_minutes = 60
        org.save()
        venue_club.split_hold_minutes = 300
        venue_club.save()
        assert resolve_booking_policy(venue_club)["split_hold_minutes"] == 60

    def test_a_club_may_lower_its_own_ceiling_and_the_split_follows(
            self, org, venue_club):
        org.hold_max_minutes = 120
        org.split_hold_minutes = 90
        org.save()
        venue_club.hold_max_minutes = 45
        venue_club.save()
        assert resolve_booking_policy(venue_club)["split_hold_minutes"] == 45


class TestHoldMinutesForAState:
    def test_an_unpaid_reservation_uses_the_unpaid_window(self, org):
        org.hold_unpaid_minutes = 10
        org.hold_partly_paid_minutes = 30
        org.save()
        assert hold_minutes_for("pending") == 10

    def test_a_part_paid_reservation_uses_the_longer_window(self, org):
        org.hold_unpaid_minutes = 10
        org.hold_partly_paid_minutes = 30
        org.save()
        assert hold_minutes_for("partially_paid") == 30

    def test_neither_window_may_exceed_the_ceiling(self, org):
        """Section 19: nothing keeps a valuable court indefinitely."""
        org.hold_unpaid_minutes = 500
        org.hold_partly_paid_minutes = 500
        org.hold_max_minutes = 20
        org.save()
        assert hold_minutes_for("pending") == 20
        assert hold_minutes_for("partially_paid") == 20

    def test_an_unknown_state_is_treated_as_unpaid(self, org):
        """The cautious default: the shorter hold, not the longer one."""
        org.hold_unpaid_minutes = 8
        org.hold_partly_paid_minutes = 40
        org.save()
        assert hold_minutes_for("") == 8
        assert hold_minutes_for("paid") == 8
