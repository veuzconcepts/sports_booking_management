"""Loyalty engine: earn, redeem, reverse, tier recompute, expiry + reports.

Every mutation goes through `_apply()` (the single ledger writer + cached-balance
updater) inside a row-locked transaction, so the cached `customer.loyalty_points`
always reconciles to the append-only `LoyaltyLedger`. All cross-app imports are
lazy so this module can be imported from bookings/payments without cycles, and
the lifecycle hooks wrap calls in try/except so loyalty never breaks finance.
"""

from decimal import Decimal, ROUND_FLOOR, ROUND_HALF_UP

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone


class LoyaltyError(Exception):
    """A redemption/adjust rule was violated (surfaced as a clean 400)."""


def get_config():
    from .models import LoyaltyConfiguration
    return LoyaltyConfiguration.get_solo()


# --------------------------------------------------------------------------- #
# Core ledger writer
# --------------------------------------------------------------------------- #
def _apply(cust, txn_type, points, *, source, reason="", booking=None, actor=None, invoice_ref=""):
    """Append a ledger row for `points` (may be negative) and update the cached
    balance + lifetime aggregates on the (already row-locked) customer `cust`.
    Balance never goes below zero. Returns the ledger row."""
    from apps.customers.models import LoyaltyLedger, LoyaltyTxnType

    before = cust.loyalty_points or 0
    after = max(0, before + points)
    cust.loyalty_points = after
    if txn_type in (LoyaltyTxnType.EARN, LoyaltyTxnType.BONUS) and points > 0:
        cust.loyalty_points_earned = (cust.loyalty_points_earned or 0) + points
    elif txn_type == LoyaltyTxnType.REDEEM and points < 0:
        cust.loyalty_points_redeemed = (cust.loyalty_points_redeemed or 0) + abs(points)
    elif txn_type == LoyaltyTxnType.EXPIRE and points < 0:
        cust.loyalty_points_expired = (cust.loyalty_points_expired or 0) + abs(points)
    elif txn_type == LoyaltyTxnType.REVERSED and points < 0:
        # Reverses an earning.
        cust.loyalty_points_earned = max(0, (cust.loyalty_points_earned or 0) - abs(points))
    elif txn_type == LoyaltyTxnType.REVERSED and points > 0:
        # Reverses a redemption (points returned).
        cust.loyalty_points_redeemed = max(0, (cust.loyalty_points_redeemed or 0) - points)
    cust.save(update_fields=[
        "loyalty_points", "loyalty_points_earned", "loyalty_points_redeemed",
        "loyalty_points_expired", "updated_at",
    ])
    return LoyaltyLedger.objects.create(
        customer=cust, txn_type=txn_type, points=points,
        balance_before=before, balance_after=after, source=source,
        note=(reason or "")[:255],
        related_booking_id=(booking.id if booking else None),
        related_invoice_ref=(invoice_ref or "")[:40], created_by=actor,
    )


def _log(event, summary, customer, actor=None, request=None):
    try:
        if request is not None:
            from apps.auditlogs.services import log_event
            log_event(request, event, summary, actor=actor, subject=("customer", customer.id))
        else:
            from apps.auditlogs.services import log_system_event
            log_system_event(event, summary, subject=("customer", customer.id), actor=actor)
    except Exception:  # pragma: no cover - auditing must never break the flow
        pass


# --------------------------------------------------------------------------- #
# Tier recompute (upgrade-only)
# --------------------------------------------------------------------------- #
def _recompute_tier_locked(cust, *, actor=None, request=None):
    from .models import LoyaltyTier
    tiers = list(LoyaltyTier.objects.filter(is_active=True).order_by("rank"))
    if not tiers:
        return
    points = cust.loyalty_points or 0
    spend = Decimal(str(cust.loyalty_spend or 0))
    qualified = None
    for t in tiers:
        ok_pts = t.min_points is None or points >= t.min_points
        ok_spend = t.min_spend is None or spend >= Decimal(str(t.min_spend))
        if ok_pts and ok_spend:
            qualified = t           # tiers are rank-ascending; last match = highest
    if qualified is None:
        return
    cur = next((t for t in tiers if t.slug == cust.loyalty_tier), None)
    cur_rank = cur.rank if cur else -1
    if qualified.rank <= cur_rank:
        return                      # upgrade-only: never lower a customer's tier
    old = cust.loyalty_tier
    cust.loyalty_tier = qualified.slug
    cust.tier_since = timezone.now().date()
    cust.save(update_fields=["loyalty_tier", "tier_since", "updated_at"])
    _log("loyalty_tier_changed",
         {"changes": {"Tier": {"from": old or "-", "to": qualified.slug}}},
         cust, actor, request)


