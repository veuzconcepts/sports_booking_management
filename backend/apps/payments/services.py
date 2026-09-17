"""Payments business logic — the only place money actually moves.

Every function here is atomic and writes an audit event so the financial trail
is complete. Views stay thin and call into these helpers.
"""

import calendar
from datetime import date as date_cls
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from apps.auditlogs.services import log_event
from apps.settings_app.currency import (
    format_currency, get_default_currency, quantize_money, round_extended,
)

from django.conf import settings

from .gateway import get_gateway
from .models import (
    CreditNote,
    CreditNoteStatus,
    Invoice,
    InvoicePurpose,
    InvoiceStatus,
    Membership,
    MembershipInterval,
    MembershipStatus,
    Payment,
    PaymentMethod,
    PaymentStatus,
    Receipt,
    Refund,
    RefundStatus,
    Wallet,
    WalletTxn,
    WalletTxnType,
)



# --------------------------------------------------------------------------- #
# Wallet
# --------------------------------------------------------------------------- #
def get_or_create_wallet(customer) -> Wallet:
    from apps.settings_app.currency import get_default_currency
    wallet, _ = Wallet.objects.get_or_create(
        customer=customer, defaults={"currency": get_default_currency()},
    )
    return wallet


@transaction.atomic
def record_wallet_txn(wallet, txn_type, amount, *, note="", related_payment=None) -> WalletTxn:
    """Append a ledger entry and move the wallet balance atomically."""
    wallet = Wallet.objects.select_for_update().get(pk=wallet.pk)
    amount = quantize_money(amount, wallet.currency)
    wallet.balance = quantize_money(wallet.balance + amount, wallet.currency)
    wallet.save(update_fields=["balance", "updated_at"])
    return WalletTxn.objects.create(
        wallet=wallet, txn_type=txn_type, amount=amount,
        balance_after=wallet.balance, note=note, related_payment=related_payment,
    )


@transaction.atomic
def topup_wallet(customer, amount, *, request=None, note="Wallet top-up") -> WalletTxn:
    wallet = get_or_create_wallet(customer)
    txn = record_wallet_txn(wallet, WalletTxnType.TOPUP, Decimal(amount), note=note)
    if request:
        log_event(request, "wallet_topup",
                  {"customer": customer.email, "amount": str(amount),
                   "balance_after": str(txn.balance_after)})
    return txn


# --------------------------------------------------------------------------- #
# Payments
# --------------------------------------------------------------------------- #
@transaction.atomic
def charge(customer, amount, method, *, booking=None, request=None) -> Payment:
    """Take a payment for a booking (or ad-hoc) via the selected method.

    Wallet payments debit the ledger; card/cash go through the gateway adapter.
    Returns a persisted `Payment` whose `status` reflects the outcome.
    """
    currency = getattr(booking, "currency", None) or get_default_currency()
    amount = quantize_money(amount, currency)
    actor = getattr(request, "user", None)
    payment = Payment(
        booking=booking, customer=customer, method=method,
        amount=amount, currency=currency,
        created_by=actor if (actor and actor.is_authenticated) else None,
    )
    if booking is not None:
        payment.currency = booking.currency

    if method == PaymentMethod.WALLET:
        wallet = get_or_create_wallet(customer)
        if wallet.balance < amount:
            payment.status = PaymentStatus.FAILED
            payment.failure_reason = "Insufficient wallet balance."
            payment.save()
            _audit_payment(request, "payment_failed", payment)
            return payment
        payment.gateway = "wallet"
        payment.status = PaymentStatus.PAID
        payment.paid_at = timezone.now()
        payment.save()
        record_wallet_txn(wallet, WalletTxnType.CHARGE, -amount,
                          note=f"Charge for {booking.reference if booking else 'facility_category'}",
                          related_payment=payment)
        _audit_payment(request, "payment_captured", payment)
        _sync_booking_payment(booking, request=request)
        return payment

    # Card / cash → gateway adapter.
    gw = get_gateway()
    result = gw.charge(amount, currency=payment.currency, method=method)
    payment.gateway = gw.name
    if result.success:
        payment.status = PaymentStatus.PAID
        payment.gateway_reference = result.reference
        payment.paid_at = timezone.now()
        payment.save()
        _audit_payment(request, "payment_captured", payment)
        _sync_booking_payment(booking, request=request)
    else:
        payment.status = PaymentStatus.FAILED
        payment.failure_reason = result.failure_reason
        payment.save()
        _audit_payment(request, "payment_failed", payment)
    return payment


@transaction.atomic
def record_manual_payment(customer, amount, method, *, booking=None, reference="",
                          paid_at=None, notes="", request=None) -> Payment:
    """Record an already-collected (offline) payment as PAID — used by the booking
    completion wizard when the operator confirms money taken at the counter
    (cash / card terminal / transfer). Unlike `charge()`, this does NOT call the
    gateway; it just persists the captured payment so the invoice/receipt flow can
    settle. Notes are kept in the audit trail."""
    currency = getattr(booking, "currency", None) or get_default_currency()
    amount = quantize_money(amount, currency)
    actor = getattr(request, "user", None)
    payment = Payment.objects.create(
        booking=booking, customer=customer, method=method,
        amount=amount, currency=currency, status=PaymentStatus.PAID,
        gateway="manual", gateway_reference=reference[:120],
        paid_at=paid_at or timezone.now(),
        created_by=actor if (actor and actor.is_authenticated) else None,
    )
    if request:
        log_event(request, "payment_captured", {
            "payment": payment.reference, "amount": str(payment.amount),
            "method": payment.method,
            "booking": booking.reference if booking else None,
            "manual": True, "notes": notes[:255] if notes else "",
        })
    _sync_booking_payment(booking, request=request)
    return payment


@transaction.atomic
def refund(payment, amount, *, reason="", method=None, request=None) -> Refund:
    """Refund (full or partial) a paid payment. Raises ValueError if invalid."""
    amount = quantize_money(amount, payment.currency)
    if payment.status not in (PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED):
        raise ValueError("Only paid payments can be refunded.")
    if amount <= 0 or amount > payment.refundable_amount:
        raise ValueError("Refund amount exceeds the refundable balance.")

    gw = get_gateway()
    if payment.method != PaymentMethod.WALLET:
        result = gw.refund(payment.gateway_reference, amount)
        if not result.success:
            raise ValueError(result.failure_reason or "Gateway refused the refund.")

    refund_obj = Refund.objects.create(
        payment=payment, amount=amount, reason=reason,
        method=method or payment.method, status=RefundStatus.COMPLETED,
        created_by=_actor(request),
    )
    payment.refunded_amount = quantize_money(payment.refunded_amount + amount, payment.currency)
    payment.status = (
        PaymentStatus.REFUNDED if payment.refunded_amount >= payment.amount
        else PaymentStatus.PARTIALLY_REFUNDED
    )
    payment.save(update_fields=["refunded_amount", "status", "updated_at"])

    # Wallet payments: credit the money back to the wallet.
    if payment.method == PaymentMethod.WALLET:
        wallet = get_or_create_wallet(payment.customer)
        record_wallet_txn(wallet, WalletTxnType.REFUND, amount,
                          note=f"Refund on {payment.reference}", related_payment=payment)

    if request:
        log_event(request, "payment_refunded",
                  {"payment": payment.reference, "amount": str(amount),
                   "status": payment.status})
    return refund_obj


# --------------------------------------------------------------------------- #
# Memberships
# --------------------------------------------------------------------------- #
INTERVAL_MONTHS = {
    MembershipInterval.MONTHLY: 1,
    MembershipInterval.QUARTERLY: 3,
    MembershipInterval.HALF_YEARLY: 6,
    MembershipInterval.ANNUAL: 12,
}


