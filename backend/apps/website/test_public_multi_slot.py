"""Booking several slots from the public website, end to end over HTTP.

`apps/bookings/test_multi_slot.py` covers the engine. This file covers the
customer-facing contract: what the availability payload promises, what the
order endpoint accepts and refuses, and what actually happens to the money.

The cases that matter here are the ones where the website's view of the rules
and the backend's view could drift apart, because that drift is what lets a
customer select something the server will then refuse.
"""

from datetime import date, timedelta
from decimal import Decimal

import pytest

from apps.bookings.models import Booking, BookingOrder, BookingPolicy
from apps.payments.gateway import CARD_APPROVED, CARD_DECLINED
from apps.payments.models import BookingPaymentSplit, Invoice, Payment

pytestmark = pytest.mark.django_db

AVAILABILITY = "/api/v1/website/public/availability/"
ORDERS = "/api/v1/website/public/orders/"


def _open_all_week():
    from apps.settings_app.models import BOOKING_DAY_KEYS
    return {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture
def demo_mode(settings):
    settings.PAYMENT_MODE = "demo"
    settings.PAYMENT_ALLOW_DEMO = True
    return settings


@pytest.fixture
def venue(db, tax_rate):
    """One club, one activity, two courts that can both serve it."""
    from apps.clubs.models import Club
    from apps.facilities.models import Facility, FacilityType
    from apps.settings_app.models import Organization

    org = Organization.get_solo()
    org.booking_hours = _open_all_week()
    org.save()

    club = Club.objects.create(name="Nadena Club", is_active=True,
                               booking_hours=_open_all_week())
    activity = FacilityType.objects.create(
        name="Badminton Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    courts = []
    for name in ("Navab", "Court Two"):
        court = Facility.objects.create(name=name, club=club, is_active=True)
        court.facility_types.add(activity)
        courts.append(court)
    return {"club": club, "activity": activity, "courts": courts}


def allow_org(**overrides):
    policy = (BookingPolicy.objects.filter(is_default=True).first()
              or BookingPolicy.objects.create(is_default=True))
    for key, value in {"allow_multiple_slots": True, "allow_multiple_dates": True,
                       "max_slots_per_booking": 5, **overrides}.items():
        setattr(policy, key, value)
    policy.save()
    return policy


def a_date(days_ahead=10):
    from django.utils import timezone
    return timezone.localdate() + timedelta(days=days_ahead)


def order_payload(venue, times, on=None, **extra):
    day = (on or a_date()).isoformat()
    return {
        "club": venue["club"].id,
        "facility_type": venue["activity"].id,
        "slots": [{"date": day, "time": t} if isinstance(t, str) else
                  {"date": t[0].isoformat(), "time": t[1]} for t in times],
        "name": "Layla Ahmed",
        "email": "layla@nadena.sa",
        "phone": "+966500000011",
        **extra,
    }


# --------------------------------------------------------------------------- #
# What the website is told (phase 3)
# --------------------------------------------------------------------------- #
class TestAvailabilityCarriesTheRules:
    def _rules(self, api, venue):
        resp = api.get(AVAILABILITY, {
            "club": venue["club"].id, "facility_type": venue["activity"].id,
            "date": a_date().isoformat()})
        assert resp.status_code == 200, resp.content
        return resp.json()["slot_rules"]

    def test_a_fresh_install_offers_one_slot(self, api, venue):
        rules = self._rules(api, venue)
        assert rules["allow_multiple_slots"] is False
        assert rules["max_slots_per_booking"] == 1

    def test_the_organization_rule_reaches_the_website(self, api, venue):
        allow_org(max_slots_per_booking=4)
        rules = self._rules(api, venue)
        assert rules["allow_multiple_slots"] is True
        assert rules["max_slots_per_booking"] == 4

    def test_a_facility_override_reaches_the_website(self, api, venue):
        """The reported case: multi-slot switched on for one court only.

        The customer picks an activity, not a court, so a rule set on the only
        court that can serve it still has to reach them.
        """
        venue["courts"][1].delete()
        BookingPolicy.objects.create(facility=venue["courts"][0],
                                     allow_multiple_slots=True,
                                     max_slots_per_booking=10)
        rules = self._rules(api, venue)
        assert rules["allow_multiple_slots"] is True
        assert rules["max_slots_per_booking"] == 10

    def test_the_offer_is_the_union_when_courts_disagree(self, api, venue):
        """One permissive court is enough to offer multi-slot.

        Offering the strictest instead would refuse a selection the free court
        could have honoured. The allocation is re-checked after the fact.
        """
        BookingPolicy.objects.create(facility=venue["courts"][0],
                                     allow_multiple_slots=True,
                                     max_slots_per_booking=6)
        rules = self._rules(api, venue)
        assert rules["allow_multiple_slots"] is True
        assert rules["max_slots_per_booking"] == 6

    def test_rules_are_not_invented_for_a_club_with_no_courts(self, api, venue):
        for court in venue["courts"]:
            court.delete()
        rules = self._rules(api, venue)
        assert rules["allow_multiple_slots"] is False


# --------------------------------------------------------------------------- #
# Creating the order (phase 5)
# --------------------------------------------------------------------------- #
class TestCreatingAnOrder:
    def test_several_slots_become_one_order(self, api, venue):
        allow_org()
        resp = api.post(ORDERS, order_payload(venue, ["09:00", "10:00", "11:00"]),
                        format="json")
        assert resp.status_code == 201, resp.content
        body = resp.json()
        assert body["slot_count"] == 3
        assert body["order_reference"].startswith("ORD-")
        assert len(body["bookings"]) == 3

        order = BookingOrder.objects.get(reference=body["order_reference"])
        assert order.bookings.count() == 3
        # Every slot is an ordinary booking, with its own reference and price.
        assert all(b.reference.startswith("BK-") for b in order.bookings.all())
        assert order.total_amount == sum(
            (b.total_amount for b in order.bookings.all()), Decimal("0"))

    def test_one_slot_through_the_order_endpoint_still_works(self, api, venue):
        allow_org()
        resp = api.post(ORDERS, order_payload(venue, ["09:00"]), format="json")
        assert resp.status_code == 201, resp.content
        assert resp.json()["slot_count"] == 1

    def test_multi_slot_is_refused_when_the_rules_forbid_it(self, api, venue):
        resp = api.post(ORDERS, order_payload(venue, ["09:00", "10:00"]),
                        format="json")
        assert resp.status_code == 400
        assert resp.json()["code"] == "multiple_not_allowed"
        assert not BookingOrder.objects.exists()

    def test_too_many_slots_are_refused(self, api, venue):
        allow_org(max_slots_per_booking=2)
        resp = api.post(ORDERS, order_payload(venue, ["09:00", "10:00", "11:00"]),
                        format="json")
        assert resp.status_code == 400
        assert "up to 2" in resp.json()["detail"]
        assert not BookingOrder.objects.exists()

    def test_spanning_dates_is_refused_when_not_allowed(self, api, venue):
        allow_org(allow_multiple_dates=False)
        resp = api.post(ORDERS, order_payload(
            venue, [(a_date(), "09:00"), (a_date(11), "09:00")]), format="json")
        assert resp.status_code == 400
        assert "same date" in resp.json()["detail"]

    def test_a_gap_is_refused_when_back_to_back_is_required(self, api, venue):
        allow_org(require_consecutive_slots=True)
        resp = api.post(ORDERS, order_payload(venue, ["09:00", "11:00"]),
                        format="json")
        assert resp.status_code == 400
        assert "back to back" in resp.json()["detail"]

    def test_an_unavailable_slot_names_itself(self, api, venue):
        """Two courts, so the third booking of one hour is the one that fails."""
        allow_org()
        day = a_date()
        api.post(ORDERS, order_payload(venue, ["09:00"], on=day,
                                       email="a@nadena.sa", phone="+966500000021"),
                 format="json")
        api.post(ORDERS, order_payload(venue, ["09:00"], on=day,
                                       email="b@nadena.sa", phone="+966500000022"),
                 format="json")
        resp = api.post(ORDERS, order_payload(venue, ["09:00", "10:00"], on=day,
                                              email="c@nadena.sa",
                                              phone="+966500000023"),
                        format="json")
        assert resp.status_code == 409
        assert resp.json()["code"] == "slot_unavailable"
        # Named per slot, so the customer changes one time rather than starting over.
        assert [s["time"] for s in resp.json()["slots"]] == ["09:00"]

    def test_nothing_is_written_when_one_slot_fails(self, api, venue):
        allow_org(max_slots_per_booking=2)
        before = Booking.objects.count()
        api.post(ORDERS, order_payload(venue, ["09:00", "10:00", "11:00"]),
                 format="json")
        assert Booking.objects.count() == before
        assert not BookingOrder.objects.exists()

    def test_the_same_customer_cannot_double_book_a_slot(self, api, venue):
        allow_org()
        day = a_date()
        first = api.post(ORDERS, order_payload(venue, ["09:00"], on=day),
                         format="json")
        assert first.status_code == 201
        again = api.post(ORDERS, order_payload(venue, ["09:00", "10:00"], on=day),
                         format="json")
        assert again.status_code == 409
        assert again.json()["code"] == "already_booked"

    def test_an_allocation_that_breaks_a_courts_own_cap_is_refused(self, api, venue):
        """The other half of the permissive offer.

        The generous court allows five slots, the strict one allows two, so the
        offer is five. Then the generous court goes out for maintenance, every
        slot lands on the strict one, and the order must be refused rather than
        quietly overfilling a court that caps itself.
        """
        from apps.facilities.models import MaintenanceBlock

        generous, strict = venue["courts"]
        BookingPolicy.objects.create(facility=generous, allow_multiple_slots=True,
                                     max_slots_per_booking=5)
        BookingPolicy.objects.create(facility=strict, max_slots_per_booking=2)
        day = a_date()
        MaintenanceBlock.objects.create(facility=generous, start_date=day,
                                        end_date=day, reason="Resurfacing")

        resp = api.post(ORDERS, order_payload(
            venue, ["09:00", "10:00", "11:00"], on=day), format="json")
        assert resp.status_code == 400
        assert resp.json()["code"] == "facility_rules"
        # Atomic: the first two slots are not left behind.
        assert not BookingOrder.objects.exists()
        assert not Booking.objects.exists()


# --------------------------------------------------------------------------- #
# Paying for it
# --------------------------------------------------------------------------- #
@pytest.mark.usefixtures("demo_mode")
class TestPayingForAnOrder:
    def _card(self, number=CARD_APPROVED):
        return {"method": "card", "card": {
            "number": number, "holder": "Layla Ahmed",
            "expiry_month": 12, "expiry_year": 2031, "cvv": "123"}}

    def test_pay_at_venue_collects_nothing(self, api, venue):
        allow_org()
        resp = api.post(ORDERS, order_payload(venue, ["09:00", "10:00"]),
                        format="json")
        assert resp.json()["payment"]["status"] == "due_at_venue"
        assert not Payment.objects.exists()

    def test_a_card_pays_every_slot_and_invoices_each(self, api, venue):
        allow_org()
        resp = api.post(ORDERS, order_payload(
            venue, ["09:00", "10:00"], payment=self._card()), format="json")
        assert resp.status_code == 201, resp.content
        payment = resp.json()["payment"]
        assert payment["status"] == "paid"
        assert payment["slots_paid"] == 2
        assert Decimal(payment["outstanding"]) == Decimal("0")
        # One invoice per slot: that is what makes a per-slot refund possible.
        assert len(payment["invoices"]) == 2
        assert Invoice.objects.count() == 2

        order = BookingOrder.objects.get()
        for booking in order.bookings.all():
            assert booking.payment_status == "paid"

    def test_a_declined_card_leaves_every_slot_standing_and_unpaid(self, api, venue):
        allow_org()
        resp = api.post(ORDERS, order_payload(
            venue, ["09:00", "10:00"], payment=self._card(CARD_DECLINED)),
            format="json")
        assert resp.status_code == 201, resp.content
        payment = resp.json()["payment"]
        assert payment["status"] == "failed"
        assert payment["slots_paid"] == 0
        # The slots are kept: losing the reservation because a card bounced
        # would be worse than an unpaid booking.
        assert BookingOrder.objects.get().bookings.count() == 2
        assert Invoice.objects.count() == 0

    def test_the_confirmation_screen_can_settle_the_order_later(self, api, venue):
        allow_org()
        created = api.post(ORDERS, order_payload(venue, ["09:00", "10:00"]),
                           format="json").json()
        resp = api.post("/api/v1/website/public/booking-pay/", {
            "checkout_token": created["checkout_token"],
            **self._card()}, format="json")
        assert resp.status_code == 200, resp.content
        assert resp.json()["status"] == "paid"
        assert Decimal(resp.json()["outstanding"]) == Decimal("0")

    def test_an_expired_or_forged_token_pays_nothing(self, api, venue):
        resp = api.post("/api/v1/website/public/booking-pay/",
                        {"checkout_token": "not-a-real-token", **self._card()},
                        format="json")
        assert resp.status_code == 400
        assert resp.json()["code"] == "invalid_session"
        assert not Payment.objects.exists()


# --------------------------------------------------------------------------- #
# Splitting a multi-slot order
# --------------------------------------------------------------------------- #
@pytest.mark.usefixtures("demo_mode")
class TestSplittingAnOrder:
    def _split_payload(self, venue, people=2):
        return order_payload(venue, ["09:00", "10:00"], payment={
            "method": "split",
            "split": {"mode": "equal", "people": people, "include_me": True,
                      "friends": [{"name": "Omar", "email": "omar@nadena.sa"}]},
        })

    def test_a_split_is_arranged_over_the_whole_order(self, api, venue):
        allow_org()
        resp = api.post(ORDERS, self._split_payload(venue), format="json")
        assert resp.status_code == 201, resp.content
        payment = resp.json()["payment"]
        assert payment["status"] == "started"

        split = BookingPaymentSplit.objects.get()
        # It hangs off the order, not off one arbitrary slot.
        assert split.order_id == BookingOrder.objects.get().id
        assert split.booking_id is None
        # The whole order's balance is allocated, not one slot's.
        assert split.amount_allocated == BookingOrder.objects.get().total_amount

    def test_the_payer_sees_every_slot_they_are_paying_for(self, api, venue):
        allow_org()
        body = api.post(ORDERS, self._split_payload(venue), format="json").json()
        share_link = list(body["payment"]["links"].values())[0]
        token = share_link.rstrip("/").split("/")[-1]

        resp = api.get(f"/api/v1/website/public/split/{token}/")
        assert resp.status_code == 200, resp.content
        summary = resp.json()["booking"]
        assert summary["reference"].startswith("ORD-")
        assert summary["slot_count"] == 2
        assert len(summary["slots"]) == 2

    def test_one_share_spreads_across_the_slots(self, api, venue):
        """Confirmed policy: a share is an amount of the order.

        Paying half of a two-slot order therefore pays half of each slot, and
        each part raises its own invoice, so a later per-slot refund returns
        what that slot's payers actually put in.
        """
        allow_org()
        body = api.post(ORDERS, self._split_payload(venue), format="json").json()
        share_link = list(body["payment"]["links"].values())[0]
        token = share_link.rstrip("/").split("/")[-1]

        resp = api.post(f"/api/v1/website/public/split/{token}/", {
            "card": {"number": CARD_APPROVED, "holder": "Omar",
                     "expiry_month": 12, "expiry_year": 2031, "cvv": "123"}},
            format="json")
        assert resp.status_code == 200, resp.content

        order = BookingOrder.objects.get()
        # Both slots received part of the one share.
        assert Payment.objects.count() == 2
        assert Invoice.objects.count() == 2
        paid = sum((p.amount for p in Payment.objects.all()), Decimal("0"))
        assert paid == order.total_amount / 2
        # And no slot was overpaid.
        from apps.bookings.services import booking_amount_paid
        for booking in order.bookings.all():
            assert booking_amount_paid(booking) <= booking.total_amount

    def test_the_split_closes_once_the_order_owes_nothing(self, api, venue):
        allow_org()
        body = api.post(ORDERS, self._split_payload(venue), format="json").json()
        for link in body["payment"]["links"].values():
            token = link.rstrip("/").split("/")[-1]
            api.post(f"/api/v1/website/public/split/{token}/", {
                "card": {"number": CARD_APPROVED, "holder": "Payer",
                         "expiry_month": 12, "expiry_year": 2031, "cvv": "123"}},
                format="json")
        manage = body["payment"]["manage_token"]
        resp = api.get(f"/api/v1/website/public/split/manage/{manage}/")
        assert resp.status_code == 200, resp.content
        assert Decimal(resp.json()["outstanding"]) == Decimal("0")

    def test_a_single_slot_split_is_unchanged(self, api, venue):
        """The old shape still attaches to the booking, not to an order."""
        allow_org()
        body = api.post("/api/v1/website/public/bookings/", {
            "club": venue["club"].id, "facility_type": venue["activity"].id,
            "date": a_date().isoformat(), "time": "09:00",
            "name": "Layla Ahmed", "email": "layla@nadena.sa",
            "phone": "+966500000011",
            "payment": {"method": "split", "split": {
                "mode": "equal", "people": 2, "include_me": True,
                "friends": [{"name": "Omar"}]}},
        }, format="json").json()
        assert body["payment"]["status"] == "started"
        split = BookingPaymentSplit.objects.get()
        assert split.booking_id is not None
        assert split.order_id is None