def recompute_tier(customer, *, actor=None, request=None):
    from apps.customers.models import Customer
    with transaction.atomic():
        cust = Customer.objects.select_for_update().get(pk=customer.pk)
        _recompute_tier_locked(cust, actor=actor, request=request)
        customer.loyalty_tier = cust.loyalty_tier
        customer.tier_since = cust.tier_since


# --------------------------------------------------------------------------- #
# Earning
# --------------------------------------------------------------------------- #
def _earn_points(cfg, net_paid, booking) -> int:
    pts = int((Decimal(net_paid) * Decimal(str(cfg.points_per_currency)))
              .to_integral_value(rounding=ROUND_FLOOR))
    pts += int(cfg.fixed_points_per_booking or 0)
    svc = cfg.service_bonuses or {}
    if booking.facility_type_id and str(booking.facility_type_id) in svc:
        pts += int(svc.get(str(booking.facility_type_id)) or 0)
    mem = cfg.membership_bonuses or {}
    plan_id = booking._active_membership_plan_id() if hasattr(booking, "_active_membership_plan_id") else None
    if plan_id and str(plan_id) in mem:
        pts += int(mem.get(str(plan_id)) or 0)
    return max(0, pts)


def award_loyalty_for_booking(booking, *, actor=None, request=None):
    """Award points for a completed + paid booking (idempotent). Returns points
    awarded, or None if nothing was awarded."""
    cfg = get_config()
    if not cfg.earning_enabled or not booking.customer_id:
        return None
    if booking.loyalty_points_earned:
        return None
    from apps.customers.models import Customer, LoyaltyLedger, LoyaltySource, LoyaltyTxnType
    if LoyaltyLedger.objects.filter(related_booking_id=booking.id, txn_type=LoyaltyTxnType.EARN).exists():
        return None
    from apps.bookings.services import booking_amount_paid
    net_paid = Decimal(str(booking_amount_paid(booking) or 0))
    if net_paid <= 0:
        return None
    pts = _earn_points(cfg, net_paid, booking)
    if pts <= 0:
        return None
    with transaction.atomic():
        cust = Customer.objects.select_for_update().get(pk=booking.customer_id)
        _apply(cust, LoyaltyTxnType.EARN, pts, source=LoyaltySource.BOOKING,
               reason=f"Earned on booking {booking.reference}", booking=booking, actor=actor)
        cust.loyalty_spend = (Decimal(str(cust.loyalty_spend or 0)) + net_paid)
        cust.save(update_fields=["loyalty_spend", "updated_at"])
        booking.loyalty_points_earned = pts
        booking.save(update_fields=["loyalty_points_earned", "updated_at"])
        _recompute_tier_locked(cust, actor=actor, request=request)
    _log("loyalty_earned",
         {"points": pts, "booking": booking.reference,
          "changes": {"Points earned": str(pts), "Booking": booking.reference}},
         booking.customer, actor, request)
    return pts