def add_months(start: date_cls, months: int) -> date_cls:
    """Add calendar months, clamping the day to the target month's length."""
    month_index = start.month - 1 + months
    year = start.year + month_index // 12
    month = month_index % 12 + 1
    day = min(start.day, calendar.monthrange(year, month)[1])
    return date_cls(year, month, day)


def membership_window(plan, start: date_cls):
    """(start, end) for a plan bought on `start`: a fixed calendar range, a
    custom day count, or an interval (monthly/quarterly/half-yearly/yearly)."""
    from datetime import timedelta
    from .models import MembershipInterval as _MI, ValidityMode
    if plan.validity_mode == ValidityMode.FIXED and plan.fixed_start and plan.fixed_end:
        return plan.fixed_start, plan.fixed_end
    if plan.interval == _MI.CUSTOM:
        return start, start + timedelta(days=plan.duration_days or 30)
    return start, add_months(start, INTERVAL_MONTHS.get(plan.interval, 1))


def _membership_charge_amount(plan, promo_code, currency):
    """Plan price after an optional promo-code discount (membership fees respect
    promos + tax; pricing rules target facility_category bookings, not membership fees)."""
    price = quantize_money(plan.price, currency)
    if not promo_code:
        return price, None
    from apps.promotions.models import PromoCode
    from apps.promotions.services import compute_discount
    promo = PromoCode.objects.filter(code__iexact=promo_code, is_active=True).first()
    if not promo:
        raise ValueError("Invalid or inactive promo code.")
    discount = compute_discount(promo, price)
    return quantize_money(max(Decimal("0"), price - discount), currency), promo


def _bill_membership(membership, *, purpose=InvoicePurpose.MEMBERSHIP_PURCHASE, request=None):
    """Charge the (optionally promo-discounted) plan price and raise the sale's
    Invoice + Receipt against the membership. `purpose` tags the invoice as a
    purchase vs a renewal so the financial history reads distinctly. Returns the
    Invoice, or None when no method is set (a comped / admin-granted membership)."""
    method = getattr(membership, "_charge_method", None)
    if not method:
        return None
    currency = get_default_currency()
    amount, _promo = _membership_charge_amount(
        membership.plan, getattr(membership, "_promo_code", None), currency)
    payment = charge(membership.customer, amount, method, request=request)
    if payment.status != PaymentStatus.PAID:
        raise ValueError(payment.failure_reason or "Payment was not captured.")
    return create_invoice(customer=membership.customer, payment=payment,
                          membership=membership, purpose=purpose, request=request)


@transaction.atomic
def issue_membership(customer, plan, *, start_date=None, club_id=None, method=None,
                     promo_code=None, auto_renew=True, request=None) -> Membership:
    from apps.settings_app.models import Organization
    # One active membership per customer unless the org allows multiple.
    if not Organization.get_solo().allow_multiple_memberships and Membership.objects.filter(
            customer=customer, status=MembershipStatus.ACTIVE).exists():
        raise ValueError("This customer already has an active membership.")
    start = start_date or timezone.localdate()
    start, end = membership_window(plan, start)
    membership = Membership.objects.create(
        customer=customer, plan=plan, club_id=club_id, start_date=start, end_date=end,
        auto_renew=auto_renew, status=MembershipStatus.ACTIVE,
    )
    membership._charge_method = method
    membership._promo_code = promo_code
    invoice = _bill_membership(membership, purpose=InvoicePurpose.MEMBERSHIP_PURCHASE,
                               request=request)
    if request:
        log_event(request, "membership_issued",
                  {"membership": membership.number, "customer": customer.email,
                   "plan": plan.name, "end_date": end.isoformat(),
                   "invoice": invoice.number if invoice else None},
                  subject=("membership", membership.id))
    return membership


@transaction.atomic
def request_membership(customer, plan, *, club_id=None, by_label=None,
                       request=None) -> Membership:
    """Record a customer's own request for a plan as a DRAFT membership.

    The self-facility_category counterpart to `issue_membership`: nothing is granted and
    nothing is billed. A draft confers no entitlements — coverage only ever
    counts ACTIVE memberships — so staff confirm payment first and then call
    `activate_membership`, which raises the invoice and starts the validity
    window from that day.

    Re-requesting the same plan returns the existing draft instead of stacking
    duplicates, so a double tap in the app is harmless.
    """
    from apps.settings_app.models import Organization
    if not plan.is_active:
        raise ValueError("This plan is no longer available.")
    if not Organization.get_solo().allow_multiple_memberships and Membership.objects.filter(
            customer=customer, status=MembershipStatus.ACTIVE).exists():
        raise ValueError("You already have an active membership.")

    existing = Membership.objects.filter(
        customer=customer, plan=plan, status=MembershipStatus.DRAFT).first()
    if existing:
        return existing

    # Provisional window so the record is complete; `activate_membership`
    # recomputes it, since the term should start when the plan is paid for.
    start, end = membership_window(plan, timezone.localdate())
    membership = Membership.objects.create(
        customer=customer, plan=plan, club_id=club_id,
        start_date=start, end_date=end, status=MembershipStatus.DRAFT,
    )
    if request:
        log_event(request, "membership_requested",
                  {"membership": membership.number, "customer": customer.email,
                   "plan": plan.name, "price": str(plan.price),
                   **({"by_label": by_label} if by_label else {})},
                  subject=("membership", membership.id))
    return membership


@transaction.atomic
def activate_membership(membership, *, method=None, promo_code=None,
                        request=None) -> Membership:
    """Confirm a requested (DRAFT) membership: start it today and bill it.

    The validity window is recomputed from the activation date, so a request
    made days earlier never eats into the term the customer pays for. Billing
    reuses `_bill_membership`, so the invoice/receipt trail is identical to a
    staff-issued purchase (and omitting `method` comps it, exactly as there).
    """
    from apps.settings_app.models import Organization
    if membership.status != MembershipStatus.DRAFT:
        raise ValueError("Only a requested membership can be activated.")
    if not Organization.get_solo().allow_multiple_memberships and Membership.objects.filter(
            customer=membership.customer, status=MembershipStatus.ACTIVE).exists():
        raise ValueError("This customer already has an active membership.")

    membership.start_date, membership.end_date = membership_window(
        membership.plan, timezone.localdate())
    membership.status = MembershipStatus.ACTIVE
    membership.save(update_fields=["start_date", "end_date", "status", "updated_at"])
    membership._charge_method = method
    membership._promo_code = promo_code
    invoice = _bill_membership(membership, purpose=InvoicePurpose.MEMBERSHIP_PURCHASE,
                               request=request)
    if request:
        log_event(request, "membership_activated",
                  {"membership": membership.number, "customer": membership.customer.email,
                   "plan": membership.plan.name, "end_date": membership.end_date.isoformat(),
                   "invoice": invoice.number if invoice else None},
                  subject=("membership", membership.id))
    return membership


class EarlyRenewalError(ValueError):
    """Renewal blocked because the membership is still active well before expiry
    and no explicit confirmation was given. Carries a code so callers can offer
    the operator a 'renew anyway' confirmation (vs a plain validation error)."""
    code = "early_renewal"


# A renewal charges another full term immediately. If the membership is still
# valid for longer than this many days, require an explicit confirmation so a
# misclick can't double-charge a customer whose membership hasn't lapsed.
RENEW_NOTICE_DAYS = 30


