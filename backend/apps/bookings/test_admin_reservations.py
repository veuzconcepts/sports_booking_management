"""Reservations, seen by the people who have to explain them.

A reservation leaves no booking row. Until this existed, a held court showed
up for staff only as a slot they could not book, and a customer ringing to say
their checkout was stuck could not be helped without waiting out the clock.

Two properties matter more than the listing itself. The bearer token's digest
must never leave the server, because a page that leaked it would hand anybody
who can read it the ability to spend or give away somebody else's
reservation. And "live" must be answered by the clock rather than the status,
or staff chase courts that are already back on sale.
"""

from datetime import time, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings import reservations
from apps.bookings.models import BookingHold, HoldStatus

pytestmark = pytest.mark.django_db

RESERVATIONS = "/api/v1/bookings/reservations/"


@pytest.fixture
def venue(db):
    from apps.clubs.models import Club
    from apps.facilities.models import Facility, FacilityType

    from apps.settings_app.models import BOOKING_DAY_KEYS
    open_all_week = {day: {"closed": False,
                           "shifts": [{"open": "06:00", "close": "23:00"}]}
                     for day in BOOKING_DAY_KEYS}
    club = Club.objects.create(name="Desk Club", code="DESK", is_active=True,
                               booking_hours=open_all_week)
    activity = FacilityType.objects.create(
        name="Padel Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True)
    court = Facility.objects.create(name="Padel 1", club=club, is_active=True)
    court.facility_types.add(activity)
    return {"club": club, "activity": activity, "court": court}


def soon(days=4):
    return timezone.localdate() + timedelta(days=days)


def hold_for(venue, at=time(19, 0)):
    hold, _token = reservations.acquire(
        club=venue["club"], facility_type=venue["activity"],
        slots=[(soon(), at)])
    return hold


# --------------------------------------------------------------------------- #
# What must never leak
# --------------------------------------------------------------------------- #
class TestTheTokenNeverLeaves:
    def test_the_listing_does_not_carry_the_token_digest(self, auth_api, venue):
        """It is the digest of a bearer token. A listing that carried it would
        let anybody who can read this page spend somebody else's reservation."""
        hold_for(venue)
        row = auth_api.get(RESERVATIONS).data["results"][0]
        assert "token_hash" not in row
        assert "token" not in row

    def test_the_detail_view_does_not_either(self, auth_api, venue):
        hold = hold_for(venue)
        body = auth_api.get(f"{RESERVATIONS}{hold.id}/").data
        assert "token_hash" not in body
        assert "token" not in body

    def test_no_field_anywhere_holds_the_digest(self, auth_api, venue):
        """Belt and braces: the digest must not appear under any other name."""
        hold = hold_for(venue)
        digest = BookingHold.objects.get(pk=hold.pk).token_hash
        assert digest                                   # it does exist
        assert digest not in str(auth_api.get(RESERVATIONS).data)


# --------------------------------------------------------------------------- #
# Who may look
# --------------------------------------------------------------------------- #
class TestWhoMayLook:
    def test_staff_may_list_reservations(self, auth_api, venue):
        hold_for(venue)
        response = auth_api.get(RESERVATIONS)
        assert response.status_code == 200
        assert response.data["count"] == 1

    def test_a_signed_out_visitor_may_not(self, api, venue):
        hold_for(venue)
        assert api.get(RESERVATIONS).status_code == 401

    def test_a_customer_may_not(self, api, venue, make_user):
        """A customer reaches their own reservation by its token, which is a
        different door. This list spans every customer in the club."""
        from apps.accounts.models import Role

        hold_for(venue)
        customer = make_user("holder@example.com", role=Role.CUSTOMER)
        api.force_authenticate(user=customer)
        assert api.get(RESERVATIONS).status_code == 403


# --------------------------------------------------------------------------- #
# What it says
# --------------------------------------------------------------------------- #
class TestWhatItReports:
    def test_a_reservation_names_its_club_activity_and_times(self, auth_api, venue):
        hold_for(venue)
        row = auth_api.get(RESERVATIONS).data["results"][0]
        assert row["club_name"] == "Desk Club"
        assert row["facility_type_name"] == "Padel Court"
        assert [str(s["scheduled_time"]) for s in row["slots"]] == ["19:00:00"]
        assert row["slots"][0]["facility_name"] == "Padel 1"

    def test_it_counts_down(self, auth_api, venue):
        hold_for(venue)
        row = auth_api.get(RESERVATIONS).data["results"][0]
        assert row["seconds_remaining"] > 0
        assert row["is_live"] is True

    def test_a_lapsed_reservation_is_not_live_before_the_sweep_runs(
            self, auth_api, venue):
        """The status still says active between sweeps. The clock decides."""
        hold = hold_for(venue)
        hold.expires_at = timezone.now() - timedelta(minutes=1)
        hold.save(update_fields=["expires_at"])

        row = auth_api.get(RESERVATIONS).data["results"][0]
        assert row["status"] == HoldStatus.ACTIVE       # not swept yet
        assert row["is_live"] is False
        assert row["seconds_remaining"] == 0

    def test_live_filters_by_the_clock_not_the_status(self, auth_api, venue):
        hold_for(venue, at=time(19, 0))
        lapsed = hold_for(venue, at=time(20, 0))
        lapsed.expires_at = timezone.now() - timedelta(minutes=1)
        lapsed.save(update_fields=["expires_at"])

        live = auth_api.get(RESERVATIONS, {"live": "true"}).data
        assert live["count"] == 1
        assert str(live["results"][0]["slots"][0]["scheduled_time"]) == "19:00:00"

    def test_it_can_be_narrowed_to_one_club(self, auth_api, venue):
        from apps.clubs.models import Club
        from apps.facilities.models import Facility

        other = Club.objects.create(
            name="Elsewhere", code="ELSE", is_active=True,
            booking_hours=venue["club"].booking_hours)
        court = Facility.objects.create(name="E1", club=other, is_active=True)
        court.facility_types.add(venue["activity"])
        hold_for(venue)
        reservations.acquire(club=other, facility_type=venue["activity"],
                             slots=[(soon(), time(19, 0))])

        narrowed = auth_api.get(RESERVATIONS, {"club": venue["club"].id}).data
        assert narrowed["count"] == 1
        assert narrowed["results"][0]["club_name"] == "Desk Club"


# --------------------------------------------------------------------------- #
# Letting one go
# --------------------------------------------------------------------------- #
class TestReleasingOne:
    def test_releasing_frees_the_court_at_once(self, auth_api, venue):
        """The reason this screen exists: a stuck reservation without waiting
        out its clock."""
        from apps.bookings.services import slot_is_available

        hold = hold_for(venue)
        assert not slot_is_available(soon(), time(19, 0), club=venue["club"],
                                     facility_type=venue["activity"])

        response = auth_api.post(f"{RESERVATIONS}{hold.id}/release/")
        assert response.status_code == 200, response.data
        assert response.data["status"] == HoldStatus.RELEASED
        assert slot_is_available(soon(), time(19, 0), club=venue["club"],
                                 facility_type=venue["activity"])

    def test_releasing_twice_is_not_an_error(self, auth_api, venue):
        hold = hold_for(venue)
        assert auth_api.post(f"{RESERVATIONS}{hold.id}/release/").status_code == 200
        assert auth_api.post(f"{RESERVATIONS}{hold.id}/release/").status_code == 200

    def test_releasing_a_converted_reservation_leaves_it_converted(
            self, auth_api, venue):
        """It became a booking. Releasing it must not rewrite that history,
        and above all must not suggest the court is free."""
        from apps.bookings.models import Booking, BookingStatus

        hold = hold_for(venue)
        booking = Booking.objects.create(
            club=venue["club"], facility=venue["court"],
            facility_type=venue["activity"], scheduled_date=soon(),
            scheduled_time=time(19, 0), end_time=time(20, 0),
            duration_minutes=60, status=BookingStatus.CONFIRMED,
            booking_type="walk_in", walk_in_name="Desk Customer",
            currency="SAR", total_amount=Decimal("100.000"))
        reservations.convert(hold, booking=booking)

        response = auth_api.post(f"{RESERVATIONS}{hold.id}/release/")
        assert response.status_code == 200
        assert response.data["status"] == HoldStatus.CONVERTED

    def test_nothing_here_creates_a_reservation(self, auth_api, venue):
        """Reservations belong to the checkout that owns the deadline."""
        assert auth_api.post(RESERVATIONS, {}, format="json").status_code == 405

    def test_nothing_here_edits_one(self, auth_api, venue):
        hold = hold_for(venue)
        assert auth_api.patch(f"{RESERVATIONS}{hold.id}/",
                              {"status": "released"}, format="json").status_code == 405


# --------------------------------------------------------------------------- #
# Whose reservations they are
# --------------------------------------------------------------------------- #
class TestClubScoping:
    """A reservation names a customer and the courts they are holding, so it
    obeys the same club boundary every other booking record does.

    This listing had none until it was given a screen. Nobody could reach it
    without one, but "unreachable" is not a boundary: the moment the page went
    into the sidebar, a manager at one club could read, and release, courts at
    another.
    """

    @staticmethod
    def _other_club_hold():
        from apps.clubs.models import Club
        from apps.facilities.models import Facility, FacilityType

        other = Club.objects.create(name="Far Club", code="FAR", is_active=True)
        activity = FacilityType.objects.create(
            name="Squash Court", price=Decimal("80.000"), duration_minutes=60,
            is_active=True)
        court = Facility.objects.create(name="Squash 1", club=other, is_active=True)
        court.facility_types.add(activity)
        hold, _token = reservations.acquire(
            club=other, facility_type=activity, slots=[(soon(), time(19, 0))])
        return other, hold

    @staticmethod
    def _manager_for(api, make_user, club):
        from apps.accounts.models import Role

        manager = make_user("desk@example.com", role=Role.MANAGER)
        manager.assigned_clubs.set([club])
        api.force_authenticate(user=manager)
        return manager

    def test_a_manager_sees_only_their_own_club(self, api, venue, make_user):
        mine = hold_for(venue)
        _other_club, theirs = self._other_club_hold()
        self._manager_for(api, make_user, venue["club"])

        rows = api.get(RESERVATIONS).data["results"]
        references = {row["reference"] for row in rows}
        assert mine.reference in references
        assert theirs.reference not in references

    def test_another_club_reservation_is_not_readable_by_id(
            self, api, venue, make_user):
        """Out of the listing is not enough: the detail route must refuse it
        too, or the reference from anywhere else is a key to the record."""
        _other_club, theirs = self._other_club_hold()
        self._manager_for(api, make_user, venue["club"])

        assert api.get(f"{RESERVATIONS}{theirs.id}/").status_code == 404

    def test_a_manager_cannot_release_another_club_court(
            self, api, venue, make_user):
        """The damaging half. Releasing puts a court back on sale and refuses
        the customer who is paying for it, at a club this user does not run."""
        _other_club, theirs = self._other_club_hold()
        self._manager_for(api, make_user, venue["club"])

        assert api.post(f"{RESERVATIONS}{theirs.id}/release/").status_code == 404
        theirs.refresh_from_db()
        assert theirs.status == HoldStatus.ACTIVE

    def test_an_admin_still_sees_every_club(self, auth_api, venue):
        """Scoping narrows the restricted, it does not blind the unrestricted."""
        mine = hold_for(venue)
        _other_club, theirs = self._other_club_hold()

        references = {row["reference"] for row in auth_api.get(RESERVATIONS).data["results"]}
        assert {mine.reference, theirs.reference} <= references
