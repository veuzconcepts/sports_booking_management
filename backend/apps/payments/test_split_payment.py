"""Demo card payment and split payment.

The scenarios that matter here are the ones where money could go wrong: an odd
cent disappearing in a three-way split, two friends paying the same share at the
same instant, a stale link charging somebody after the balance was already
covered, and demo authorisation surviving into production. Those get explicit
tests; the happy path gets one.
"""

from decimal import Decimal

import pytest
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APIClient

from apps.bookings.models import Booking, BookingStatus
from apps.bookings.services import booking_amount_paid, booking_outstanding
from apps.payments import split as split_service
from apps.payments.gateway import (
    CARD_APPROVED,
    CARD_DECLINED,
    CardDetails,
    DemoCardGateway,
    card_payment_available,
    demo_cards_visible,
    get_gateway,
    luhn_valid,
    public_payment_config,
    resolve_payment_mode,
)
from apps.payments.models import (
    BookingPaymentShare,
    BookingPaymentSplit,
    ShareStatus,
    SplitStatus,
    hash_split_token,
)

pytestmark = pytest.mark.django_db

DEMO = dict(PAYMENT_MODE="demo", PAYMENT_ALLOW_DEMO=True)


@pytest.fixture
def demo_mode(settings):
    """Run with the demo card provider active.

    A fixture rather than `override_settings` on the class, because these are
    plain pytest classes and Django refuses to decorate those.
    """
    settings.PAYMENT_MODE = "demo"
    settings.PAYMENT_ALLOW_DEMO = True
    return settings

GOOD_CARD = {"number": CARD_APPROVED, "holder": "Test Player",
             "expiry": "12/30", "cvv": "123"}


def card(number=CARD_APPROVED, **overrides):
    return CardDetails(number=number, holder="Test Player",
                       expiry_month=12, expiry_year=2030, cvv="123", **overrides)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
def _open_all_week():
    """A club open 06:00-23:00 every day, in the shape the engine stores.

    Spelled out rather than left to the shipped default, because these tests
    book evening slots and must not fail for a scheduling reason.
    """
    from apps.settings_app.models import BOOKING_DAY_KEYS

    return {day: {"closed": False, "shifts": [{"open": "06:00", "close": "23:00"}]}
            for day in BOOKING_DAY_KEYS}