@transaction.atomic
def renew_membership(membership, *, method=None, promo_code=None,
                     confirm_early=False, request=None) -> Membership:
    # Guard against accidental early renewal (another full charge while the
    # membership is still active well before expiry). Expired/lapsed or near-
    # expiry memberships renew without friction.
    if not confirm_early and membership.status == MembershipStatus.ACTIVE and membership.end_date:
        days_left = (membership.end_date - timezone.localdate()).days
        if days_left > RENEW_NOTICE_DAYS:
            raise EarlyRenewalError(
                f"This membership is still active for {days_left} more days "
                f"(until {membership.end_date.isoformat()}). Renewing now charges "
                f"another full term immediately. Confirm to proceed.")
    # Extend the window from the current end date (interval/custom plans).
    _, membership.end_date = membership_window(membership.plan, membership.end_date)
    membership.status = MembershipStatus.ACTIVE
    membership.save(update_fields=["end_date", "status", "updated_at"])
    membership._charge_method = method
    membership._promo_code = promo_code
    invoice = _bill_membership(membership, purpose=InvoicePurpose.MEMBERSHIP_RENEWAL,
                               request=request)
    if request:
        log_event(request, "membership_renewed",
                  {"membership": membership.number, "end_date": membership.end_date.isoformat(),
                   "invoice": invoice.number if invoice else None},
                  subject=("membership", membership.id))
    return membership


# --------------------------------------------------------------------------- #
# Membership usage: coverage + reserve / consume / restore (deduct on completion)
# --------------------------------------------------------------------------- #
def period_key(period, on_date):
    """Period bucket for an entitlement: "" (lifetime), YYYY-MM (month),
    YYYY-Www (week), YYYY-MM-DD (day). A new bucket = a fresh limit."""
    from .models import EntitlementPeriod
    if period == EntitlementPeriod.MONTHLY:
        return on_date.strftime("%Y-%m")
    if period == EntitlementPeriod.WEEKLY:
        iso = on_date.isocalendar()
        return f"{iso[0]}-W{iso[1]:02d}"
    if period == EntitlementPeriod.DAILY:
        return on_date.strftime("%Y-%m-%d")
    return ""


def _active_memberships(customer_id, on_date=None):
    """Active memberships covering on_date, soonest-expiring first (so the
    nearest-to-expire is drawn down first)."""
    from .models import Membership, MembershipStatus
    qs = (Membership.objects
          .filter(customer_id=customer_id, status=MembershipStatus.ACTIVE)
          .select_related("plan").prefetch_related("plan__entitlements")
          .order_by("end_date", "id"))
    return [m for m in qs if not (on_date and not (m.start_date <= on_date <= m.end_date))]


def active_membership(customer_id, on_date=None):
    """Back-compat: the single best (soonest-expiring) active membership."""
    ms = _active_memberships(customer_id, on_date)
    return ms[0] if ms else None


def _match_service_item(ents, item):
    from .models import EntitlementTarget
    for e in ents:
        if e.target_type == EntitlementTarget.FACILITY_TYPE and e.facility_type_id == item.id:
            return e
    for e in ents:
        if e.target_type == EntitlementTarget.CATEGORY and e.facility_category_id \
                and item.categories.filter(id=e.facility_category_id).exists():
            return e
    return None


def _match_addon(ents, addon):
    from .models import EntitlementTarget
    for e in ents:
        if e.target_type == EntitlementTarget.ADDON and e.addon_id == addon.id:
            return e
    return None


def _booking_net(booking, types):
    """Net units per (membership_id, entitlement_id, period_key) for a booking,
    over the given ledger txn types (RESERVE/CONSUME positive; RELEASE/RESTORE
    negative)."""
    from .models import MembershipUsage, MembershipUsageType as T
    pos = {T.RESERVE, T.CONSUME}
    net = {}
    for r in MembershipUsage.objects.filter(booking=booking, txn_type__in=types).values(
            "membership_id", "entitlement_id", "period_key", "txn_type", "quantity"):
        key = (r["membership_id"], r["entitlement_id"], r["period_key"])
        net[key] = net.get(key, 0) + (r["quantity"] if r["txn_type"] in pos else -r["quantity"])
    return net


def _remaining(membership, ent, pk, own_reserved=0, for_consumption=False):
    """Units available on a bucket. None = unlimited.

    Two views of "available":
      - pricing/display (default): qty + granted − consumed − reserved + own_reserved,
        so a held unit blocks a NEW booking's coverage (the soft hold).
      - for_consumption=True: qty + granted − consumed only — holds are ignored,
        because a hold is soft: at EXECUTION whichever eligible booking completes
        first consumes the truly-free unit (reallocation), and a booking whose
        held unit was taken elsewhere finds nothing left (revalidated → chargeable).
    """
    from .models import EntitlementLimit, MembershipBalance
    if ent.limit_type == EntitlementLimit.UNLIMITED:
        return None
    bal = MembershipBalance.objects.filter(
        membership=membership, entitlement=ent, period_key=pk).first()
    consumed = bal.consumed if bal else 0
    granted = bal.granted if bal else 0
    if for_consumption:
        return max(0, (ent.quantity or 0) + granted - consumed)
    reserved = bal.reserved if bal else 0
    return max(0, (ent.quantity or 0) + granted - consumed - reserved + own_reserved)


def reservation_holders(membership, *, exclude_booking_id=None):
    """Booking references currently HOLDING (net-reserved, not yet consumed) units
    on a membership — so a chargeable booking can show 'held by BK-...'. """
    from collections import defaultdict
    from .models import MembershipUsage, MembershipUsageType as T
    net = defaultdict(int)
    rows = (MembershipUsage.objects
            .filter(membership=membership, txn_type__in=[T.RESERVE, T.RELEASE])
            .select_related("booking"))
    for u in rows:
        if not u.booking_id or u.booking_id == exclude_booking_id:
            continue
        net[u.booking] += u.quantity if u.txn_type == T.RESERVE else -u.quantity
    return [b.reference for b, q in net.items() if q > 0]


def coverage_for_booking(booking, addon_objs=None, *, ignore_opt_out=False,
                         for_consumption=False):
    """What the customer's membership(s) cover on this booking (read-only). Scans
    active memberships (soonest-expiring first) and draws each line from the first
    with availability. Counts this booking's own existing reservation as available
    to it, so re-pricing an already-reserved booking is stable.

    Returns None when the booking opted out of subscription coverage (staff
    "Unapply Subscription"), so pricing / reserve / consume all skip it from one
    place. ``ignore_opt_out=True`` probes what *would* be covered (the "eligible
    subscription available" check behind Redeem). ``for_consumption=True`` draws
    against truly-free units (holds ignored) — used at execution so the first
    booking to complete consumes the unit regardless of who held it."""
    if not booking.customer_id:
        return None
    if getattr(booking, "subscription_opt_out", False) and not ignore_opt_out:
        return None
    on_date = booking.scheduled_date
    memberships = _active_memberships(booking.customer_id, on_date)
    if not memberships:
        return None
    from .models import MembershipUsageType as T
    own = _booking_net(booking, [T.RESERVE, T.RELEASE])
    remaining = {}   # (membership_id, ent_id) -> units left for this booking

    def take(membership, ent):
        pk = period_key(ent.period, on_date)
        key = (membership.id, ent.id)
        if key not in remaining:
            remaining[key] = _remaining(
                membership, ent, pk, own_reserved=own.get((membership.id, ent.id, pk), 0),
                for_consumption=for_consumption)
        left = remaining[key]
        if left is None:
            return pk
        if left >= 1:
            remaining[key] = left - 1
            return pk
        return None

    def cover(matcher, ref_id, label, kind):
        for membership in memberships:
            ent = matcher(list(membership.plan.entitlements.all()))
            if not ent:
                continue
            pk = take(membership, ent)
            if pk is not None:
                return {"kind": kind, "ref_id": ref_id, "label": label,
                        "membership": membership, "entitlement": ent,
                        "quantity": 1, "period_key": pk}
        return None

    covered = []
    if booking.facility_type_id:
        line = cover(lambda ents: _match_service_item(ents, booking.facility_type),
                     booking.facility_type_id, booking.facility_type.name, "facility_type")
        if line:
            covered.append(line)
    addon_list = list(booking.add_ons.all()) if addon_objs is None else addon_objs
    for ao in addon_list:
        line = cover(lambda ents, _a=ao: _match_addon(ents, _a), ao.id, ao.name, "addon")
        if line:
            covered.append(line)
    primary = next((l["membership"] for l in covered if l["kind"] == "facility_type"),
                   (covered[0]["membership"] if covered else memberships[0]))
    return {
        "memberships": memberships,
        "membership": primary,
        "covered_lines": covered,
        "covered_service_item": any(l["kind"] == "facility_type" for l in covered),
        "covered_addon_ids": {l["ref_id"] for l in covered if l["kind"] == "addon"},
    }