# --------------------------------------------------------------------------- #
# Redemption (admin, pre-payment)
# --------------------------------------------------------------------------- #
def redeem_points(booking, points, *, actor=None, request=None):
    """Redeem `points` against `booking` to reduce the payable. Validates config,
    balance and caps; deducts the points immediately and sets the booking's
    `loyalty_discount`. Returns {points, value}."""
    from apps.bookings.services import (
        booking_has_live_invoice, confirm_if_settled, sync_booking_payment_status)
    from apps.customers.models import Customer, LoyaltySource, LoyaltyTxnType

    cfg = get_config()
    if not cfg.redemption_enabled:
        raise LoyaltyError("Loyalty redemption is not enabled.")
    if not booking.customer_id:
        raise LoyaltyError("This booking has no customer to redeem points for.")
    points = int(points or 0)
    if points <= 0:
        raise LoyaltyError("Enter the number of points to redeem.")
    if booking.loyalty_points_redeemed:
        raise LoyaltyError("Points are already redeemed on this booking. Undo first to change.")
    if booking_has_live_invoice(booking):
        raise LoyaltyError("An invoice already exists - redeem points before invoicing.")
    if points < (cfg.min_redeem_points or 0):
        raise LoyaltyError(f"Redeem at least {cfg.min_redeem_points} points.")
    cap = cfg.max_redeem_points_per_booking or 0
    if cap and points > cap:
        raise LoyaltyError(f"You can redeem at most {cap} points on a booking.")
    if booking.promo_code_id and not cfg.stack_with_promo:
        raise LoyaltyError("Points can't be combined with a promo code on this booking.")
    if booking.coverage_snapshot and not cfg.stack_with_membership:
        raise LoyaltyError("Points can't be combined with membership coverage on this booking.")

    with transaction.atomic():
        cust = Customer.objects.select_for_update().get(pk=booking.customer_id)
        if points > (cust.loyalty_points or 0):
            raise LoyaltyError("Not enough points for this redemption.")
        payable = Decimal(str(booking.total_amount or 0))
        if payable <= 0:
            raise LoyaltyError("There is nothing payable to redeem against.")
        value = (Decimal(points) * Decimal(str(cfg.currency_per_point))).quantize(Decimal("0.001"))
        max_value = payable
        if cfg.max_redeem_percent:
            max_value = min(payable, payable * Decimal(cfg.max_redeem_percent) / Decimal(100))
        if value > max_value:
            raise LoyaltyError("This redemption exceeds the allowed limit for the booking.")
        _apply(cust, LoyaltyTxnType.REDEEM, -points, source=LoyaltySource.BOOKING,
               reason=f"Redeemed on booking {booking.reference}", booking=booking, actor=actor)
        booking.loyalty_discount = value
        booking.loyalty_points_redeemed = points
        booking.compute_pricing()
        booking.save()
        sync_booking_payment_status(booking)
        # Points that clear the whole balance settle the booking, the same as
        # money would.
        confirm_if_settled(booking, actor=actor, request=request)
    _log("loyalty_redeemed",
         {"points": points, "value": str(value), "booking": booking.reference,
          "changes": {"Points redeemed": str(points), "Value": str(value)}},
         booking.customer, actor, request)
    return {"points": points, "value": value}


def unredeem_points(booking, *, actor=None, request=None):
    """Undo a redemption on `booking`: return the points and clear the discount."""
    from apps.bookings.services import sync_booking_payment_status
    from apps.customers.models import Customer, LoyaltySource, LoyaltyTxnType

    pts = booking.loyalty_points_redeemed or 0
    if pts <= 0:
        return None
    with transaction.atomic():
        cust = Customer.objects.select_for_update().get(pk=booking.customer_id)
        _apply(cust, LoyaltyTxnType.REVERSED, pts, source=LoyaltySource.BOOKING,
               reason=f"Redemption reversed on booking {booking.reference}", booking=booking, actor=actor)
        booking.loyalty_discount = Decimal("0")
        booking.loyalty_points_redeemed = 0
        booking.compute_pricing()
        booking.save()
        sync_booking_payment_status(booking)
    _log("loyalty_redeem_reversed",
         {"points": pts, "booking": booking.reference}, booking.customer, actor, request)
    return pts


# --------------------------------------------------------------------------- #
# Reversal (refund / cancellation)
# --------------------------------------------------------------------------- #
def _already_reversed_earn(booking_id) -> int:
    from apps.customers.models import LoyaltyLedger, LoyaltyTxnType
    s = (LoyaltyLedger.objects
         .filter(related_booking_id=booking_id, txn_type=LoyaltyTxnType.REVERSED, points__lt=0)
         .aggregate(s=Sum("points"))["s"]) or 0
    return -int(s)


