"""Saving a half-finished booking and coming back to it.

A draft is one admin's unfinished form, nothing more. It exists because
somebody gets interrupted halfway through taking a booking and would rather
keep what they typed than start again.

The property that shapes everything here is that a draft holds NO court. A
half-filled booking somebody forgets about must not take a court off sale for
ever, and there is no clock on a draft to release it. So the court stays on
sale the whole time, and availability is checked at the moment the draft is
finished, which is the moment it stops being a form and starts occupying
something.
"""

from datetime import time, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings import services as booking_services
from apps.bookings.models import (
    ACTIVE_STATUSES, Booking, BookingStatus, SLOT_BLOCKING_STATUSES,
)

pytestmark = pytest.mark.django_db

BOOKINGS = "/api/v1/bookings/"


def _open_all_week():
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture
def venue(db, tax_rate):
    """One club, one activity, exactly ONE court, so capacity is one."""
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.save()

    club = Club.objects.create(name="Draft Club", code="DRFT", is_active=True,
                               booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Squash Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Squash 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customer = Customer.objects.create(
        full_name="Draft Player", email="draft@nadena.sa",
        mobile_number="+966500000099")
    return {"club": club, "activity": activity, "court": court,
            "customer": customer}


def soon(days=4):
    return timezone.localdate() + timedelta(days=days)


def body(venue, **extra):
    payload = {
        "customer": venue["customer"].id,
        "club": venue["club"].id,
        "facility_type": venue["activity"].id,
        "scheduled_date": soon().isoformat(),
        "scheduled_time": "19:00",
    }
    payload.update(extra)
    return payload


# --------------------------------------------------------------------------- #
# Saving one
# --------------------------------------------------------------------------- #
class TestSavingADraft:
    def test_an_admin_can_save_a_booking_as_a_draft(self, auth_api, venue):
        response = auth_api.post(BOOKINGS, body(venue, save_as_draft=True),
                                 format="json")
        assert response.status_code == 201, response.data
        assert Booking.objects.get().status == BookingStatus.DRAFT

    def test_without_the_flag_it_is_an_ordinary_booking(self, auth_api, venue):
        response = auth_api.post(BOOKINGS, body(venue), format="json")
        assert response.status_code == 201, response.data
        assert Booking.objects.get().status == BookingStatus.BOOKED

    def test_a_draft_may_leave_the_details_blank(self, auth_api, venue):
        """The whole point: the admin was interrupted part way through."""
        response = auth_api.post(BOOKINGS, {
            "scheduled_date": soon().isoformat(), "scheduled_time": "19:00",
            "save_as_draft": True,
        }, format="json")
        assert response.status_code == 201, response.data
        draft = Booking.objects.get()
        assert draft.status == BookingStatus.DRAFT
        assert draft.customer_id is None
        assert draft.facility_type_id is None

    def test_a_draft_is_given_no_court(self, auth_api, venue):
        auth_api.post(BOOKINGS, body(venue, save_as_draft=True), format="json")
        assert Booking.objects.get().facility_id is None

    def test_a_draft_is_still_priced_so_the_admin_can_see_the_cost(
            self, auth_api, venue):
        auth_api.post(BOOKINGS, body(venue, save_as_draft=True), format="json")
        assert Booking.objects.get().total_amount > 0


# --------------------------------------------------------------------------- #
# What a draft must NOT do
# --------------------------------------------------------------------------- #
class TestADraftHoldsNothing:
    def test_draft_is_not_a_slot_blocking_status(self):
        """The one-line definition the whole design rests on."""
        assert BookingStatus.DRAFT not in SLOT_BLOCKING_STATUSES
        assert BookingStatus.DRAFT not in ACTIVE_STATUSES

    def test_the_court_stays_on_sale(self, auth_api, venue):
        auth_api.post(BOOKINGS, body(venue, save_as_draft=True), format="json")
        assert booking_services.slot_is_available(
            soon(), time(19, 0), club=venue["club"],
            facility_type=venue["activity"])

    def test_somebody_else_can_book_the_same_slot(self, auth_api, venue):
        auth_api.post(BOOKINGS, body(venue, save_as_draft=True), format="json")
        response = auth_api.post(BOOKINGS, body(venue), format="json")
        assert response.status_code == 201, response.data

    def test_a_draft_does_not_count_against_a_customer_cap(self, auth_api, venue):
        """Caps read ACTIVE_STATUSES, which a draft is deliberately outside."""
        from apps.bookings.models import BookingPolicy

        policy = (BookingPolicy.objects.filter(is_default=True).first()
                  or BookingPolicy.objects.create(is_default=True))
        policy.max_active_bookings_per_customer = 1
        policy.enforce_for_staff = True
        policy.save()

        auth_api.post(BOOKINGS, body(venue, save_as_draft=True), format="json")
        later = auth_api.post(
            BOOKINGS, body(venue, scheduled_time="21:00"), format="json")
        assert later.status_code == 201, later.data


# --------------------------------------------------------------------------- #
# Finishing one
# --------------------------------------------------------------------------- #
class TestFinishingADraft:
    def draft(self, auth_api, venue, **extra):
        auth_api.post(BOOKINGS, body(venue, save_as_draft=True, **extra),
                      format="json")
        return Booking.objects.get(status=BookingStatus.DRAFT)

    def test_finishing_makes_it_a_real_booking_with_a_court(self, auth_api, venue):
        draft = self.draft(auth_api, venue)
        response = auth_api.post(f"{BOOKINGS}{draft.id}/finish-draft/", {},
                                 format="json")
        assert response.status_code == 200, response.data
        draft.refresh_from_db()
        assert draft.status == BookingStatus.BOOKED
        assert draft.facility_id == venue["court"].id

    def test_the_court_is_taken_only_once_it_is_finished(self, auth_api, venue):
        draft = self.draft(auth_api, venue)
        auth_api.post(f"{BOOKINGS}{draft.id}/finish-draft/", {}, format="json")
        assert not booking_services.slot_is_available(
            soon(), time(19, 0), club=venue["club"],
            facility_type=venue["activity"])

    def test_an_incomplete_draft_says_what_is_missing(self, auth_api, venue):
        auth_api.post(BOOKINGS, {
            "scheduled_date": soon().isoformat(), "scheduled_time": "19:00",
            "save_as_draft": True,
        }, format="json")
        draft = Booking.objects.get()
        response = auth_api.post(f"{BOOKINGS}{draft.id}/finish-draft/", {},
                                 format="json")
        assert response.status_code == 400, response.data
        assert response.data["code"] == "draft_incomplete"
        assert "a customer" in response.data["missing"]
        assert Booking.objects.get().status == BookingStatus.DRAFT

    def test_a_court_taken_while_the_draft_waited_is_reported_honestly(
            self, auth_api, venue):
        """The cost of holding nothing, and the honest place to pay it."""
        draft = self.draft(auth_api, venue)
        Booking.objects.create(
            customer=venue["customer"], club=venue["club"],
            facility=venue["court"], facility_type=venue["activity"],
            scheduled_date=soon(), scheduled_time=time(19, 0),
            end_time=time(20, 0), duration_minutes=60,
            status=BookingStatus.CONFIRMED, currency="SAR",
            total_amount=Decimal("100.000"))

        response = auth_api.post(f"{BOOKINGS}{draft.id}/finish-draft/", {},
                                 format="json")
        assert response.status_code == 409, response.data
        assert response.data["code"] == "slot_unavailable"
        draft.refresh_from_db()
        assert draft.status == BookingStatus.DRAFT      # still theirs to fix

    def test_finishing_something_that_is_not_a_draft_is_refused(
            self, auth_api, venue):
        auth_api.post(BOOKINGS, body(venue), format="json")
        booking = Booking.objects.get()
        response = auth_api.post(f"{BOOKINGS}{booking.id}/finish-draft/", {},
                                 format="json")
        assert response.status_code == 400
        assert response.data["code"] == "not_a_draft"

    def test_finishing_is_recorded_in_the_booking_history(self, auth_api, venue):
        draft = self.draft(auth_api, venue)
        auth_api.post(f"{BOOKINGS}{draft.id}/finish-draft/", {}, format="json")
        assert draft.status_history.filter(
            to_status=BookingStatus.BOOKED).exists()


# --------------------------------------------------------------------------- #
# The lifecycle around it
# --------------------------------------------------------------------------- #
class TestTheDraftLifecycle:
    def test_a_draft_can_be_thrown_away(self, auth_api, venue):
        auth_api.post(BOOKINGS, body(venue, save_as_draft=True), format="json")
        draft = Booking.objects.get()
        booking_services.transition_booking(draft, BookingStatus.CANCELLED)
        assert draft.status == BookingStatus.CANCELLED

    def test_a_draft_cannot_jump_straight_to_confirmed(self, auth_api, venue):
        """It has no court yet. Confirming would promise one it does not hold."""
        auth_api.post(BOOKINGS, body(venue, save_as_draft=True), format="json")
        draft = Booking.objects.get()
        with pytest.raises(ValueError):
            booking_services.transition_booking(draft, BookingStatus.CONFIRMED)

    def test_a_real_booking_cannot_be_demoted_back_to_a_draft(
            self, auth_api, venue):
        """That would take its court away without cancelling anything."""
        auth_api.post(BOOKINGS, body(venue), format="json")
        booking = Booking.objects.get()
        with pytest.raises(ValueError):
            booking_services.transition_booking(booking, BookingStatus.DRAFT)

    def test_editing_a_booking_cannot_smuggle_it_into_draft(self, auth_api, venue):
        """`save_as_draft` is honoured on creation and nowhere else."""
        auth_api.post(BOOKINGS, body(venue), format="json")
        booking = Booking.objects.get()
        response = auth_api.patch(f"{BOOKINGS}{booking.id}/",
                                  {"save_as_draft": True}, format="json")
        assert response.status_code in (200, 202), response.data
        booking.refresh_from_db()
        assert booking.status == BookingStatus.BOOKED


class TestTheExemptionIsNarrow:
    """A draft is excused COMPLETENESS and nothing else.

    The risk in relaxing validation is that the relaxation leaks: a real
    booking that slips through without a customer, or a draft that is allowed
    to be self-contradictory. Both are pinned here.
    """

    def test_a_real_booking_still_needs_a_customer(self, auth_api, venue):
        response = auth_api.post(BOOKINGS, {
            "club": venue["club"].id,
            "facility_type": venue["activity"].id,
            "scheduled_date": soon().isoformat(), "scheduled_time": "19:00",
        }, format="json")
        assert response.status_code == 400, response.data

    def test_a_real_booking_still_needs_an_activity(self, auth_api, venue):
        response = auth_api.post(BOOKINGS, {
            "customer": venue["customer"].id, "club": venue["club"].id,
            "scheduled_date": soon().isoformat(), "scheduled_time": "19:00",
        }, format="json")
        assert response.status_code == 400, response.data

    def test_a_draft_may_not_name_a_court_at_the_wrong_club(self, auth_api, venue):
        """A contradiction is wrong whenever it was written, draft or not."""
        from apps.clubs.models import Club
        from apps.facilities.models import Facility

        other = Club.objects.create(name="Elsewhere", code="ELSE", is_active=True)
        stray = Facility.objects.create(name="Stray", club=other, is_active=True)
        response = auth_api.post(
            BOOKINGS, body(venue, save_as_draft=True, facility=stray.id),
            format="json")
        assert response.status_code == 400, response.data

    def test_a_draft_still_needs_a_date_and_a_time(self, auth_api, venue):
        """The schema requires them, and relaxing that would reach much
        further than drafts: the slot index, every filter and every listing
        assume a booking has a when."""
        response = auth_api.post(BOOKINGS, {"save_as_draft": True}, format="json")
        assert response.status_code == 400, response.data