def coverage_summary(booking, addon_objs=None):
    """UI-friendly membership coverage for the booking form (read-only).

    Returns None when the customer has no active membership. Otherwise lists each
    selected line as covered / not-covered, a rollup status (full / partial /
    none), and the remaining units per drawn entitlement in the current period.
    Pure presentation over ``coverage_for_booking`` — changes no pricing/usage.
    """
    cov = coverage_for_booking(booking, addon_objs=addon_objs)
    if not cov:
        return None
    covered_addon_ids = cov["covered_addon_ids"]

    items = []
    if booking.facility_type_id:
        items.append({"kind": "facility_type", "label": booking.facility_type.name,
                      "covered": cov["covered_service_item"]})
    for a in (addon_objs or []):
        items.append({"kind": "addon", "label": a.name,
                      "covered": a.id in covered_addon_ids})

    balances, seen = [], set()
    for line in cov["covered_lines"]:
        ent, m, pk = line["entitlement"], line["membership"], line["period_key"]
        key = (m.id, ent.id, pk)
        if key in seen:
            continue
        seen.add(key)
        balances.append({
            "label": line["label"],
            "membership_number": m.number,
            "remaining": _remaining(m, ent, pk),   # None = unlimited
            "period": ent.period,
        })

    n_total = len(items)
    n_covered = sum(1 for i in items if i["covered"])
    status = "none" if n_covered == 0 else ("full" if n_covered == n_total else "partial")
    return {
        "membership_number": cov["membership"].number,
        "plan_name": cov["membership"].plan.name,
        "status": status,
        "covered_count": n_covered,
        "total_count": n_total,
        "items": items,
        "balances": balances,
    }


@transaction.atomic
def _release_reservation(booking, *, request=None):
    """Release this booking's outstanding reservation (RESERVE − RELEASE > 0)."""
    from .models import (EntitlementLimit, MembershipBalance, MembershipUsage,
                         MembershipUsageType as T, PlanEntitlement)
    net = _booking_net(booking, [T.RESERVE, T.RELEASE])
    for (m_id, ent_id, pk), qty in net.items():
        if qty <= 0:
            continue
        ent = PlanEntitlement.objects.filter(pk=ent_id).first()
        if ent and ent.limit_type == EntitlementLimit.LIMITED:
            bal = (MembershipBalance.objects.select_for_update()
                   .filter(membership_id=m_id, entitlement_id=ent_id, period_key=pk).first())
            if bal:
                bal.reserved = max(0, bal.reserved - qty)
                bal.save(update_fields=["reserved"])
        MembershipUsage.objects.create(
            membership_id=m_id, entitlement_id=ent_id, txn_type=T.RELEASE,
            quantity=qty, booking=booking, period_key=pk, created_by=_actor(request))


@transaction.atomic
def reserve_for_booking(booking, *, request=None, for_consumption=False):
    """Hold covered units for a not-yet-completed booking (re-syncs to the current
    selection). No-op once consumed (completed). ``for_consumption=True`` holds
    against truly-free units (used by Redeem, where the booking is claiming an
    available unit another booking only softly holds)."""
    from .models import (EntitlementLimit, MembershipBalance, MembershipUsage,
                         MembershipUsageType as T)
    if not booking.customer_id:
        return
    if any(v > 0 for v in _booking_net(booking, [T.CONSUME, T.RESTORE]).values()):
        return   # already consumed (completed) — don't reserve
    _release_reservation(booking, request=request)
    cov = coverage_for_booking(booking, for_consumption=for_consumption)
    if not cov or not cov["covered_lines"]:
        return
    for line in cov["covered_lines"]:
        m, ent, pk, qty = line["membership"], line["entitlement"], line["period_key"], line["quantity"]
        if ent.limit_type == EntitlementLimit.LIMITED:
            bal, _ = MembershipBalance.objects.select_for_update().get_or_create(
                membership=m, entitlement=ent, period_key=pk)
            bal.reserved += qty
            bal.save(update_fields=["reserved"])
        MembershipUsage.objects.create(
            membership=m, entitlement=ent, txn_type=T.RESERVE, quantity=qty,
            booking=booking, target_label=line["label"][:160], period_key=pk,
            created_by=_actor(request))


@transaction.atomic
def consume_for_booking(booking, *, request=None):
    """Finalise membership usage for a completed booking. Holds are SOFT: this draws
    against truly-free units (``for_consumption``), so the first eligible booking to
    complete consumes the unit even if another booking was holding it (reallocation);
    a booking whose held unit was taken elsewhere consumes nothing and stays
    chargeable. Releases this booking's own hold first. Idempotent.

    Returns what was actually consumed (drives the completion re-price):
    {"facility_type": bool, "addon_ids": set, "membership": <Membership|None>}.
    """
    from .models import (EntitlementLimit, MembershipBalance, MembershipUsage,
                         MembershipUsageType as T)
    result = {"facility_type": False, "addon_ids": set(), "membership": None}
    if not booking.customer_id:
        return result
    if any(v > 0 for v in _booking_net(booking, [T.CONSUME, T.RESTORE]).values()):
        return result   # already consumed (idempotent)
    # Only a booking that intends to use coverage (covered snapshot) consumes — a
    # chargeable booking never auto-grabs a free unit; it must be redeemed first.
    if not getattr(booking, "coverage_snapshot", None):
        _release_reservation(booking, request=request)
        return result

    _release_reservation(booking, request=request)   # drop this booking's soft hold
    cov = coverage_for_booking(booking, for_consumption=True)
    if not cov or not cov["covered_lines"]:
        return result
    lines = 0
    for line in cov["covered_lines"]:
        ent, pk, qty, mm = line["entitlement"], line["period_key"], line["quantity"], line["membership"]
        if ent.limit_type == EntitlementLimit.LIMITED:
            bal, _ = MembershipBalance.objects.select_for_update().get_or_create(
                membership=mm, entitlement=ent, period_key=pk)
            # Final race-safe guard under the row lock: only ever consume a free unit,
            # so two bookings can never consume the same one.
            if bal.consumed + qty > (ent.quantity or 0) + bal.granted:
                continue
            bal.consumed += qty
            bal.save(update_fields=["consumed"])
        MembershipUsage.objects.create(
            membership=mm, entitlement=ent, txn_type=T.CONSUME, quantity=qty,
            booking=booking, target_label=line["label"][:160], period_key=pk,
            created_by=_actor(request))
        if line["kind"] == "facility_type":
            result["facility_type"] = True
        else:
            result["addon_ids"].add(line["ref_id"])
        result["membership"] = mm
        lines += 1
    if request and result["membership"] and lines:
        log_event(request, "membership_usage_consumed",
                  {"membership": result["membership"].number,
                   "booking": booking.reference, "lines": lines})
    return result