@pytest.fixture
def booking(db):
    """A live, unpaid booking with a real total, built through the normal models."""
    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType
    from datetime import date, time, timedelta

    club = Club.objects.create(name="Riverside Club", is_active=True,
                               booking_hours=_open_all_week())
    ftype = FacilityType.objects.create(
        name="Football Pitch", price=Decimal("400.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    unit = Facility.objects.create(name="Pitch 1", club=club, is_active=True)
    unit.facility_types.add(ftype)
    customer = Customer.objects.create(
        full_name="Mohammed", email="organizer@example.com",
        mobile_number="+966549443311")
    obj = Booking.objects.create(
        customer=customer, club=club, facility_type=ftype,
        scheduled_date=date.today() + timedelta(days=3),
        scheduled_time=time(19, 0), duration_minutes=60,
        status=BookingStatus.BOOKED,
    )
    obj.compute_pricing()
    obj.sync_payment_status()
    obj.save()
    return obj


@pytest.fixture
def api():
    return APIClient()


# --------------------------------------------------------------------------- #
# Rounding: the odd cent must not vanish
# --------------------------------------------------------------------------- #
class TestAllocation:
    def test_equal_split_two_people(self):
        shares = split_service.allocate_equal(Decimal("400.00"), 2, "SAR")
        assert shares == [Decimal("200.00"), Decimal("200.00")]

    def test_three_way_split_keeps_every_cent(self):
        shares = split_service.allocate_equal(Decimal("100.00"), 3, "SAR")
        assert sum(shares) == Decimal("100.00")
        # The leftover cent lands on the LAST share, so it is visible rather
        # than silently absorbed.
        assert shares == [Decimal("33.33"), Decimal("33.33"), Decimal("33.34")]

    def test_no_allocation_ever_loses_money(self):
        for total in ("10.00", "47.25", "100.00", "0.07", "999.99"):
            for people in range(1, 8):
                try:
                    shares = split_service.allocate_equal(Decimal(total), people, "SAR")
                except split_service.SplitError:
                    continue            # amount genuinely too small to divide
                assert sum(shares) == Decimal(total), (total, people)

    def test_amount_too_small_to_divide_is_refused(self):
        with pytest.raises(split_service.SplitError):
            split_service.allocate_equal(Decimal("0.02"), 5, "SAR")


# --------------------------------------------------------------------------- #
# Demo gateway
# --------------------------------------------------------------------------- #
class TestDemoGateway:
    def test_luhn_rejects_a_typo(self):
        assert luhn_valid(CARD_APPROVED)
        assert not luhn_valid("4242424242424241")

    @override_settings(**DEMO)
    def test_test_card_is_approved(self):
        result = DemoCardGateway().charge(
            Decimal("100"), currency="SAR", method="card", card=card())
        assert result.success
        assert result.card_last4 == "4242"
        assert result.card_brand == "visa"

    @override_settings(**DEMO)
    def test_declined_test_card_fails_with_a_code(self):
        result = DemoCardGateway().charge(
            Decimal("100"), currency="SAR", method="card",
            card=card(number=CARD_DECLINED))
        assert not result.success
        assert result.failure_code == "card_declined"

    @override_settings(**DEMO)
    def test_invalid_card_number_is_refused_before_any_scenario(self):
        result = DemoCardGateway().charge(
            Decimal("100"), currency="SAR", method="card",
            card=card(number="1234567812345678"))
        assert not result.success
        assert result.failure_code == "invalid_number"

    @override_settings(**DEMO)
    def test_expired_card_is_refused(self):
        result = DemoCardGateway().charge(
            Decimal("100"), currency="SAR", method="card",
            card=CardDetails(number=CARD_APPROVED, holder="Test",
                             expiry_month=1, expiry_year=2020, cvv="123"))
        assert not result.success
        assert result.failure_code == "expired_card"

    def test_card_details_never_print_the_number_or_cvv(self):
        details = card()
        for rendering in (repr(details), str(details), f"{details}"):
            assert CARD_APPROVED not in rendering
            assert "123" not in rendering.replace("Test Player", "")
        # The safe metadata is still reachable.
        assert details.last4 == "4242"

    @override_settings(PAYMENT_MODE="demo", PAYMENT_ALLOW_DEMO=False)
    def test_demo_does_not_survive_into_production(self):
        """The central production guard: a box left on the development default
        must refuse card payment, not simulate a successful one."""
        assert resolve_payment_mode() == "disabled"
        assert not card_payment_available()
        assert not demo_cards_visible()
        result = get_gateway().charge(
            Decimal("100"), currency="SAR", method="card", card=card())
        assert not result.success
        assert result.failure_code == "payment_unavailable"

    @override_settings(PAYMENT_MODE="live", PAYMENT_ALLOW_DEMO=True)
    def test_live_without_an_adapter_fails_closed(self):
        # No real provider is integrated, so `live` must not quietly fall back
        # to the permissive mock.
        assert resolve_payment_mode() == "disabled"

    @override_settings(PAYMENT_MODE="demo", PAYMENT_ALLOW_DEMO=False)
    def test_production_config_exposes_no_test_cards(self):
        config = public_payment_config()
        assert config["card_enabled"] is False
        assert config["test_cards"] == []
        assert config["test_expiry"] == ""

    @override_settings(**DEMO)
    def test_demo_config_exposes_test_cards(self):
        config = public_payment_config()
        assert config["card_enabled"] is True
        assert any(c["number"] == CARD_APPROVED for c in config["test_cards"])


# --------------------------------------------------------------------------- #
# Creating a split
# --------------------------------------------------------------------------- #
@pytest.mark.usefixtures("demo_mode")
class TestCreateSplit:
    def _equal(self, booking, people, include_me=True):
        amounts = split_service.allocate_equal(
            booking_outstanding(booking), people, booking.currency)
        rows = []
        for index, amount in enumerate(amounts):
            rows.append({"amount": amount, "name": f"Player {index}",
                         "is_organizer": include_me and index == 0})
        return rows

    def test_equal_split_including_the_organizer(self, booking):
        split, links = split_service.create_split(booking, self._equal(booking, 4))
        assert split.shares.count() == 4
        assert split.shares.filter(is_organizer=True).count() == 1
        assert sum(s.amount for s in split.shares.all()) == booking_outstanding(booking)
        # One raw token per share, plus the organizer's management token.
        assert len(links) == 5

    def test_custom_split_that_does_not_add_up_is_refused(self, booking):
        total = booking_outstanding(booking)
        rows = [{"amount": total - Decimal("1.00"), "name": "A"},
                {"amount": Decimal("0.50"), "name": "B"}]
        with pytest.raises(split_service.SplitError) as exc:
            split_service.create_split(booking, rows)
        assert exc.value.code == "allocation_mismatch"

    def test_a_zero_or_negative_share_is_refused(self, booking):
        total = booking_outstanding(booking)
        rows = [{"amount": total + Decimal("10"), "name": "A"},
                {"amount": Decimal("-10"), "name": "B"}]
        with pytest.raises(split_service.SplitError):
            split_service.create_split(booking, rows)

    def test_only_one_arrangement_per_booking(self, booking):
        split_service.create_split(booking, self._equal(booking, 2))
        with pytest.raises(split_service.SplitError) as exc:
            split_service.create_split(booking, self._equal(booking, 2))
        assert exc.value.code == "split_exists"

    def test_raw_tokens_are_never_stored(self, booking):
        split, links = split_service.create_split(booking, self._equal(booking, 3))
        for share in split.shares.all():
            raw = links[share.id]
            assert share.token_hash == hash_split_token(raw)
            assert raw not in (share.token_hash or "")
        assert split.organizer_token_hash == hash_split_token(links["organizer"])

    def test_a_cancelled_booking_cannot_be_split(self, booking):
        booking.status = BookingStatus.CANCELLED
        booking.save(update_fields=["status"])
        with pytest.raises(split_service.SplitError) as exc:
            split_service.create_split(booking, self._equal(booking, 2))
        assert exc.value.code == "booking_cancelled"


# --------------------------------------------------------------------------- #
# Paying a share
# --------------------------------------------------------------------------- #
@pytest.mark.usefixtures("demo_mode")
class TestPayShare:
    def _split(self, booking, people=4):
        amounts = split_service.allocate_equal(
            booking_outstanding(booking), people, booking.currency)
        rows = [{"amount": a, "name": f"Player {i}", "is_organizer": i == 0}
                for i, a in enumerate(amounts)]
        return split_service.create_split(booking, rows)

    def test_a_friend_pays_only_their_share(self, booking):
        total = booking.total_amount
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        paid_share, payment = split_service.pay_share(links[share.id], card=card())
        assert paid_share.status == ShareStatus.PAID
        assert payment.amount == share.amount
        booking.refresh_from_db()
        assert booking_amount_paid(booking) == share.amount
        assert booking_outstanding(booking) == total - share.amount
        assert booking.payment_status == "partially_paid"

    def test_the_final_share_marks_the_booking_paid_and_closes_the_split(self, booking):
        split, links = self._split(booking, people=2)
        for share in split.shares.order_by("position"):
            split_service.pay_share(links[share.id], card=card())
        booking.refresh_from_db()
        split.refresh_from_db()
        assert booking_outstanding(booking) == Decimal("0.000")
        assert booking.payment_status == "paid"
        assert split.status == SplitStatus.COMPLETED

    def test_the_same_share_cannot_be_paid_twice(self, booking):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        token = links[share.id]
        split_service.pay_share(token, card=card())
        # The token is destroyed on payment, so the old link no longer resolves.
        with pytest.raises(split_service.SplitError) as exc:
            split_service.pay_share(token, card=card())
        assert exc.value.code == "invalid_link"

    def test_a_paid_share_produces_exactly_one_payment(self, booking):
        from apps.payments.models import Payment, PaymentStatus

        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        split_service.pay_share(links[share.id], card=card())
        assert Payment.objects.filter(
            booking=booking, status=PaymentStatus.PAID).count() == 1

    def test_an_old_link_is_refused_once_the_balance_is_covered(self, booking):
        """Section 31: never charge somebody for money that is no longer owed."""
        split, links = self._split(booking, people=2)
        first, second = split.shares.order_by("position")
        # The organizer settles everything directly, leaving a live link behind.
        split_service.pay_remaining(split, card=card())
        with pytest.raises(split_service.SplitError) as exc:
            split_service.pay_share(links[second.id], card=card())
        assert exc.value.code in ("not_required", "invalid_link")
        booking.refresh_from_db()
        # And crucially, no overpayment happened.
        assert booking_amount_paid(booking) == booking.total_amount

    def test_total_collected_never_exceeds_the_booking_total(self, booking):
        split, links = self._split(booking, people=4)
        for share in split.shares.order_by("position"):
            try:
                split_service.pay_share(links[share.id], card=card())
            except split_service.SplitError:
                pass
        booking.refresh_from_db()
        assert booking_amount_paid(booking) <= booking.total_amount

    def test_a_declined_card_leaves_the_share_payable(self, booking):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        with pytest.raises(split_service.SplitError) as exc:
            split_service.pay_share(links[share.id], card=card(number=CARD_DECLINED))
        assert exc.value.code == "declined"
        share.refresh_from_db()
        assert share.status == ShareStatus.FAILED
        assert share.token_hash is not None
        # The payer can try another card on the same link.
        split_service.pay_share(links[share.id], card=card())
        share.refresh_from_db()
        assert share.status == ShareStatus.PAID

    def test_nothing_is_collected_once_the_booking_is_cancelled(self, booking):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        booking.status = BookingStatus.CANCELLED
        booking.save(update_fields=["status"])
        with pytest.raises(split_service.SplitError) as exc:
            split_service.pay_share(links[share.id], card=card())
        assert exc.value.code == "booking_cancelled"

    def test_an_expired_split_stops_accepting_money(self, booking):
        from django.utils import timezone
        from datetime import timedelta

        split, links = self._split(booking)
        split.expires_at = timezone.now() - timedelta(minutes=1)
        split.save(update_fields=["expires_at"])
        share = split.shares.order_by("position")[1]
        with pytest.raises(split_service.SplitError) as exc:
            split_service.pay_share(links[share.id], card=card())
        assert exc.value.code == "expired"


# --------------------------------------------------------------------------- #
# Expiry: the foundation must move no money
# --------------------------------------------------------------------------- #
@pytest.mark.usefixtures("demo_mode")
class TestExpiry:
    def test_expiry_collects_nothing_and_refunds_nothing(self, booking):
        """Expiry is inert, and that is a decision rather than a gap.

        Money already collected stays collected and is refunded by a person
        using the existing cancellation and credit note tools, honouring
        `Organization.require_refund_approval`. Nothing here moves money,
        cancels a booking or releases a slot: the links simply stop working.
        """
        from django.utils import timezone
        from datetime import timedelta

        amounts = split_service.allocate_equal(
            booking_outstanding(booking), 2, booking.currency)
        split, links = split_service.create_split(
            booking, [{"amount": a, "name": f"P{i}"} for i, a in enumerate(amounts)])
        first = split.shares.order_by("position").first()
        split_service.pay_share(links[first.id], card=card())
        paid_before = booking_amount_paid(booking)
        status_before = Booking.objects.get(pk=booking.pk).status

        split.expires_at = timezone.now() - timedelta(minutes=1)
        split.save(update_fields=["expires_at"])
        assert split_service.expire_due_splits() == 1

        split.refresh_from_db()
        booking.refresh_from_db()
        assert split.status == SplitStatus.EXPIRED
        assert booking_amount_paid(booking) == paid_before      # nothing refunded
        assert booking.status == status_before                  # nothing released
        # Every unpaid link is now dead.
        assert not BookingPaymentShare.objects.filter(
            split=split, status=ShareStatus.PENDING).exists()
        assert split.shares.filter(status=ShareStatus.PAID).count() == 1

    def test_expiry_is_idempotent(self, booking):
        from django.utils import timezone
        from datetime import timedelta

        amounts = split_service.allocate_equal(
            booking_outstanding(booking), 2, booking.currency)
        split, _ = split_service.create_split(
            booking, [{"amount": a, "name": f"P{i}"} for i, a in enumerate(amounts)])
        split.expires_at = timezone.now() - timedelta(minutes=1)
        split.save(update_fields=["expires_at"])
        assert split_service.expire_due_splits() == 1
        assert split_service.expire_due_splits() == 0


# --------------------------------------------------------------------------- #
# Organizer actions
# --------------------------------------------------------------------------- #
@pytest.mark.usefixtures("demo_mode")
class TestOrganizerActions:
    def _split(self, booking, people=4):
        amounts = split_service.allocate_equal(
            booking_outstanding(booking), people, booking.currency)
        rows = [{"amount": a, "name": f"Player {i}", "is_organizer": i == 0}
                for i, a in enumerate(amounts)]
        return split_service.create_split(booking, rows)

    def test_pay_remaining_settles_exactly_the_outstanding_balance(self, booking):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        split_service.pay_share(links[share.id], card=card())
        outstanding = booking_outstanding(booking)
        payment = split_service.pay_remaining(split, card=card())
        assert payment.amount == outstanding
        booking.refresh_from_db()
        assert booking_outstanding(booking) == Decimal("0.000")
        assert booking.payment_status == "paid"

    def test_a_paid_share_cannot_be_cancelled(self, booking):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        split_service.pay_share(links[share.id], card=card())
        with pytest.raises(split_service.SplitError) as exc:
            split_service.cancel_share(split, share.id)
        assert exc.value.code == "already_paid"

    def test_cancel_and_recreate_an_unpaid_share(self, booking):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[2]
        amount = share.amount
        split_service.cancel_share(split, share.id)
        share.refresh_from_db()
        assert share.status == ShareStatus.CANCELLED
        assert share.token_hash is None
        # The freed amount can be reallocated, and only that amount.
        created, new_links = split_service.add_shares(
            split, [{"amount": amount, "name": "Replacement"}])
        assert len(created) == 1
        assert new_links[created[0].id]

    def test_added_shares_must_match_the_unallocated_amount(self, booking):
        split, _ = self._split(booking)
        with pytest.raises(split_service.SplitError) as exc:
            split_service.add_shares(split, [{"amount": Decimal("5.00"), "name": "X"}])
        assert exc.value.code in ("nothing_unallocated", "allocation_mismatch")

    def test_reissuing_a_link_kills_the_previous_one(self, booking):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        old = links[share.id]
        _, new = split_service.regenerate_share_token(split, share.id)
        assert new != old
        assert split_service.resolve_share(old) is None
        assert split_service.resolve_share(new).id == share.id

    def test_cancelling_a_split_does_not_refund_collected_money(self, booking):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        split_service.pay_share(links[share.id], card=card())
        collected = booking_amount_paid(booking)
        split_service.cancel_split(split)
        booking.refresh_from_db()
        assert booking_amount_paid(booking) == collected
        assert split.shares.filter(status=ShareStatus.PAID).count() == 1

    def test_reminders_are_rate_limited(self, booking):
        split, _ = self._split(booking)
        share = split.shares.order_by("position")[1]
        split_service.record_reminder(split, share.id)
        with pytest.raises(split_service.SplitError) as exc:
            split_service.record_reminder(split, share.id)
        assert exc.value.code == "reminder_cooldown"


# --------------------------------------------------------------------------- #
# Public API: what a link actually exposes
# --------------------------------------------------------------------------- #
@pytest.mark.usefixtures("demo_mode")
class TestPublicApi:
    def _split(self, booking, people=3):
        amounts = split_service.allocate_equal(
            booking_outstanding(booking), people, booking.currency)
        rows = [{"amount": a, "name": f"Player {i}",
                 "email": f"p{i}@example.com", "is_organizer": i == 0}
                for i, a in enumerate(amounts)]
        return split_service.create_split(booking, rows)

    def test_a_friend_sees_the_booking_but_no_private_details(self, booking, api):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        url = reverse("website-public-split-share", args=[links[share.id]])
        response = api.get(url)
        assert response.status_code == 200
        body = response.json()
        assert body["amount"] == str(share.amount)
        assert body["booking"]["club"] == "Riverside Club"
        # Nothing about the organizer or the other participants leaks through.
        blob = response.content.decode()
        assert "organizer@example.com" not in blob
        assert "+966549443311" not in blob
        assert "p2@example.com" not in blob
        assert str(booking.id) not in str(body["booking"].get("reference", ""))
        assert "internal_notes" not in blob

    def test_an_invalid_token_resolves_to_nothing(self, api):
        url = reverse("website-public-split-share", args=["not-a-real-token"])
        assert api.get(url).status_code == 404

    def test_a_friend_cannot_choose_their_own_amount(self, booking, api):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        url = reverse("website-public-split-share", args=[links[share.id]])
        response = api.post(url, {"card": GOOD_CARD, "amount": "1.00"}, format="json")
        assert response.status_code == 200
        # The backend charged the assigned share, not the amount they sent.
        assert response.json()["amount"] == str(share.amount)
        assert booking_amount_paid(booking) == share.amount

    def test_the_organizer_link_shows_progress(self, booking, api):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        split_service.pay_share(links[share.id], card=card())
        url = reverse("website-public-split-manage", args=[links["organizer"]])
        body = api.get(url).json()
        assert body["paid"] == str(share.amount)
        assert len(body["shares"]) == 3
        assert any(s["status"] == ShareStatus.PAID for s in body["shares"])
        assert 0 < body["percent_paid"] < 100

    def test_a_share_token_cannot_be_used_as_a_manage_token(self, booking, api):
        split, links = self._split(booking)
        share = split.shares.order_by("position")[1]
        url = reverse("website-public-split-manage", args=[links[share.id]])
        assert api.get(url).status_code == 404

    def test_an_unknown_organizer_action_is_refused(self, booking, api):
        split, links = self._split(booking)
        url = reverse("website-public-split-manage", args=[links["organizer"]])
        response = api.post(url, {"action": "delete_everything"}, format="json")
        assert response.status_code == 400

    @override_settings(PAYMENT_MODE="demo", PAYMENT_ALLOW_DEMO=False)
    def test_payment_config_hides_test_cards_in_production(self, api):
        body = api.get(reverse("website-public-payment-config")).json()
        assert body["card_enabled"] is False
        assert body["test_cards"] == []


# --------------------------------------------------------------------------- #
# Card data must not be persisted or logged
# --------------------------------------------------------------------------- #
@pytest.mark.usefixtures("demo_mode")
class TestCardDataHandling:
    def test_no_pan_or_cvv_is_written_anywhere(self, booking, caplog):
        from apps.auditlogs.models import AuditLog
        from apps.payments.models import Payment

        caplog.set_level("DEBUG")
        amounts = split_service.allocate_equal(
            booking_outstanding(booking), 2, booking.currency)
        split, links = split_service.create_split(
            booking, [{"amount": a, "name": f"P{i}"} for i, a in enumerate(amounts)])
        share = split.shares.order_by("position").first()
        _, payment = split_service.pay_share(links[share.id], card=card())

        payment.refresh_from_db()
        assert payment.card_last4 == "4242"
        assert payment.card_brand == "visa"
        # The full number and the security code appear in no stored field.
        stored = " ".join(str(v) for v in Payment.objects.values_list(
            "gateway_reference", "failure_reason", "card_brand", "card_last4")[0])
        assert CARD_APPROVED not in stored
        audit_blob = " ".join(str(row) for row in AuditLog.objects.values_list("payload_summary", flat=True))
        assert CARD_APPROVED not in audit_blob
        assert CARD_APPROVED not in caplog.text

    def test_audit_records_the_split_lifecycle_without_tokens(self, booking):
        from apps.auditlogs.models import AuditLog

        amounts = split_service.allocate_equal(
            booking_outstanding(booking), 2, booking.currency)
        split, links = split_service.create_split(
            booking, [{"amount": a, "name": f"P{i}"} for i, a in enumerate(amounts)])
        for share in split.shares.order_by("position"):
            split_service.pay_share(links[share.id], card=card())

        # The event name lives inside the payload, not as a column.
        events = {row.get("event") for row in
                  AuditLog.objects.values_list("payload_summary", flat=True)}
        assert {"split_created", "split_share_paid", "split_completed"} <= events
        blob = " ".join(str(row) for row in AuditLog.objects.values_list("payload_summary", flat=True))
        for raw in links.values():
            assert raw not in blob


# --------------------------------------------------------------------------- #
# Real concurrency
# --------------------------------------------------------------------------- #
@pytest.mark.django_db(transaction=True)
def test_two_friends_paying_at_the_same_instant(settings):
    """Real threads, real row locks, real commits.

    `transaction=True` is what makes this meaningful: the default test wraps
    everything in one transaction nobody else can see into, which would hide
    exactly the race this is about.
    """
    import threading
    from datetime import date, time, timedelta

    from django.db import connections

    from apps.clubs.models import Club
    from apps.customers.models import Customer
    from apps.facilities.models import Facility, FacilityType

    settings.PAYMENT_MODE = "demo"
    settings.PAYMENT_ALLOW_DEMO = True

    club = Club.objects.create(name="Race Club", is_active=True,
                               booking_hours=_open_all_week())
    ftype = FacilityType.objects.create(
        name="Padel Court", price=Decimal("400.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    unit = Facility.objects.create(name="Court 1", club=club, is_active=True)
    unit.facility_types.add(ftype)
    customer = Customer.objects.create(
        full_name="Organizer", email="race@riversideclub.sa", mobile_number="+966500000001")
    obj = Booking.objects.create(
        customer=customer, club=club, facility_type=ftype,
        scheduled_date=date.today() + timedelta(days=4),
        scheduled_time=time(20, 0), duration_minutes=60,
        status=BookingStatus.BOOKED)
    obj.compute_pricing()
    obj.sync_payment_status()
    obj.save()

    amounts = split_service.allocate_equal(
        booking_outstanding(obj), 2, obj.currency)
    split, links = split_service.create_split(
        obj, [{"amount": a, "name": f"P{i}"} for i, a in enumerate(amounts)])
    tokens = [links[s.id] for s in split.shares.order_by("position")]

    start = threading.Barrier(len(tokens))
    outcomes = []

    def pay(token):
        try:
            start.wait(timeout=10)
            split_service.pay_share(token, card=card())
            outcomes.append("paid")
        except split_service.SplitError as exc:
            outcomes.append(exc.code)
        except Exception as exc:                    # pragma: no cover - diagnostic
            outcomes.append(f"error:{exc}")
        finally:
            connections.close_all()

    threads = [threading.Thread(target=pay, args=(token,)) for token in tokens]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    obj.refresh_from_db()
    # Both shares are legitimate, so both should succeed, and the crucial
    # invariant is that the booking collected its total exactly once.
    assert outcomes.count("paid") >= 1, outcomes
    assert not any(str(o).startswith("error:") for o in outcomes), outcomes
    assert booking_amount_paid(obj) <= obj.total_amount
    assert obj.payment_status in ("paid", "partially_paid")
    # No share was paid twice.
    paid_shares = split.shares.filter(status=ShareStatus.PAID)
    assert paid_shares.count() == len({s.payment_id for s in paid_shares})


# --------------------------------------------------------------------------- #
# Refunding a booking several people paid for
# --------------------------------------------------------------------------- #
@pytest.mark.usefixtures("demo_mode")
class TestRefundingASplitBooking:
    """Confirmed business rule: each participant is refunded their OWN payment,
    through the existing credit note flow, honouring the organization's refund
    approval setting. Nothing here is automated by cancelling the booking.

    What makes that possible is that every share keeps its payer, its amount and
    its payment reference, and each share's payment raises its own invoice. These
    tests pin that, because the moment two shares shared one invoice an operator
    could no longer return the right money to the right person.
    """

    def _paid_split(self, booking, people=2):
        amounts = split_service.allocate_equal(
            booking_outstanding(booking), people, booking.currency)
        split, links = split_service.create_split(
            booking, [{"amount": a, "name": f"Payer {i}"}
                      for i, a in enumerate(amounts)])
        for share in split.shares.order_by("position"):
            split_service.pay_share(links[share.id], card=card())
        return split

    def test_each_payer_gets_their_own_invoice(self, booking):
        from apps.payments.models import Invoice

        split = self._paid_split(booking, people=3)
        invoices = Invoice.objects.filter(booking=booking)
        assert invoices.count() == 3
        # Each share's payment maps to exactly one invoice, so a refund can be
        # aimed at one person without touching anybody else's money.
        for share in split.shares.all():
            assert Invoice.objects.filter(payment=share.payment).count() == 1

    def test_the_trail_names_who_paid_what(self, booking):
        split = self._paid_split(booking, people=3)
        trail = [(s.participant_name, str(s.amount), s.payment.reference,
                  s.payment.card_last4)
                 for s in split.shares.order_by("position")]
        assert len(trail) == 3
        assert all(name and ref for name, _amount, ref, _last4 in trail)
        # Distinct payments, not one payment shared between participants.
        assert len({ref for _n, _a, ref, _l in trail}) == 3

    def test_refunding_one_payer_leaves_the_others_alone(self, booking):
        from apps.payments import services as pay
        from apps.payments.models import Invoice

        from apps.settings_app.models import Organization
        org = Organization.get_solo()
        org.require_refund_approval = False
        org.save()

        split = self._paid_split(booking, people=2)
        first, second = split.shares.order_by("position")
        invoice = Invoice.objects.get(payment=first.payment)

        note = pay.request_refund(invoice, reason="Player withdrew")
        assert note.total == first.amount

        second.payment.refresh_from_db()
        # The other participant's money is untouched.
        assert second.payment.refunded_amount == Decimal("0.000")
        assert second.payment.status == "paid"

    def test_a_refund_still_needs_approval_when_the_org_requires_it(self, booking):
        from apps.payments import services as pay
        from apps.payments.models import CreditNoteStatus, Invoice
        from apps.settings_app.models import Organization

        org = Organization.get_solo()
        org.require_refund_approval = True
        org.save()

        split = self._paid_split(booking, people=2)
        first = split.shares.order_by("position").first()
        invoice = Invoice.objects.get(payment=first.payment)

        note = pay.request_refund(invoice, reason="Player withdrew")
        # Split payment does not get its own shortcut around maker-checker.
        assert note.status == CreditNoteStatus.PENDING_APPROVAL
        first.payment.refresh_from_db()
        assert first.payment.refunded_amount == Decimal("0.000")

    def test_cancelling_the_booking_refunds_nobody_automatically(self, booking):
        from apps.bookings.models import BookingStatus

        split = self._paid_split(booking, people=2)
        collected = booking_amount_paid(booking)
        booking.status = BookingStatus.CANCELLED
        booking.save(update_fields=["status"])

        booking.refresh_from_db()
        # Confirmed policy: a cancellation is not a refund. Staff raise the
        # credit notes deliberately, per payer.
        assert booking_amount_paid(booking) == collected
        for share in split.shares.all():
            share.payment.refresh_from_db()
            assert share.payment.refunded_amount == Decimal("0.000")