def _reverse_earned(booking, reverse_pts, *, refund_amount=Decimal("0"), source, reason,
                    invoice_ref="", actor=None, request=None):
    from apps.customers.models import Customer, LoyaltyTxnType
    earned = booking.loyalty_points_earned or 0
    remaining = max(0, earned - _already_reversed_earn(booking.id))
    reverse_pts = min(reverse_pts, remaining)
    if reverse_pts <= 0:
        return 0
    with transaction.atomic():
        cust = Customer.objects.select_for_update().get(pk=booking.customer_id)
        _apply(cust, LoyaltyTxnType.REVERSED, -reverse_pts, source=source,
               reason=reason, booking=booking, invoice_ref=invoice_ref, actor=actor)
        if refund_amount:
            cust.loyalty_spend = max(Decimal("0"),
                                     Decimal(str(cust.loyalty_spend or 0)) - Decimal(str(refund_amount)))
            cust.save(update_fields=["loyalty_spend", "updated_at"])
    _log("loyalty_reversed",
         {"points": reverse_pts, "booking": booking.reference, "reason": reason},
         booking.customer, actor, request)
    return reverse_pts


def reverse_loyalty_for_refund(credit_note, *, actor=None, request=None):
    """On a refund (CreditNote ISSUED), reverse earned points in proportion to the
    refunded amount vs the booking total. Idempotent across partial refunds."""
    try:
        invoice = credit_note.invoice
        booking = invoice.booking if invoice else None
    except Exception:
        return None
    if not booking or not booking.customer_id or not (booking.loyalty_points_earned or 0):
        return None
    from apps.loyalty.models import LoyaltyConfiguration  # noqa: F401 (ensures app ready)
    from apps.customers.models import LoyaltySource
    refund_amount = Decimal(str(getattr(credit_note, "total", 0) or 0))
    base = Decimal(str(booking.total_amount or 0))
    if refund_amount <= 0 or base <= 0:
        return None
    frac = min(Decimal("1"), refund_amount / base)
    reverse_pts = int((Decimal(booking.loyalty_points_earned) * frac)
                      .to_integral_value(rounding=ROUND_HALF_UP))
    return _reverse_earned(
        booking, reverse_pts, refund_amount=refund_amount, source=LoyaltySource.INVOICE,
        reason=f"Reversed for refund {getattr(credit_note, 'number', '')}".strip(),
        invoice_ref=getattr(credit_note, "number", "") or "", actor=actor, request=request)


def reverse_loyalty_for_cancellation(booking, *, actor=None, request=None):
    """A completed booking later cancelled/no-show/deleted: reverse all remaining
    earned points and return any points that were redeemed against it."""
    if not booking.customer_id:
        return None
    from apps.customers.models import LoyaltySource
    if booking.loyalty_points_earned:
        _reverse_earned(
            booking, booking.loyalty_points_earned,
            refund_amount=Decimal(str(booking.total_amount or 0)),
            source=LoyaltySource.BOOKING,
            reason=f"Reversed - booking {booking.reference} cancelled",
            actor=actor, request=request)
    if booking.loyalty_points_redeemed:
        unredeem_points(booking, actor=actor, request=request)
    return True


# --------------------------------------------------------------------------- #
# Manual adjust (used by the customer Adjust action)
# --------------------------------------------------------------------------- #
def adjust_points(customer, points, *, note="", actor=None, request=None):
    """Manually add/subtract points (admin), writing a rich ADJUST ledger row and
    recomputing the tier. Returns the refreshed customer."""
    from apps.customers.models import Customer, LoyaltySource, LoyaltyTxnType
    points = int(points or 0)
    if points == 0:
        raise LoyaltyError("Points cannot be zero.")
    with transaction.atomic():
        cust = Customer.objects.select_for_update().get(pk=customer.pk)
        _apply(cust, LoyaltyTxnType.ADJUST, points, source=LoyaltySource.ADMIN,
               reason=note, actor=actor)
        _recompute_tier_locked(cust, actor=actor, request=request)
    customer.refresh_from_db()
    return customer


def reverse_ledger_entry(entry, *, actor=None, request=None):
    """Reverse a single ledger entry (write the opposite). Requires loyalty.reverse."""
    from apps.customers.models import Customer, LoyaltySource, LoyaltyTxnType
    with transaction.atomic():
        cust = Customer.objects.select_for_update().get(pk=entry.customer_id)
        _apply(cust, LoyaltyTxnType.REVERSED, -entry.points, source=LoyaltySource.ADMIN,
               reason=f"Reversal of #{entry.id}", booking=None, actor=actor)
        _recompute_tier_locked(cust, actor=actor, request=request)
    _log("loyalty_reversed", {"entry": entry.id, "points": -entry.points}, cust, actor, request)
    return True