@transaction.atomic
def revalidate_booking_coverage(booking, *, request=None):
    """Before completion/payment: if a booking is currently covered but its held
    unit was consumed by another booking (soft-hold reallocation), drop the coverage
    and re-price it to the full chargeable amount — so a held booking never completes
    free on a unit it no longer has. No-op for chargeable / opted-out / already-
    consumed bookings, or when a unit is still available. Returns an info dict
    (from/to amount, membership) when it re-priced, else None."""
    from .models import MembershipUsageType as T
    if not booking.customer_id:
        return None
    if any(v > 0 for v in _booking_net(booking, [T.CONSUME, T.RESTORE]).values()):
        return None   # already consumed — settled
    # A booking whose money is already captured has a locked price — never silently
    # re-price it here (reversal is an explicit refund/credit-note action).
    from apps.bookings.services import booking_payment_taken
    if booking_payment_taken(booking):
        return None
    # The booking only needs revalidating if it is currently covered/held — either a
    # stored snapshot OR an outstanding reservation (covers legacy bookings priced 0
    # without a snapshot, which would otherwise complete free on a dead membership).
    held = any(v > 0 for v in _booking_net(booking, [T.RESERVE, T.RELEASE]).values())
    if not (getattr(booking, "coverage_snapshot", None) or held):
        return None
    cov = coverage_for_booking(booking, for_consumption=True)
    if cov and cov["covered_lines"]:
        return None   # a unit is still genuinely free → coverage holds
    snap = booking.coverage_snapshot or {}
    info = {"membership": snap.get("membership_number"),
            "from_amount": str(booking.total_amount)}
    _release_reservation(booking, request=request)
    booking.compute_pricing(covered_override={})        # coverage gone → full price
    booking.sync_payment_status()
    booking.save(update_fields=[
        "base_amount", "addons_amount", "discount_amount", "surcharge_amount",
        "tax_amount", "total_amount", "total_raw", "total_extended",
        "rounding_difference", "applied_rules", "calculated_at",
        "coverage_snapshot", "payment_status", "updated_at"])
    info["to_amount"] = str(booking.total_amount)
    return info


@transaction.atomic
def revalidate_membership_bookings(membership, *, request=None, reason=""):
    """When a membership stops being usable (cancelled / expired), immediately
    revalidate its not-yet-completed held/covered bookings so they become chargeable
    now — instead of silently staying 0 until someone tries to complete them. Each
    affected booking is re-priced and logged. Returns the count revalidated."""
    from apps.bookings.models import Booking, BookingStatus
    from apps.bookings.services import event_source, record_booking_event
    from .models import MembershipUsage, MembershipUsageType as T

    booking_ids = set(
        MembershipUsage.objects
        .filter(membership=membership,
                txn_type__in=[T.RESERVE, T.RELEASE, T.CONSUME, T.RESTORE])
        .exclude(booking__isnull=True)
        .values_list("booking_id", flat=True))
    if not booking_ids:
        return 0
    terminal = {BookingStatus.COMPLETED, BookingStatus.CLOSED,
                BookingStatus.CANCELLED, BookingStatus.NO_SHOW}
    actor = _actor(request)
    revalidated = 0
    for booking in (Booking.objects.filter(id__in=booking_ids).exclude(status__in=terminal)):
        info = revalidate_booking_coverage(booking, request=request)
        if not info:
            continue
        revalidated += 1
        record_booking_event(
            booking,
            f"Subscription {reason or 'no longer available'} - booking is now chargeable",
            actor=actor, event="coverage_revalidated",
            meta={"source": event_source(actor), "membership": membership.number,
                  "from_amount": info["from_amount"], "to_amount": info["to_amount"],
                  "currency": booking.currency})
    return revalidated


@transaction.atomic
def restore_for_booking(booking, *, request=None):
    """Reverse a booking's membership usage (cancel / no-show / reopen): release any
    reservation AND restore any consumption. Idempotent."""
    from .models import (EntitlementLimit, Membership, MembershipBalance,
                         MembershipUsage, MembershipUsageType as T, PlanEntitlement)
    _release_reservation(booking, request=request)
    consumed = _booking_net(booking, [T.CONSUME, T.RESTORE])
    m = Membership.objects.filter(usage__booking=booking).first()
    restored = False
    for (m_id, ent_id, pk), qty in consumed.items():
        if qty <= 0:
            continue
        ent = PlanEntitlement.objects.filter(pk=ent_id).first()
        if ent and ent.limit_type == EntitlementLimit.LIMITED:
            bal = (MembershipBalance.objects.select_for_update()
                   .filter(membership_id=m_id, entitlement_id=ent_id, period_key=pk).first())
            if bal:
                bal.consumed = max(0, bal.consumed - qty)
                bal.save(update_fields=["consumed"])
        MembershipUsage.objects.create(
            membership_id=m_id, entitlement_id=ent_id, txn_type=T.RESTORE,
            quantity=qty, booking=booking, period_key=pk, created_by=_actor(request))
        restored = True
    if restored and request and m:
        log_event(request, "membership_usage_restored",
                  {"membership": m.number, "booking": booking.reference})


# --------------------------------------------------------------------------- #
# Membership lifecycle (suspend / resume / cancel / extend / adjust / expire)
# --------------------------------------------------------------------------- #
@transaction.atomic
def suspend_membership(membership, *, reason="", request=None) -> Membership:
    if membership.status != MembershipStatus.ACTIVE:
        raise ValueError("Only an active membership can be suspended.")
    membership.status = MembershipStatus.SUSPENDED
    membership.save(update_fields=["status", "updated_at"])
    if request:
        log_event(request, "membership_suspended",
                  {"membership": membership.number, "reason": (reason or "")[:255]},
                  subject=("membership", membership.id))
    return membership


@transaction.atomic
def resume_membership(membership, *, request=None) -> Membership:
    if membership.status != MembershipStatus.SUSPENDED:
        raise ValueError("Only a suspended membership can be resumed.")
    if membership.end_date < timezone.localdate():
        raise ValueError("This membership has expired and can't be resumed - renew it instead.")
    membership.status = MembershipStatus.ACTIVE
    membership.save(update_fields=["status", "updated_at"])
    if request:
        log_event(request, "membership_resumed", {"membership": membership.number},
                  subject=("membership", membership.id))
    return membership


@transaction.atomic
def cancel_membership(membership, *, reason="", request=None) -> Membership:
    if membership.status == MembershipStatus.CANCELLED:
        raise ValueError("This membership is already cancelled.")
    prev = membership.status
    membership.status = MembershipStatus.CANCELLED
    membership.save(update_fields=["status", "updated_at"])
    # Immediately make any open booking it was covering chargeable again — coverage
    # from a cancelled membership must not survive to completion.
    revalidate_membership_bookings(membership, request=request, reason="cancelled")
    if request:
        log_event(request, "membership_cancelled",
                  {"membership": membership.number, "from": prev,
                   "reason": (reason or "")[:255]},
                  subject=("membership", membership.id))
    return membership


@transaction.atomic
def extend_membership(membership, *, days=None, end_date=None, request=None) -> Membership:
    from datetime import timedelta
    new_end = end_date or (membership.end_date + timedelta(days=days or 0))
    if new_end <= membership.end_date:
        raise ValueError("The new end date must be after the current end date.")
    prev = membership.end_date
    membership.end_date = new_end
    # Re-activate an expired membership if it now extends into the future.
    if membership.status == MembershipStatus.EXPIRED and new_end >= timezone.localdate():
        membership.status = MembershipStatus.ACTIVE
    membership.save(update_fields=["end_date", "status", "updated_at"])
    if request:
        log_event(request, "membership_extended",
                  {"membership": membership.number,
                   "from": prev.isoformat(), "to": new_end.isoformat()},
                  subject=("membership", membership.id))
    return membership


