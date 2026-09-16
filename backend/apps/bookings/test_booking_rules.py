"""Booking policy: lead time, booking horizon, per-customer caps and the
customer cancellation window.

The rules protect the operator from bookings they cannot staff and no-shows they
cannot resell, so by default they bind SELF-SERVICE bookings only - reception
must still be able to take a walk-in for the next ten minutes.
"""

from datetime import date, datetime, time, timedelta

import pytest
from django.utils import timezone

from apps.bookings.models import Booking, BookingPolicy, BookingStatus
from apps.bookings.services import (
    BookingRuleViolation,
    CancellationTooLate,
    booking_window,
    cancellation_state,
    check_booking_rules,
    enforce_booking_rules,
    enforce_cancellation_window,
    resolve_policy,
)
from apps.facilities.models import Facility


@pytest.fixture
def court(db, club, facility_type):
    f = Facility.objects.create(club=club, name="Court 1")
    f.facility_types.set([facility_type])
    return f


@pytest.fixture
def policy(db):
    """The organization default, created on first resolve."""
    return resolve_policy()


def _at(days_ahead=2, hour=10):
    """A (date, time) that many days from today."""
    return date.today() + timedelta(days=days_ahead), time(hour, 0)


# --------------------------------------------------------------------------- #
# Resolution
# --------------------------------------------------------------------------- #
def test_the_default_policy_is_created_on_first_use(db):
    assert BookingPolicy.objects.count() == 0
    p = resolve_policy()
    assert p.is_default is True and p.club_id is None
    assert BookingPolicy.objects.count() == 1


def test_resolving_twice_reuses_the_same_default(db):
    assert resolve_policy().pk == resolve_policy().pk
    assert BookingPolicy.objects.count() == 1


def test_a_club_policy_replaces_the_default(db, club, policy):
    policy.max_advance_days = 90
    policy.save()
    own = BookingPolicy.objects.create(club=club, max_advance_days=7)
    assert resolve_policy(club).pk == own.pk
    assert resolve_policy(club).max_advance_days == 7
    assert resolve_policy().max_advance_days == 90       # other clubs unaffected


def test_a_club_without_its_own_policy_uses_the_default(db, club, policy):
    policy.max_advance_days = 30
    policy.save()
    assert resolve_policy(club).max_advance_days == 30


def test_only_one_organization_default_is_allowed(db, policy):
    from django.db import IntegrityError, transaction
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            BookingPolicy.objects.create(is_default=True)


def test_a_default_policy_cannot_belong_to_a_club(db, club):
    from django.core.exceptions import ValidationError
    with pytest.raises(ValidationError):
        BookingPolicy(is_default=True, club=club).clean()


def test_a_club_policy_must_name_a_club(db):
    from django.core.exceptions import ValidationError
    with pytest.raises(ValidationError):
        BookingPolicy(is_default=False, club=None).clean()


def test_deleting_a_club_removes_its_policy(db, club, policy):
    BookingPolicy.objects.create(club=club, max_advance_days=7)
    club.delete()
    assert BookingPolicy.objects.filter(is_default=False).count() == 0


# --------------------------------------------------------------------------- #
# Lead time
# --------------------------------------------------------------------------- #
def test_no_lead_time_allows_a_booking_right_now(db, club, policy):
    policy.min_lead_minutes = 0
    policy.save()
    now = timezone.localtime()
    soon = (now + timedelta(minutes=5))
    assert check_booking_rules(club=club, on_date=soon.date(),
                               at_time=soon.time(), staff_booking=False) == []


def test_a_booking_inside_the_lead_time_is_refused(db, club, policy):
    policy.min_lead_minutes = 120
    policy.save()
    now = timezone.localtime()
    soon = now + timedelta(minutes=30)
    reasons = check_booking_rules(club=club, on_date=soon.date(),
                                  at_time=soon.time(), staff_booking=False)
    assert reasons and "2 hours notice" in reasons[0]


def test_a_booking_outside_the_lead_time_is_allowed(db, club, policy):
    policy.min_lead_minutes = 120
    policy.save()
    later = timezone.localtime() + timedelta(hours=5)
    assert check_booking_rules(club=club, on_date=later.date(),
                               at_time=later.time(), staff_booking=False) == []