# --------------------------------------------------------------------------- #
# Expiry (off until configured; driven by the loyalty_maintenance command)
# --------------------------------------------------------------------------- #
def expire_points(*, request=None):
    """Expire points older than `expiry_months` of activity. No-op when disabled."""
    cfg = get_config()
    months = cfg.expiry_months or 0
    if months <= 0:
        return 0
    from datetime import timedelta
    from apps.customers.models import Customer, LoyaltyLedger, LoyaltySource, LoyaltyTxnType
    cutoff = timezone.now() - timedelta(days=30 * months)
    expired_total = 0
    # Customers with a balance and no ledger activity since the cutoff.
    actives = (LoyaltyLedger.objects.filter(created_at__gte=cutoff)
               .values_list("customer_id", flat=True).distinct())
    stale = Customer.objects.filter(loyalty_points__gt=0).exclude(id__in=actives)
    for c in stale:
        with transaction.atomic():
            cust = Customer.objects.select_for_update().get(pk=c.pk)
            bal = cust.loyalty_points or 0
            if bal <= 0:
                continue
            _apply(cust, LoyaltyTxnType.EXPIRE, -bal, source=LoyaltySource.SYSTEM,
                   reason="Points expired (inactivity)")
            expired_total += bal
    return expired_total


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #
def _ledger_qs(date_from=None, date_to=None):
    from apps.customers.models import LoyaltyLedger
    qs = LoyaltyLedger.objects.all()
    if date_from:
        qs = qs.filter(created_at__date__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__date__lte=date_to)
    return qs


def points_summary_report(date_from=None, date_to=None) -> dict:
    """Issued / redeemed / expired totals for the window."""
    from apps.customers.models import LoyaltyTxnType
    qs = _ledger_qs(date_from, date_to)
    issued = qs.filter(txn_type__in=[LoyaltyTxnType.EARN, LoyaltyTxnType.BONUS, LoyaltyTxnType.ADJUST],
                       points__gt=0).aggregate(s=Sum("points"))["s"] or 0
    redeemed = qs.filter(txn_type=LoyaltyTxnType.REDEEM).aggregate(s=Sum("points"))["s"] or 0
    expired = qs.filter(txn_type=LoyaltyTxnType.EXPIRE).aggregate(s=Sum("points"))["s"] or 0
    reversed_ = qs.filter(txn_type=LoyaltyTxnType.REVERSED).aggregate(s=Sum("points"))["s"] or 0
    return {
        "issued": int(issued),
        "redeemed": int(-redeemed),
        "expired": int(-expired),
        "reversed": int(reversed_),
    }


def tier_distribution_report() -> list:
    from django.db.models import Count
    from apps.customers.models import Customer
    rows = (Customer.objects.values("loyalty_tier")
            .annotate(count=Count("id")).order_by("loyalty_tier"))
    return [{"tier": r["loyalty_tier"], "count": r["count"]} for r in rows]


def top_customers_report(limit=20) -> list:
    from apps.customers.models import Customer
    rows = (Customer.objects.filter(loyalty_points__gt=0)
            .order_by("-loyalty_points")[:limit])
    return [{
        "id": c.id, "code": c.customer_code, "name": c.full_name,
        "tier": c.loyalty_tier, "points": c.loyalty_points,
        "earned": c.loyalty_points_earned, "redeemed": c.loyalty_points_redeemed,
    } for c in rows]


def liability_report() -> dict:
    """Outstanding points liability = current balances × currency_per_point."""
    from apps.customers.models import Customer
    total_points = Customer.objects.aggregate(s=Sum("loyalty_points"))["s"] or 0
    cfg = get_config()
    value = (Decimal(int(total_points)) * Decimal(str(cfg.currency_per_point))).quantize(Decimal("0.001"))
    return {"outstanding_points": int(total_points), "value": str(value),
            "currency_per_point": str(cfg.currency_per_point)}