def _resolve_adjust_period(membership, entitlement, explicit_pk, grant):
    """Pick the balance bucket a grant/restore should act on.

    An explicit period key is honoured as-is. Otherwise it resolves from the
    entitlement's period: the CURRENT bucket for a grant (the bonus applies to the
    active period), and for a restore the current bucket if it holds consumed
    usage, else the most-recent bucket that does — so a restore finds real
    consumption regardless of which period it landed in (the root cause of the
    "no consumed usage" error when the caller didn't pass a period bucket)."""
    from .models import MembershipBalance
    if explicit_pk is not None:
        return explicit_pk
    current = period_key(entitlement.period, timezone.localdate())
    if grant:
        return current
    cur = MembershipBalance.objects.filter(
        membership=membership, entitlement=entitlement, period_key=current).first()
    if cur and cur.consumed > 0:
        return current
    alt = (MembershipBalance.objects
           .filter(membership=membership, entitlement=entitlement, consumed__gt=0)
           .order_by("-period_key").first())
    return alt.period_key if alt else current


@transaction.atomic
def adjust_usage(membership, entitlement, units, *, period_key=None, grant=False,
                 note="", request=None):
    """Manual usage adjustment on a balance bucket (gated by
    subscriptions.usage_adjust, audited). Two DISTINCT operations:
      - grant=True (bonus): add extra units beyond the plan quantity (granted++),
        independent of any consumption.
      - grant=False (restore): return previously-consumed units, capped at what's
        consumed in the resolved period bucket.
    `period_key=None` (the default) resolves the right bucket from the
    entitlement's period; pass an explicit key to target a specific one.
    """
    from .models import MembershipBalance, MembershipUsage, MembershipUsageType
    if units <= 0:
        raise ValueError("Units must be greater than zero.")
    period_key = _resolve_adjust_period(membership, entitlement, period_key, grant)
    bal, _ = MembershipBalance.objects.select_for_update().get_or_create(
        membership=membership, entitlement=entitlement, period_key=period_key)
    if grant:
        bal.granted += units
        bal.save(update_fields=["granted"])
        qty = units
    else:
        if bal.consumed <= 0:
            raise ValueError("There is no consumed usage to restore for this entitlement and period.")
        qty = min(units, bal.consumed)
        bal.consumed -= qty
        bal.save(update_fields=["consumed"])
    MembershipUsage.objects.create(
        membership=membership, entitlement=entitlement,
        txn_type=MembershipUsageType.ADJUST, quantity=qty, period_key=period_key,
        note=(note or ("Bonus grant" if grant else "Manual restore"))[:255],
        created_by=_actor(request))
    if request:
        log_event(request, "membership_usage_adjusted",
                  {"membership": membership.number, "units": qty,
                   "grant": grant, "note": (note or "")[:255]},
                  subject=("membership", membership.id))
    return membership


def expire_due_memberships():
    """Expire ACTIVE memberships past their end date. Safe to run repeatedly;
    returns the number expired. Used by the cron command + lazily on list."""
    from apps.auditlogs.services import log_system_event
    today = timezone.localdate()
    due = list(Membership.objects.filter(
        status=MembershipStatus.ACTIVE, end_date__lt=today))
    for m in due:
        m.status = MembershipStatus.EXPIRED
        m.save(update_fields=["status", "updated_at"])
        # Re-price any open booking it was covering — an expired membership can't
        # complete a booking for free either.
        revalidate_membership_bookings(m, reason="expired")
        log_system_event("membership_expired", {"membership": m.number},
                         subject=("membership", m.id))
    return len(due)


# --------------------------------------------------------------------------- #
# Invoices
# --------------------------------------------------------------------------- #
def _sync_booking_payment(booking, *, request=None):
    """Keep booking.payment_status mirroring the Payment/Invoice ledger after any
    money movement (capture or refund). No-op for non-booking (membership/ad-hoc)
    payments. Lazy import avoids a bookings<->payments import cycle."""
    if booking is None:
        return
    from apps.bookings.services import sync_booking_payment_status
    sync_booking_payment_status(booking)


def _bill_to(customer, booking):
    """Bill-to (name, email, trn) snapshot for the invoice document. Uses the
    customer account when present, else the booking's walk-in details (B2C)."""
    if customer is not None:
        return (
            (customer.full_name or customer.email or "")[:160],
            (customer.email or "")[:254],
            (getattr(customer, "trn", "") or "")[:30],
        )
    if booking is not None:
        return (booking.walk_in_name or "Walk-in customer")[:160], (booking.walk_in_email or "")[:254], ""
    return "Walk-in customer", "", ""


@transaction.atomic
def create_invoice(*, customer=None, booking=None, payment=None, membership=None,
                   purpose=InvoicePurpose.SALE, amount=None, request=None,
                   render_pdf=True) -> Invoice:
    """Create a VAT invoice from a booking's price snapshot (or a payment).

    Reuses the booking's frozen subtotal/tax/total so the document always
    matches what was charged. Falls back to the payment amount otherwise.
    Customer is optional — walk-in (B2C) bookings invoice against a bill-to
    snapshot taken from their walk-in details.
    """
    if customer is None and booking is not None:
        customer = booking.customer            # may stay None for a walk-in
    tax_rate = Decimal(str(settings.DEFAULT_TAX_RATE))
    currency = get_default_currency()

    if booking is not None:
        currency = booking.currency
        if amount is not None:
            # Delta / increment invoice (e.g. add-ons billed after the first
            # payment): document only the amount being paid now, VAT reverse-derived,
            # so paid services are never re-listed or double-charged.
            total = Decimal(str(amount))
            if total <= 0:
                raise ValueError("Nothing to invoice - no payable amount.")
            subtotal = quantize_money(total / (Decimal("1") + tax_rate), currency)
            tax = quantize_money(total - subtotal, currency)
        else:
            # A fully subscription-covered (or otherwise 0-payable) booking has
            # nothing to invoice — refuse rather than raise a stale 0-value document.
            if not booking.total_amount or Decimal(booking.total_amount) <= 0:
                raise ValueError(
                    "Nothing to invoice - this booking is fully covered or has no payable amount.")
            # Derive subtotal from the booking's final rule-adjusted total so the
            # document is always internally consistent (subtotal + tax == total) and
            # reflects every adjustment — surcharges included, and VAT-inclusive too.
            total = Decimal(booking.total_amount)
            tax = Decimal(booking.tax_amount)
            subtotal = quantize_money(total - tax, currency)
    elif payment is not None:
        # Reverse-derive subtotal/tax from a gross payment amount.
        currency = payment.currency
        total = Decimal(payment.amount)
        subtotal = quantize_money(total / (Decimal("1") + tax_rate), currency)
        tax = quantize_money(total - subtotal, currency)
    else:
        raise ValueError("create_invoice requires a booking or a payment.")

    # Audit-safe trail: carry the booking's raw (pre-round) total when present,
    # else the source amount; record the rounding difference applied to `total`.
    raw_total = (Decimal(booking.total_raw)
                 if (booking is not None and amount is None and booking.total_raw) else total)
    total_extended = round_extended(raw_total, currency)
    rounding_difference = total - raw_total

    paid = payment is not None and payment.status == PaymentStatus.PAID
    bill_to_name, bill_to_email, bill_to_trn = _bill_to(customer, booking)
    invoice = Invoice.objects.create(
        customer=customer, booking=booking, payment=payment, membership=membership,
        bill_to_name=bill_to_name, bill_to_email=bill_to_email, bill_to_trn=bill_to_trn,
        currency=currency, subtotal=subtotal, tax_amount=tax,
        total=total, tax_rate=tax_rate,
        total_raw=raw_total, total_extended=total_extended,
        rounding_difference=rounding_difference,
        status=(InvoiceStatus.PAID if paid else InvoiceStatus.ISSUED),
        purpose=purpose,
    )
    if render_pdf:
        # Async when a worker is configured; inline otherwise (eager). The
        # download endpoint also renders on demand if the PDF isn't ready yet.
        from .tasks import render_invoice_pdf_task
        render_invoice_pdf_task.delay(invoice.id)
    if request:
        log_event(request, "invoice_created",
                  {"invoice": invoice.number, "total": str(invoice.total)})
    _booking_timeline(invoice.booking, f"Invoice {invoice.number} generated", request)
    # A paid-at-creation invoice gets its receipt right away — and the booking is
    # marked paid so the lifecycle (e.g. the completion wizard) never asks for
    # payment again on an already-settled booking.
    if paid:
        issue_receipt(invoice, request=request, render_pdf=render_pdf)
        if booking is not None:
            _sync_booking_payment(booking, request=request)
    return invoice