def test_a_past_slot_is_always_refused(db, club, policy):
    policy.min_lead_minutes = 0
    policy.save()
    past = timezone.localtime() - timedelta(hours=2)
    reasons = check_booking_rules(club=club, on_date=past.date(),
                                  at_time=past.time(), staff_booking=False)
    assert reasons == ["That time has already passed."]


# --------------------------------------------------------------------------- #
# Booking horizon
# --------------------------------------------------------------------------- #
def test_a_booking_beyond_the_horizon_is_refused(db, club, policy):
    policy.max_advance_days = 7
    policy.save()
    on_date, at_time = _at(days_ahead=30)
    reasons = check_booking_rules(club=club, on_date=on_date, at_time=at_time,
                                  staff_booking=False)
    assert reasons and "7 days ahead" in reasons[0]


def test_a_booking_inside_the_horizon_is_allowed(db, club, policy):
    policy.max_advance_days = 7
    policy.save()
    on_date, at_time = _at(days_ahead=3)
    assert check_booking_rules(club=club, on_date=on_date, at_time=at_time,
                               staff_booking=False) == []


def test_the_horizon_boundary_day_is_still_bookable(db, club, policy):
    policy.max_advance_days = 7
    policy.save()
    on_date, at_time = _at(days_ahead=7)
    assert check_booking_rules(club=club, on_date=on_date, at_time=at_time,
                               staff_booking=False) == []


def test_zero_means_no_horizon(db, club, policy):
    policy.max_advance_days = 0
    policy.save()
    on_date, at_time = _at(days_ahead=3650)
    assert check_booking_rules(club=club, on_date=on_date, at_time=at_time,
                               staff_booking=False) == []


# --------------------------------------------------------------------------- #
# Per-customer caps
# --------------------------------------------------------------------------- #
def test_the_active_booking_cap_is_enforced(db, club, customer, court,
                                            facility_type, policy, booking_on):
    policy.max_active_bookings_per_customer = 2
    policy.save()
    booking_on(on_date=date.today() + timedelta(days=1), at_time=time(9, 0))
    booking_on(on_date=date.today() + timedelta(days=2), at_time=time(9, 0))

    on_date, at_time = _at(days_ahead=3)
    reasons = check_booking_rules(club=club, on_date=on_date, at_time=at_time,
                                  customer=customer, staff_booking=False)
    assert reasons and "maximum of 2" in reasons[0]


def test_cancelled_bookings_do_not_count_towards_the_cap(db, club, customer, court,
                                                         facility_type, policy, booking_on):
    policy.max_active_bookings_per_customer = 1
    policy.save()
    held = booking_on(on_date=date.today() + timedelta(days=1), at_time=time(9, 0))
    held.status = BookingStatus.CANCELLED
    held.save()

    on_date, at_time = _at(days_ahead=3)
    assert check_booking_rules(club=club, on_date=on_date, at_time=at_time,
                               customer=customer, staff_booking=False) == []


def test_the_per_day_cap_is_enforced(db, club, customer, court, facility_type,
                                     policy, booking_on):
    policy.max_bookings_per_customer_per_day = 1
    policy.save()
    on_date = date.today() + timedelta(days=2)
    booking_on(on_date=on_date, at_time=time(9, 0))

    reasons = check_booking_rules(club=club, on_date=on_date, at_time=time(14, 0),
                                  customer=customer, staff_booking=False)
    assert reasons and "daily maximum of 1" in reasons[0]


def test_the_per_day_cap_does_not_leak_to_other_days(db, club, customer, court,
                                                     facility_type, policy, booking_on):
    policy.max_bookings_per_customer_per_day = 1
    policy.save()
    booking_on(on_date=date.today() + timedelta(days=2), at_time=time(9, 0))

    other_day, at_time = _at(days_ahead=3)
    assert check_booking_rules(club=club, on_date=other_day, at_time=at_time,
                               customer=customer, staff_booking=False) == []


def test_editing_a_booking_does_not_count_itself(db, club, customer, court,
                                                 facility_type, policy, booking_on):
    policy.max_active_bookings_per_customer = 1
    policy.save()
    existing = booking_on(on_date=date.today() + timedelta(days=2), at_time=time(9, 0))
    assert check_booking_rules(
        club=club, on_date=existing.scheduled_date, at_time=time(11, 0),
        customer=customer, staff_booking=False,
        exclude_booking_id=existing.pk) == []


