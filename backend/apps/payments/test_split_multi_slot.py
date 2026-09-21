"""Splitting a multi-slot order between several people.

Three friends booking three slots used to produce nine payments and nine
invoices, leave all three slots reading "Partially paid" until the last person
paid, and give every slot three payers to unpick at refund time. Each share was
an amount of the ORDER spread proportionally across every slot, so one person
paying their third paid a third of each court.

Confirmed policy is now that a share settles WHOLE SLOTS, earliest first. The
money each person owes is unchanged; where it lands is not. These tests pin the
consequences, because every one of them is something an operator sees.
"""

from datetime import date, time, timedelta
from decimal import Decimal

import pytest

from apps.bookings import multi_slot
from apps.bookings.models import Booking, BookingStatus, BookingPolicy
from apps.bookings.services import booking_outstanding
from apps.payments import split as split_service
from apps.payments.models import Invoice, Payment, ShareStatus, SplitStatus

pytestmark = pytest.mark.django_db

MONDAY = date(2026, 6, 1)
SLOT_PRICE = Decimal("35.000")


def _open_all_week():
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture
def venue(db, tax_rate):
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.save()
    club = Club.objects.create(name="Split Club", code="SPLT", is_active=True,
                               booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Badminton Court", price=SLOT_PRICE, duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    court = Facility.objects.create(name="Court South 1", club=club, is_active=True)
    court.facility_types.add(activity)
    customer = Customer.objects.create(
        full_name="Mohammed Navab", email="navab@splitclub.sa",
        mobile_number="+966500000077")

    policy = BookingPolicy.objects.filter(is_default=True).first() or \
        BookingPolicy.objects.create(is_default=True)
    policy.allow_multiple_slots = True
    policy.max_slots_per_booking = 4
    policy.save()
    return {"club": club, "activity": activity, "court": court, "customer": customer}


@pytest.fixture
def order(venue):
    """One checkout, three consecutive slots, exactly as the screenshot shows."""
    booking_order, bookings = multi_slot.create_order(
        customer=venue["customer"], club=venue["club"],
        facility_type=venue["activity"],
        slots=[(MONDAY, time(9, 0)), (MONDAY, time(10, 0)), (MONDAY, time(11, 0))])
    return booking_order, bookings


def three_ways(booking_order, bookings):
    total = sum((booking_outstanding(b) for b in bookings), Decimal("0"))
    each = (total / 3).quantize(Decimal("0.001"))
    remainder = total - (each * 2)
    split, links = split_service.create_split(booking_order, [
        {"amount": each, "name": "Mohammed Navab", "email": "navab@splitclub.sa",
         "is_organizer": True},
        {"amount": each, "name": "Ahmed", "email": "ahmed@friends.sa"},
        {"amount": remainder, "name": "Omar", "email": "omar@friends.sa"},
    ])
    return split, links


def pay(links, share):
    return split_service.pay_share(links[share.id], method="cash")


def ordered_shares(split):
    return list(split.shares.order_by("position"))


class TestOneShareSettlesOneSlot:
    def test_the_first_payer_clears_the_first_slot_outright(self, order):
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        pay(links, ordered_shares(split)[0])

        first, second, third = [Booking.objects.get(pk=b.pk) for b in bookings]
        assert booking_outstanding(first) == 0
        assert booking_outstanding(second) == booking_outstanding(third) > 0

    def test_that_slot_confirms_itself_without_waiting_for_the_others(self, order):
        """The operator-visible half. All three slots sitting Pending until the
        last friend paid is what made a paid court look unpaid."""
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        pay(links, ordered_shares(split)[0])

        first = Booking.objects.get(pk=bookings[0].pk)
        assert first.status == BookingStatus.CONFIRMED
        assert Booking.objects.get(pk=bookings[1].pk).status == BookingStatus.BOOKED

    def test_each_slot_ends_with_one_payment_and_one_invoice(self, order):
        """The row count that started this: nine of each, for three slots."""
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        for share in ordered_shares(split):
            pay(links, share)

        ids = [b.pk for b in bookings]
        assert Payment.objects.filter(booking_id__in=ids).count() == 3
        assert Invoice.objects.filter(booking_id__in=ids).count() == 3
        for booking in bookings:
            assert Payment.objects.filter(booking_id=booking.pk).count() == 1

    def test_each_slot_has_exactly_one_payer(self, order):
        """What makes a per-slot refund answerable: one slot, one person to
        return the money to."""
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        for share in ordered_shares(split):
            pay(links, share)

        for booking in bookings:
            payments = Payment.objects.filter(booking_id=booking.pk)
            assert payments.count() == 1
            assert booking_outstanding(Booking.objects.get(pk=booking.pk)) == 0

    def test_everybody_still_pays_their_own_share_and_no_more(self, order):
        """The amounts are untouched by this change. Only where they land is."""
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        shares = ordered_shares(split)
        for share in shares:
            _paid_share, payment = pay(links, share)
            assert payment is not None

        collected = sum(
            (p.amount for p in Payment.objects.filter(
                booking_id__in=[b.pk for b in bookings])), Decimal("0"))
        assert collected == sum((s.amount for s in shares), Decimal("0"))

    def test_the_split_closes_once_every_slot_is_paid(self, order):
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        for share in ordered_shares(split):
            pay(links, share)

        split.refresh_from_db()
        assert split.status == SplitStatus.COMPLETED


class TestAShareThatDoesNotFitASlot:
    """Shares rarely line up with slot prices, and must not lose a halala."""

    def test_a_share_spanning_two_slots_takes_two_payments(self, order):
        booking_order, bookings = order
        total = sum((booking_outstanding(b) for b in bookings), Decimal("0"))
        one_slot = booking_outstanding(bookings[0])
        big = one_slot + Decimal("10.000")
        split, links = split_service.create_split(booking_order, [
            {"amount": big, "name": "Big payer", "is_organizer": True},
            {"amount": total - big, "name": "Small payer"},
        ])
        pay(links, ordered_shares(split)[0])

        assert Payment.objects.filter(booking_id=bookings[0].pk).count() == 1
        assert Payment.objects.filter(booking_id=bookings[1].pk).count() == 1
        assert booking_outstanding(Booking.objects.get(pk=bookings[0].pk)) == 0
        assert booking_outstanding(Booking.objects.get(pk=bookings[1].pk)) > 0

    def test_the_whole_order_still_balances_to_the_penny(self, order):
        booking_order, bookings = order
        total = sum((booking_outstanding(b) for b in bookings), Decimal("0"))
        split, links = split_service.create_split(booking_order, [
            {"amount": Decimal("40.000"), "name": "A", "is_organizer": True},
            {"amount": Decimal("40.000"), "name": "B"},
            {"amount": total - Decimal("80.000"), "name": "C"},
        ])
        for share in ordered_shares(split):
            pay(links, share)

        for booking in bookings:
            assert booking_outstanding(Booking.objects.get(pk=booking.pk)) == 0
        collected = sum(
            (p.amount for p in Payment.objects.filter(
                booking_id__in=[b.pk for b in bookings])), Decimal("0"))
        assert collected == total


class TestTheSlotTimelineTellsTheStory:
    """Split events used to go only to the order-level audit trail, so a slot's
    Booking Log said "payment recorded" with no hint that three people were
    paying for it, who still owed, or by when."""

    @staticmethod
    def notes(booking, event=None):
        rows = booking.status_history.all()
        if event:
            rows = rows.filter(event=event)
        return [r.note for r in rows]

    def test_every_slot_records_that_a_split_was_arranged(self, order):
        booking_order, bookings = order
        three_ways(booking_order, bookings)

        for booking in bookings:
            notes = self.notes(booking, "split_created")
            assert len(notes) == 1
            assert "3 people" in notes[0]

    def test_every_slot_records_each_payer_and_the_progress(self, order):
        """Including the slots that friend's money did not land on: "who still
        owes" is a fact about the arrangement, and staff open one slot."""
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        pay(links, ordered_shares(split)[0])

        for booking in bookings:
            notes = self.notes(booking, "split_share_paid")
            assert len(notes) == 1
            assert "Mohammed Navab" in notes[0]
            assert "1 of 3" in notes[0]

    def test_the_last_payment_records_completion_on_every_slot(self, order):
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        for share in ordered_shares(split):
            pay(links, share)

        for booking in bookings:
            assert len(self.notes(booking, "split_completed")) == 1

    def test_expiry_says_plainly_that_nothing_was_refunded(self, order):
        """Expiry is inert by confirmed policy, and a timeline that only said
        "expired" is what makes somebody go looking for a refund that was never
        issued."""
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        pay(links, ordered_shares(split)[0])
        split.expires_at = split.expires_at - timedelta(days=2)
        split.save(update_fields=["expires_at"])
        split_service.expire_due_splits()

        for booking in bookings:
            notes = self.notes(booking, "split_expired")
            assert len(notes) == 1
            assert "Nothing refunded" in notes[0]


class TestTheSlotShowsWhoIsPaying:
    """A multi-slot split belongs to the ORDER. The finance endpoint looked for
    one attached to the BOOKING, found none, and every slot of a split order
    showed no payers at all."""

    @staticmethod
    def finance(api, booking):
        response = api.get(f"/api/v1/bookings/{booking.pk}/finance/")
        assert response.status_code == 200, response.data
        return response.data

    def test_the_order_split_is_visible_from_every_slot(self, auth_api, order):
        booking_order, bookings = order
        three_ways(booking_order, bookings)

        for booking in bookings:
            splits = self.finance(auth_api, booking)["splits"]
            assert len(splits) == 1
            assert len(splits[0]["shares"]) == 3

    def test_it_names_every_payer_and_what_they_owe(self, auth_api, order):
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        pay(links, ordered_shares(split)[0])

        shares = self.finance(auth_api, bookings[2])["splits"][0]["shares"]
        by_name = {s["name"]: s for s in shares}
        assert by_name["Mohammed Navab"]["status"] == ShareStatus.PAID
        assert by_name["Ahmed"]["status"] == ShareStatus.PENDING
        assert by_name["Omar"]["status"] == ShareStatus.PENDING

    def test_a_single_slot_split_still_works(self, auth_api, venue):
        """The booking-level case the endpoint already handled. Widening the
        query to include the order must not have cost it."""
        booking = Booking.objects.create(
            customer=venue["customer"], club=venue["club"], facility=venue["court"],
            facility_type=venue["activity"], scheduled_date=MONDAY,
            scheduled_time=time(15, 0), end_time=time(16, 0), duration_minutes=60,
            status=BookingStatus.BOOKED, currency="SAR",
            total_amount=Decimal("100.000"))
        split_service.create_split(booking, [
            {"amount": Decimal("60.000"), "name": "Me", "is_organizer": True},
            {"amount": Decimal("40.000"), "name": "You"},
        ])

        splits = self.finance(auth_api, booking)["splits"]
        assert len(splits) == 1
        assert {s["name"] for s in splits[0]["shares"]} == {"Me", "You"}


class TestPayerContactsAreGated:
    """A participant's email and phone are a THIRD PARTY's contact details on
    somebody else's booking, so they need `payments.view_payer_contacts` on top
    of `payments.view`."""

    @staticmethod
    def shares_for(api, booking):
        response = api.get(f"/api/v1/bookings/{booking.pk}/finance/")
        assert response.status_code == 200, response.data
        return response.data["splits"][0]["shares"]

    def test_an_ordinary_admin_does_not_get_them_with_the_rest(self, order, api,
                                                               admin_user):
        """The point of making it opt-in: Admin holds everything else on this
        endpoint and still has to be granted this one deliberately."""
        booking_order, bookings = order
        three_ways(booking_order, bookings)
        api.force_authenticate(user=admin_user)

        shares = self.shares_for(api, bookings[0])
        assert shares, "an admin should still see WHO paid"
        assert all("email" not in share for share in shares)

    def test_the_system_owner_sees_them(self, api, order, make_user):
        from apps.accounts.models import Role

        booking_order, bookings = order
        three_ways(booking_order, bookings)
        api.force_authenticate(
            user=make_user("owner@example.com", role=Role.SUPER_ADMIN))

        by_name = {s["name"]: s for s in self.shares_for(api, bookings[0])}
        assert by_name["Ahmed"]["email"] == "ahmed@friends.sa"

    def test_a_manager_without_the_capability_does_not(self, api, order, make_user):
        from apps.accounts.models import Role

        booking_order, bookings = order
        three_ways(booking_order, bookings)

        manager = make_user("desk@example.com", role=Role.MANAGER)
        manager.assigned_clubs.set([bookings[0].club])
        api.force_authenticate(user=manager)

        shares = self.shares_for(api, bookings[0])
        assert shares, "the manager should still see WHO paid"
        for share in shares:
            # Absent, not blank: a key that is always present invites a UI that
            # renders an empty contact row and looks like no address was given.
            assert "email" not in share
            assert "phone" not in share

    def test_granting_the_capability_reveals_them(self, api, order, make_user):
        from apps.accounts.models import Role

        booking_order, bookings = order
        three_ways(booking_order, bookings)

        manager = make_user("desk2@example.com", role=Role.MANAGER)
        manager.assigned_clubs.set([bookings[0].club])
        manager.permission_overrides = {"grant": ["payments.view_payer_contacts"]}
        manager.save(update_fields=["permission_overrides"])
        api.force_authenticate(user=manager)

        shares = self.shares_for(api, bookings[0])
        by_name = {s["name"]: s for s in shares}
        assert by_name["Omar"]["email"] == "omar@friends.sa"

    def test_it_is_off_by_default_even_for_an_admin(self):
        """Opt-in, like cancelling an invoice or deleting a payment."""
        from apps.accounts.access import DEFAULT_ROLE_PERMISSIONS, OPT_IN_PERMISSIONS
        from apps.accounts.models import Role

        assert "payments.view_payer_contacts" in OPT_IN_PERMISSIONS
        assert ("payments.view_payer_contacts"
                not in DEFAULT_ROLE_PERMISSIONS[Role.ADMIN])


class TestLinksMustBeReachable:
    """A payment link is copied into a group chat and opened on somebody
    else's phone, so a loopback address in it is never right.

    `PUBLIC_WEBSITE_URL` defaults to localhost so a developer needs no
    configuration. Left unset on a server the links were issued anyway: they
    looked fine to the organizer, resolved for nobody, and the court stayed
    held while five people failed to pay for it.
    """

    def test_a_localhost_address_is_recognised_as_unusable(self):
        from apps.payments.split import site_url_configured

        assert not site_url_configured("http://localhost:4321")
        assert not site_url_configured("http://127.0.0.1:4321")
        assert not site_url_configured("http://0.0.0.0:4321")
        assert not site_url_configured("")

    def test_a_real_address_is_not(self):
        from apps.payments.split import site_url_configured

        assert site_url_configured("https://www.example.com")
        # A hostname that merely STARTS with "localhost" is a real host.
        assert site_url_configured("https://localhost.example.com")

    def test_production_refuses_the_arrangement_rather_than_issue_dead_links(
            self, settings, order):
        booking_order, bookings = order
        settings.DEBUG = False
        settings.PUBLIC_WEBSITE_URL = "http://localhost:4321"

        with pytest.raises(split_service.SplitError) as exc:
            three_ways(booking_order, bookings)
        assert exc.value.code == "site_not_configured"

    def test_nothing_is_written_when_it_refuses(self, settings, order):
        """Before any row exists, so a misconfigured server leaves no orphaned
        arrangement holding a court."""
        from apps.payments.models import BookingPaymentSplit

        booking_order, bookings = order
        settings.DEBUG = False
        settings.PUBLIC_WEBSITE_URL = "http://localhost:4321"

        with pytest.raises(split_service.SplitError):
            three_ways(booking_order, bookings)
        assert BookingPaymentSplit.objects.count() == 0

    def test_a_configured_address_is_what_the_link_carries(self, settings, order):
        booking_order, bookings = order
        settings.DEBUG = False
        settings.PUBLIC_WEBSITE_URL = "https://www.example.com/"

        split, links = three_ways(booking_order, bookings)
        url = split_service.share_link(links[ordered_shares(split)[1].id])
        assert url.startswith("https://www.example.com/pay/split/")
        assert "localhost" not in url

    def test_a_developer_is_left_alone(self, settings, order):
        """DEBUG is a developer machine, where localhost is the right answer."""
        booking_order, bookings = order
        settings.DEBUG = True
        settings.PUBLIC_WEBSITE_URL = "http://localhost:4321"

        split, links = three_ways(booking_order, bookings)
        assert split_service.share_link(
            links[ordered_shares(split)[1].id]).startswith("http://localhost:4321/")

    def test_the_deploy_check_reports_it(self, settings):
        from apps.payments.apps import check_public_website_url

        settings.DEBUG = False
        settings.PUBLIC_WEBSITE_URL = "http://localhost:4321"
        errors = check_public_website_url(None)
        assert [e.id for e in errors] == ["payments.E001"]

        settings.PUBLIC_WEBSITE_URL = "https://www.example.com"
        assert check_public_website_url(None) == []


class TestStaffCanPassOnAPaymentLink:
    """Reception cannot read out the link the customer was given: raw tokens
    are never stored, only digests. Issuing a fresh one is the only honest
    recovery, and it stops the previous link working."""

    URL = "/api/v1/bookings/{}/split-share-link/"

    def test_it_issues_a_working_link_for_an_unpaid_share(self, auth_api, order):
        booking_order, bookings = order
        split, _links = three_ways(booking_order, bookings)
        unpaid = ordered_shares(split)[1]

        resp = auth_api.post(self.URL.format(bookings[0].pk),
                             {"share": unpaid.id}, format="json")
        assert resp.status_code == 200, resp.data
        assert "/pay/split/" in resp.data["url"]
        assert resp.data["name"] == "Ahmed"

        token = resp.data["url"].rstrip("/").split("/")[-1]
        assert split_service.resolve_share(token).id == unpaid.id

    def test_the_previous_link_stops_working(self, auth_api, order):
        """The point when a link has leaked, and a trap when reception is only
        being helpful, so the UI has to say so."""
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        unpaid = ordered_shares(split)[1]
        old_token = links[unpaid.id]

        auth_api.post(self.URL.format(bookings[0].pk),
                      {"share": unpaid.id}, format="json")
        assert split_service.resolve_share(old_token) is None

    def test_it_works_from_any_slot_of_the_order(self, auth_api, order):
        booking_order, bookings = order
        split, _links = three_ways(booking_order, bookings)
        unpaid = ordered_shares(split)[2]

        resp = auth_api.post(self.URL.format(bookings[2].pk),
                             {"share": unpaid.id}, format="json")
        assert resp.status_code == 200, resp.data

    def test_a_paid_share_is_refused(self, auth_api, order):
        booking_order, bookings = order
        split, links = three_ways(booking_order, bookings)
        paid_share = ordered_shares(split)[0]
        pay(links, paid_share)

        resp = auth_api.post(self.URL.format(bookings[0].pk),
                             {"share": paid_share.id}, format="json")
        assert resp.status_code == 400
        assert resp.data["code"] == "already_paid"

    def test_a_share_from_another_booking_is_not_found(self, auth_api, order, venue):
        """An id in the request body must not be a way to mint a link for
        somebody else booking."""
        booking_order, bookings = order
        split, _links = three_ways(booking_order, bookings)
        stranger = Booking.objects.create(
            customer=venue["customer"], club=venue["club"], facility=venue["court"],
            facility_type=venue["activity"], scheduled_date=MONDAY,
            scheduled_time=time(20, 0), end_time=time(21, 0), duration_minutes=60,
            status=BookingStatus.BOOKED, currency="SAR",
            total_amount=Decimal("50.000"))

        resp = auth_api.post(self.URL.format(stranger.pk),
                             {"share": ordered_shares(split)[1].id}, format="json")
        assert resp.status_code == 404

    def test_it_needs_permission_to_take_payments(self, api, order, make_user):
        from apps.accounts.models import Role

        booking_order, bookings = order
        split, _links = three_ways(booking_order, bookings)
        staff = make_user("floor@example.com", role=Role.FACILITY_STAFF)
        staff.assigned_clubs.set([bookings[0].club])
        api.force_authenticate(user=staff)

        resp = api.post(self.URL.format(bookings[0].pk),
                        {"share": ordered_shares(split)[1].id}, format="json")
        assert resp.status_code == 403

    def test_the_reissue_is_on_the_booking_timeline(self, auth_api, order):
        booking_order, bookings = order
        split, _links = three_ways(booking_order, bookings)
        auth_api.post(self.URL.format(bookings[0].pk),
                      {"share": ordered_shares(split)[1].id}, format="json")

        notes = [r.note for r in bookings[0].status_history.filter(
            event="split_share_link_reissued")]
        assert len(notes) == 1
        assert "Ahmed" in notes[0]