@transaction.atomic
def cancel_invoice(invoice, reason="", *, request=None) -> Invoice:
    """Withdraw an UNPAID invoice issued in error. Paid invoices must be reversed
    with a credit note instead (the document is never deleted). Audited."""
    if invoice.status == InvoiceStatus.CANCELLED:
        raise ValueError("This invoice is already cancelled.")
    if invoice.status != InvoiceStatus.ISSUED:
        raise ValueError(
            "Only an unpaid (Issued) invoice can be cancelled - issue a credit note instead."
        )
    if invoice.payment_id and invoice.payment.status == PaymentStatus.PAID:
        raise ValueError("This invoice has a payment - issue a credit note instead.")
    invoice.status = InvoiceStatus.CANCELLED
    invoice.cancelled_at = timezone.now()
    invoice.cancel_reason = (reason or "")[:255]
    invoice.save(update_fields=["status", "cancelled_at", "cancel_reason"])
    _invalidate_invoice_pdf(invoice)   # re-render with the CANCELLED stamp on next download
    if request:
        log_event(request, "invoice_cancelled",
                  {"invoice": invoice.number, "reason": invoice.cancel_reason})
    _booking_timeline(invoice.booking, f"Invoice {invoice.number} cancelled", request)
    return invoice


def _invalidate_invoice_pdf(invoice):
    """Drop the cached invoice PDF so it regenerates with the current status
    stamp (CANCELLED / REFUNDED) the next time it's downloaded."""
    if invoice.pdf:
        invoice.pdf.delete(save=True)


@transaction.atomic
def issue_receipt(invoice, *, request=None, render_pdf=True) -> Receipt:
    """Issue the payment receipt for a fully-paid invoice. Idempotent — returns
    the existing receipt if one was already issued."""
    existing = Receipt.objects.filter(invoice=invoice).first()
    if existing:
        return existing
    if invoice.status != InvoiceStatus.PAID:
        raise ValueError("A receipt is only issued once the invoice is paid.")
    payment = invoice.payment
    receipt = Receipt.objects.create(
        invoice=invoice, customer=invoice.customer, payment=payment,
        currency=invoice.currency, amount=invoice.total,
        method=(payment.method if payment else ""),
        created_by=_actor(request),
    )
    if render_pdf:
        from .tasks import render_receipt_pdf_task
        render_receipt_pdf_task.delay(receipt.id)
    if request:
        log_event(request, "receipt_issued",
                  {"receipt": receipt.number, "invoice": invoice.number,
                   "amount": str(receipt.amount)})
    return receipt


@transaction.atomic
def mark_invoice_paid(invoice, payment=None, *, request=None) -> Receipt:
    """Settle an issued invoice and issue its receipt. Links `payment` if given.
    Idempotent — a paid invoice just returns its (existing) receipt."""
    if invoice.status == InvoiceStatus.PAID:
        return issue_receipt(invoice, request=request)
    if invoice.status != InvoiceStatus.ISSUED:
        raise ValueError("Only an issued invoice can be marked paid.")
    fields = ["status"]
    if payment is not None and invoice.payment_id is None:
        invoice.payment = payment
        fields.append("payment")
    invoice.status = InvoiceStatus.PAID
    invoice.save(update_fields=fields)
    if request:
        log_event(request, "invoice_paid", {"invoice": invoice.number})
    _sync_booking_payment(invoice.booking, request=request)
    return issue_receipt(invoice, request=request)


# --------------------------------------------------------------------------- #
# Refund / credit-note lifecycle (the Credit Note is the official refund doc)
# --------------------------------------------------------------------------- #
def _issued_credit_total(invoice) -> Decimal:
    """Gross value of ISSUED credit notes against an invoice (fresh DB query —
    never the possibly-cached relation)."""
    from django.db.models import Sum
    total = (CreditNote.objects
             .filter(invoice=invoice, status=CreditNoteStatus.ISSUED)
             .aggregate(s=Sum("total"))["s"] or Decimal("0"))
    return quantize_money(total, invoice.currency)


def _committed_credit_total(invoice) -> Decimal:
    """Gross value already issued OR awaiting approval — what's reserved so far."""
    from django.db.models import Sum
    total = (CreditNote.objects
             .filter(invoice=invoice,
                     status__in=[CreditNoteStatus.ISSUED, CreditNoteStatus.PENDING_APPROVAL])
             .aggregate(s=Sum("total"))["s"] or Decimal("0"))
    return quantize_money(total, invoice.currency)


@transaction.atomic
def request_refund(invoice, amount=None, *, reason="", method=None, request=None) -> CreditNote:
    """Request a refund against a PAID invoice by creating a credit note (the
    official refund document). Omit ``amount`` to refund the full remaining
    balance. If org approval is required the credit note is created
    PENDING_APPROVAL (processed on approval); otherwise it is processed (the money
    returned + statuses synced) immediately. Raises ValueError on invalid state."""
    from apps.settings_app.models import Organization

    if invoice.status not in (InvoiceStatus.PAID, InvoiceStatus.PARTIALLY_REFUNDED):
        raise ValueError("Only a paid invoice can be refunded.")
    # Available excludes both issued AND still-pending credit notes so concurrent
    # or duplicate requests can't over-commit the invoice.
    available = quantize_money(
        Decimal(invoice.total) - _committed_credit_total(invoice), invoice.currency)
    amount = quantize_money(Decimal(amount) if amount is not None else available, invoice.currency)
    if amount <= 0:
        raise ValueError("Refund amount must be greater than zero.")
    if amount > available:
        raise ValueError("Refund amount exceeds the invoice's remaining refundable balance.")

    pay = invoice.payment if invoice.payment_id else None
    target_method = method or (pay.method if pay else PaymentMethod.CASH)
    rate = Decimal(invoice.tax_rate)
    subtotal = quantize_money(amount / (Decimal("1") + rate), invoice.currency)
    tax = quantize_money(amount - subtotal, invoice.currency)

    credit_note = CreditNote.objects.create(
        invoice=invoice, customer=invoice.customer,
        currency=invoice.currency, subtotal=subtotal, tax_amount=tax, total=amount,
        tax_rate=rate, total_raw=amount, total_extended=round_extended(amount, invoice.currency),
        rounding_difference=Decimal("0"), reason=(reason or "")[:255],
        method=target_method, status=CreditNoteStatus.PENDING_APPROVAL,
        requested_by=_actor(request), created_by=_actor(request),
    )
    if request:
        log_event(request, "refund_requested",
                  {"credit_note": credit_note.number, "invoice": invoice.number,
                   "amount": str(amount), "from": "", "to": CreditNoteStatus.PENDING_APPROVAL.value})

    # Auto-issue when approval isn't required OR the requester is themselves an
    # approver (they hold invoicing.credit_approve) — a self-approval, fully logged.
    actor = _actor(request)
    is_approver = bool(actor and actor.has_perm_code("invoicing.credit_approve"))
    if not Organization.get_solo().require_refund_approval or is_approver:
        if is_approver:
            credit_note.approved_by = actor
            credit_note.approved_at = timezone.now()
            credit_note.save(update_fields=["approved_by", "approved_at"])
            if request:
                log_event(request, "refund_approved",
                          {"credit_note": credit_note.number, "invoice": invoice.number,
                           "amount": str(amount), "self_approved": True})
        _process_credit_note(credit_note, request=request)   # money returned now
    else:
        _booking_timeline(
            invoice.booking,
            f"Refund requested {credit_note.number} - "
            f"{format_currency(amount, invoice.currency)} (pending approval)",
            request)
        # Alert approvers in their in-app bell feed so a pending refund is actioned.
        _notify_refund_approvers(credit_note, exclude=actor, request=request)
    credit_note.refresh_from_db()
    return credit_note