# --------------------------------------------------------------------------- #
# Staff exemption
# --------------------------------------------------------------------------- #
def test_staff_bookings_are_exempt_by_default(db, club, policy):
    policy.min_lead_minutes = 240
    policy.max_advance_days = 1
    policy.save()
    on_date, at_time = _at(days_ahead=400)
    assert check_booking_rules(club=club, on_date=on_date, at_time=at_time,
                               staff_booking=True) == []


def test_staff_bookings_are_bound_once_enforcement_is_on(db, club, policy):
    policy.min_lead_minutes = 240
    policy.enforce_for_staff = True
    policy.save()
    soon = timezone.localtime() + timedelta(minutes=10)
    assert check_booking_rules(club=club, on_date=soon.date(), at_time=soon.time(),
                               staff_booking=True)


def test_enforce_raises_with_every_reason(db, club, policy):
    policy.min_lead_minutes = 0
    policy.max_advance_days = 1
    policy.save()
    past = timezone.localtime() - timedelta(days=400)
    with pytest.raises(BookingRuleViolation) as exc:
        enforce_booking_rules(club=club, on_date=past.date(), at_time=past.time(),
                              staff_booking=False)
    assert exc.value.reasons


# --------------------------------------------------------------------------- #
# Booking window (drives the date picker)
# --------------------------------------------------------------------------- #
def test_booking_window_reports_the_bounds(db, club, policy):
    policy.min_lead_minutes = 60
    policy.max_advance_days = 14
    policy.cancellation_cutoff_hours = 12
    policy.save()
    w = booking_window(club)
    assert w["min_lead_minutes"] == 60
    assert w["max_advance_days"] == 14
    assert w["cancellation_cutoff_hours"] == 12
    assert w["latest_date"] == (date.today() + timedelta(days=14)).isoformat()


def test_booking_window_has_no_upper_bound_when_unlimited(db, club, policy):
    policy.max_advance_days = 0
    policy.save()
    assert booking_window(club)["latest_date"] is None


# --------------------------------------------------------------------------- #
# Cancellation window
# --------------------------------------------------------------------------- #
def test_a_customer_may_cancel_well_before_the_cutoff(db, club, court, facility_type,
                                                      policy, booking_on):
    policy.cancellation_cutoff_hours = 24
    policy.save()
    b = booking_on(on_date=date.today() + timedelta(days=5), at_time=time(10, 0))
    state = cancellation_state(b)
    assert state["customer_can_cancel"] is True
    assert state["cutoff_hours"] == 24
    enforce_cancellation_window(b, actor_is_customer=True)      # must not raise


def test_a_customer_may_not_cancel_past_the_cutoff(db, club, court, facility_type,
                                                   policy, booking_on):
    policy.cancellation_cutoff_hours = 48
    policy.save()
    soon = timezone.localtime() + timedelta(hours=3)
    b = booking_on(on_date=soon.date(), at_time=soon.time().replace(microsecond=0))
    assert cancellation_state(b)["customer_can_cancel"] is False
    with pytest.raises(CancellationTooLate):
        enforce_cancellation_window(b, actor_is_customer=True)


def test_staff_are_never_blocked_by_the_cutoff(db, club, court, facility_type,
                                               policy, booking_on):
    policy.cancellation_cutoff_hours = 48
    policy.save()
    soon = timezone.localtime() + timedelta(hours=3)
    b = booking_on(on_date=soon.date(), at_time=soon.time().replace(microsecond=0))
    enforce_cancellation_window(b, actor_is_customer=False)     # must not raise


def test_a_zero_cutoff_allows_cancelling_until_the_start(db, club, court,
                                                         facility_type, policy, booking_on):
    policy.cancellation_cutoff_hours = 0
    policy.save()
    soon = timezone.localtime() + timedelta(minutes=30)
    b = booking_on(on_date=soon.date(), at_time=soon.time().replace(microsecond=0))
    state = cancellation_state(b)
    assert state["deadline"] is None
    assert state["customer_can_cancel"] is True


def test_a_terminal_booking_is_not_cancellable(db, club, court, facility_type,
                                               policy, booking_on):
    b = booking_on(on_date=date.today() + timedelta(days=5), at_time=time(10, 0))
    b.status = BookingStatus.CANCELLED
    b.save()
    assert cancellation_state(b)["customer_can_cancel"] is False