def _notify_refund_approvers(credit_note, *, exclude=None, request=None):
    """In-app notify every user who can approve refunds that one is pending."""
    from apps.accounts.models import User
    from apps.notifications.services import notify_in_app_many
    approvers = [u for u in User.objects.filter(is_active=True)
                 if u.id != getattr(exclude, "id", None)
                 and u.has_perm_code("invoicing.credit_approve")]
    notify_in_app_many(
        approvers,
        subject=f"Refund {credit_note.number} awaiting approval",
        body=(f"{format_currency(credit_note.total, credit_note.currency)} refund on invoice "
              f"{credit_note.invoice.number} needs your approval."),
        event="refund_pending_approval", link=f"/credit-notes/{credit_note.id}",
        context={"credit_note": credit_note.number, "invoice": credit_note.invoice.number,
                 "amount": str(credit_note.total)})


@transaction.atomic
def approve_refund(credit_note, *, request=None) -> CreditNote:
    """Approve a pending refund and process it (issue the credit note + return the
    money)."""
    if credit_note.status != CreditNoteStatus.PENDING_APPROVAL:
        raise ValueError("Only a pending refund can be approved.")
    credit_note.approved_by = _actor(request)
    credit_note.approved_at = timezone.now()
    credit_note.save(update_fields=["approved_by", "approved_at"])
    if request:
        log_event(request, "refund_approved",
                  {"credit_note": credit_note.number, "invoice": credit_note.invoice.number,
                   "amount": str(credit_note.total)})
    _process_credit_note(credit_note, request=request)
    credit_note.refresh_from_db()
    return credit_note


@transaction.atomic
def reject_refund(credit_note, *, remarks="", request=None) -> CreditNote:
    """Reject a pending refund. No money moves; the credit note keeps its number,
    marked REJECTED."""
    if credit_note.status != CreditNoteStatus.PENDING_APPROVAL:
        raise ValueError("Only a pending refund can be rejected.")
    prev = credit_note.status
    credit_note.status = CreditNoteStatus.REJECTED
    credit_note.rejected_by = _actor(request)
    credit_note.rejected_at = timezone.now()
    credit_note.remarks = (remarks or "")[:500]
    credit_note.save(update_fields=["status", "rejected_by", "rejected_at", "remarks"])
    if request:
        log_event(request, "refund_rejected",
                  {"credit_note": credit_note.number, "invoice": credit_note.invoice.number,
                   "amount": str(credit_note.total),
                   "from": str(prev), "to": str(CreditNoteStatus.REJECTED.value)})
    _booking_timeline(credit_note.invoice.booking,
                      f"Refund {credit_note.number} rejected", request)
    # Tell the person who raised the refund that it was rejected — in-app bell,
    # deep-linked to the refund so they can see the reason / who rejected it.
    if credit_note.requested_by_id:
        from apps.notifications.services import notify_in_app
        notify_in_app(
            credit_note.requested_by,
            subject=f"Refund {credit_note.number} was rejected",
            body=(f"Your {format_currency(credit_note.total, credit_note.currency)} refund on "
                  f"invoice {credit_note.invoice.number} was rejected"
                  + (f": {credit_note.remarks}" if credit_note.remarks else ".")),
            event="refund_rejected", link=f"/credit-notes/{credit_note.id}",
            context={"credit_note": credit_note.number})
    return credit_note


@transaction.atomic
def _process_credit_note(credit_note, *, request=None) -> CreditNote:
    """Issue a credit note: return the money on the originating payment, keep
    Invoice + Payment statuses synchronized, mark the credit note ISSUED. Locks the
    payment row to avoid concurrent over-refunds. Idempotent (no-op if already
    issued)."""
    if credit_note.status == CreditNoteStatus.ISSUED:
        return credit_note
    invoice = credit_note.invoice
    amount = quantize_money(credit_note.total, invoice.currency)

    # Always reverse the originating payment so Invoice + Payment stay in sync. The
    # credit note's `method` is recorded for the document; `refund()` returns the
    # money on the original instrument (wallet credit for wallet payments, gateway
    # reversal otherwise).
    refund_obj = None
    pay = (Payment.objects.select_for_update().get(pk=invoice.payment_id)
           if invoice.payment_id else None)
    if pay is not None and pay.status in (PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED):
        cap = min(amount, pay.refundable_amount)
        if cap > 0:
            refund_obj = refund(
                pay, cap, reason=credit_note.reason or f"Credit note {credit_note.number}",
                method=credit_note.method or pay.method, request=request)

    credit_note.refund = refund_obj
    credit_note.status = CreditNoteStatus.ISSUED
    credit_note.issued_at = timezone.now()
    credit_note.save(update_fields=["refund", "status", "issued_at"])

    # Sync the invoice from the ISSUED credit-note total (fresh query).
    refundable_after = max(Decimal("0"), Decimal(invoice.total) - _issued_credit_total(invoice))
    prev_status = invoice.status
    invoice.status = (InvoiceStatus.REFUNDED if refundable_after <= 0
                      else InvoiceStatus.PARTIALLY_REFUNDED)
    invoice.save(update_fields=["status"])
    _invalidate_invoice_pdf(invoice)
    # A full reversal frees the booking's coverage lock — re-derive its status.
    _sync_booking_payment(invoice.booking, request=request)

    from .tasks import render_credit_note_pdf_task
    render_credit_note_pdf_task.delay(credit_note.id)
    if request:
        log_event(request, "credit_note_issued",
                  {"credit_note": credit_note.number, "invoice": invoice.number,
                   "amount": str(amount), "from": prev_status,
                   "to": invoice.status, "payment_status": (pay.status if pay else None)})
    _booking_timeline(
        invoice.booking,
        f"Credit note {credit_note.number} issued - refund {format_currency(amount, invoice.currency)}",
        request)
    # Loyalty: reverse earned points in proportion to the refund (fail-safe).
    try:
        from apps.loyalty.services import reverse_loyalty_for_refund
        reverse_loyalty_for_refund(credit_note, request=request)
    except Exception:  # pragma: no cover - loyalty must never break a refund
        pass
    return credit_note


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _actor(request):
    user = getattr(request, "user", None)
    return user if (user and user.is_authenticated) else None


def _booking_timeline(booking, note, request):
    """Mirror a finance event (invoice generated/cancelled, credit note) onto the
    booking's status timeline so major changes are visible there. Best-effort."""
    if not booking:
        return
    from apps.bookings.services import record_booking_event
    actor = getattr(request, "user", None)
    record_booking_event(booking, note,
                         actor=actor if (actor and actor.is_authenticated) else None)


def _audit_payment(request, event, payment):
    if not request:
        return
    log_event(request, event, {
        "payment": payment.reference,
        "amount": str(payment.amount),
        "method": payment.method,
        "booking": payment.booking.reference if payment.booking_id else None,
    })
