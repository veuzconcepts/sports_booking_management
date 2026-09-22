"""Reusable pricing engine — applies PricingRule adjustments on top of a base price.

`calculate_price(...)` is the single source of truth for dynamic pricing and is
intended to be reused by booking creation, invoice generation and payment calc.
`apply_adjustment(...)` is the low-level primitive (also used by the form preview).
"""

from decimal import Decimal

from apps.settings_app.currency import (
    get_default_currency,
    round_extended,
    round_money,
)

from django.db.models import Q

from .models import PricingAdjustmentType, PricingRule


def _d(v):
    return v if isinstance(v, Decimal) else Decimal(str(v or 0))


def _q(v):
    # FINAL rounding to the active currency's minor units (MAU + method).
    return round_money(v)


def apply_adjustment(base, adjustment_type, value):
    """Return (new_price, delta) after applying one adjustment to `base`."""
    base = _d(base)
    value = _d(value)
    T = PricingAdjustmentType
    if adjustment_type == T.FIXED_INCREASE:
        return base + value, value
    if adjustment_type == T.FIXED_DISCOUNT:
        return base - value, -value
    if adjustment_type == T.PERCENT_INCREASE:
        delta = base * value / Decimal(100)
        return base + delta, delta
    if adjustment_type == T.PERCENT_DISCOUNT:
        delta = base * value / Decimal(100)
        return base - delta, -delta
    if adjustment_type == T.OVERRIDE:
        return value, value - base
    return base, Decimal(0)


def _pct(v):
    """Percentage with no trailing zeros: 20.000 -> '20', 7.50 -> '7.5'."""
    d = _d(v)
    d = d.to_integral_value() if d == d.to_integral_value() else d.normalize()
    return f"{d:f}"


def adjustment_label(adjustment_type, value, currency=None):
    """Human-readable adjustment, e.g. '+ SAR 15.00', '-10%', 'Override 99.00'."""
    cur = currency or get_default_currency()
    money = _q(value)
    T = PricingAdjustmentType
    if adjustment_type == T.FIXED_INCREASE:
        return f"+ {cur} {money}"
    if adjustment_type == T.FIXED_DISCOUNT:
        return f"- {cur} {money}"
    if adjustment_type == T.PERCENT_INCREASE:
        return f"+{_pct(value)}%"
    if adjustment_type == T.PERCENT_DISCOUNT:
        return f"-{_pct(value)}%"
    if adjustment_type == T.OVERRIDE:
        return f"Override {cur} {money}"
    return str(money)


def _related_ids(rule, field) -> set:
    """The ids on one of a rule's target/condition relations.

    Memoised on the instance, and served from `prefetch_related` when the
    caller arranged one. `values_list` always issues its own query even on a
    prefetched relation, which turned matching a month of dates against a
    handful of rules into hundreds of round trips.
    """
    cache = rule.__dict__.setdefault("_pricing_related_ids", {})
    if field not in cache:
        manager = getattr(rule, field)
        prefetched = getattr(rule, "_prefetched_objects_cache", {}).get(field)
        cache[field] = ({obj.id for obj in prefetched} if prefetched is not None
                        else set(manager.values_list("id", flat=True)))
    return cache[field]


def _matches(rule, *, facility_type, category, category_ids, addon_ids,
             club_id, customer_type, membership_plan_id, booking_date, booking_time,
             amount, quantity, period=None):
    """Return True if `rule` applies to the given context."""
    # Peak/off-peak. A rule that names no periods applies to all of them, so
    # classifying a shift can never change a price until a rule asks for it.
    if rule.period_types and period is not None and period not in rule.period_types:
        return False
    # Target scope — if any target set, the item must fall inside it.
    cat_ids = _related_ids(rule, "categories")
    ft_ids = _related_ids(rule, "facility_types")
    add_ids = _related_ids(rule, "addons")
    if cat_ids or ft_ids or add_ids:
        # Categories the booking belongs to: the high-level `facility_category`
        # link AND/OR the facility type's own categories (so type-based bookings -
        # admin catalogue + all website bookings - match category-scoped rules).
        ctx_cats = set(category_ids or [])
        if category is not None:
            ctx_cats.add(category)
        hit = False
        if ft_ids and facility_type is not None and facility_type.id in ft_ids:
            hit = True
        if cat_ids and (cat_ids & ctx_cats):
            hit = True
        if add_ids and addon_ids and (set(addon_ids) & add_ids):
            hit = True
        if not hit:
            return False

    # Club
    club_ids = _related_ids(rule, "clubs")
    if club_ids and (club_id is None or club_id not in club_ids):
        return False

    # Customer type
    if rule.customer_types and (customer_type not in rule.customer_types):
        return False

    # Membership plan
    plan_ids = _related_ids(rule, "membership_plans")
    if plan_ids and (membership_plan_id is None or membership_plan_id not in plan_ids):
        return False

    # Days of week (0=Mon .. 6=Sun)
    if rule.days_of_week and booking_date is not None:
        if booking_date.weekday() not in rule.days_of_week:
            return False

    # Date range
    if rule.valid_from and booking_date and booking_date < rule.valid_from:
        return False
    if rule.valid_to and booking_date and booking_date > rule.valid_to:
        return False

    # Time range
    if rule.start_time and booking_time and booking_time < rule.start_time:
        return False
    if rule.end_time and booking_time and booking_time > rule.end_time:
        return False

    # Thresholds
    if rule.min_amount is not None and _d(amount) < rule.min_amount:
        return False
    if rule.min_quantity is not None and (quantity or 0) < rule.min_quantity:
        return False

    return True


def calculate_price(base_price, *, facility_type=None, category=None, category_ids=None,
                    addon_ids=None, club_id=None, customer_type=None,
                    membership_plan_id=None, booking_date=None, booking_time=None,
                    quantity=1, rules=None, period=None):
    """Apply all matching active pricing rules (by priority) to a base price.

    Returns: { base_price, applied_rules[], total_discount, total_surcharge,
               final_price, currency }
    """
    running = _d(base_price)
    total_discount = Decimal(0)
    total_surcharge = Decimal(0)
    applied = []

    qs = rules if rules is not None else PricingRule.objects.filter(is_active=True)
    qs = qs.order_by("priority", "display_order", "id")

    for rule in qs:
        if not _matches(
            rule, facility_type=facility_type, category=category, category_ids=category_ids,
            addon_ids=addon_ids or [], club_id=club_id,
            customer_type=customer_type, membership_plan_id=membership_plan_id,
            booking_date=booking_date, booking_time=booking_time, amount=running,
            quantity=quantity, period=period,
        ):
            continue

        running, delta = apply_adjustment(running, rule.adjustment_type, rule.adjustment_value)
        # Keep the running total at EXTENDED precision through the chain; the
        # caller rounds the final amount to standard precision once.
        running = round_extended(running)
        if delta < 0:
            total_discount += -delta
        elif delta > 0:
            total_surcharge += delta

        _updated = getattr(rule, "updated_at", None)
        applied.append({
            "id": rule.id,
            "name": rule.name,
            "code": rule.code,
            "rule_type": rule.rule_type,
            "rule_type_display": rule.get_rule_type_display(),
            "adjustment": adjustment_label(rule.adjustment_type, rule.adjustment_value, rule.currency),
            "amount": float(_q(delta)),
            "tax_applicable": rule.tax_applicable,
            "version": _updated.isoformat() if _updated else None,
        })

        if not rule.allow_stacking:
            break

    if running < 0:
        running = Decimal(0)

    return {
        "base_price": float(_q(base_price)),
        "applied_rules": applied,
        "total_discount": float(_q(total_discount)),
        "total_surcharge": float(_q(total_surcharge)),
        # Subtotal kept at EXTENDED precision so unit-price precision survives into
        # the booking; the booking rounds the FINAL total to currency precision once.
        "final_price": float(round_extended(running)),
        "currency": get_default_currency(),
    }
# --------------------------------------------------------------------------- #
# Customer-facing offers
#
# What the booking calendar is allowed to advertise on a date. This is a
# READING of the pricing rules, never a second set of them: the badge says
# "there is something here", and `calculate_price` still decides what is
# actually charged. Nothing below computes a price a customer will pay.
# --------------------------------------------------------------------------- #

#: Only these read as an offer. A surcharge is not an offer, and an override
#: may be either, so it is left out rather than guessed at.
OFFER_ADJUSTMENTS = (
    PricingAdjustmentType.PERCENT_DISCOUNT,
    PricingAdjustmentType.FIXED_DISCOUNT,
)


def offer_candidates(first, last, *, facility_type=None, club_id=None):
    """Discount rules that could apply somewhere in [first, last].

    Loaded once for a whole calendar month and then tested per date in memory,
    so painting a month costs one query rather than one per day. The date
    filter here is only a coarse narrowing; `_matches` still decides each date.
    """
    qs = (PricingRule.objects
          .filter(is_active=True, adjustment_type__in=OFFER_ADJUSTMENTS)
          .filter(Q(valid_from__isnull=True) | Q(valid_from__lte=last))
          .filter(Q(valid_to__isnull=True) | Q(valid_to__gte=first))
          .prefetch_related("clubs", "facility_types", "categories",
                            "addons", "membership_plans")
          .order_by("priority", "display_order", "id"))
    return list(qs)


def offer_label(rule) -> str:
    """The short text a calendar badge can carry.

    Deliberately terse: a date cell has room for "-20%", not for a campaign
    slogan. The rule's own name is exposed separately, for the detail line.
    """
    if rule.adjustment_type == PricingAdjustmentType.PERCENT_DISCOUNT:
        return f"-{_pct(rule.adjustment_value)}%"
    currency = rule.currency or get_default_currency()
    return f"{currency} {_q(rule.adjustment_value)}"


def date_offer(on_date, rules, *, facility_type=None, category_ids=None,
               club_id=None, base_amount=None):
    """The one offer to advertise for a date, or None.

    Several rules can apply to the same day. Stacking badges in a date cell is
    unreadable, so the highest-priority one is shown and the rest are counted.
    Priority is the pricing engine's own ordering, so the badge and the money
    agree about which offer matters most.

    A rule confined to part of the day is reported as `time_limited`, because
    "20% off" on a date that only discounts the morning would be a lie. The
    caller shows a neutral "Offer" for those instead of the number.
    """
    matched = []
    for rule in rules:
        if not _matches(
            rule, facility_type=facility_type, category=None,
            category_ids=category_ids or [], addon_ids=[], club_id=club_id,
            customer_type=None, membership_plan_id=None,
            booking_date=on_date, booking_time=None,
            amount=_d(base_amount or 0), quantity=1,
        ):
            continue
        # A rule needing a minimum spend or a membership is not something the
        # calendar can promise before any of that is known.
        if rule.min_amount is not None and base_amount is None:
            continue
        if _related_ids(rule, "membership_plans") or rule.customer_types:
            continue
        matched.append(rule)

    if not matched:
        return None

    best = matched[0]
    is_percent = best.adjustment_type == PricingAdjustmentType.PERCENT_DISCOUNT
    return {
        "type": "percentage" if is_percent else "fixed",
        "value": float(_q(best.adjustment_value)),
        "label": offer_label(best),
        "name": best.name,
        # Set when the rule covers only part of the day: the date carries a
        # neutral marker and the slot list shows which times actually qualify.
        "time_limited": bool(best.start_time or best.end_time),
        # Anything beyond the one being shown, for a quiet "+2".
        "others": len(matched) - 1,
    }


def slot_offer(on_date, at_time, rules, *, facility_type=None, category_ids=None,
               club_id=None, base_amount=None):
    """The offer applying to one specific time, or None.

    Same reading as `date_offer`, narrowed by the clock, so a customer opening
    a date can see which of its times the advertised discount actually covers.
    """
    narrowed = [
        rule for rule in rules
        if _matches(
            rule, facility_type=facility_type, category=None,
            category_ids=category_ids or [], addon_ids=[], club_id=club_id,
            customer_type=None, membership_plan_id=None,
            booking_date=on_date, booking_time=at_time,
            amount=_d(base_amount or 0), quantity=1,
        )
        and not (rule.min_amount is not None and base_amount is None)
        and not _related_ids(rule, "membership_plans") and not rule.customer_types
    ]
    if not narrowed:
        return None
    best = narrowed[0]
    return {
        "type": ("percentage"
                 if best.adjustment_type == PricingAdjustmentType.PERCENT_DISCOUNT
                 else "fixed"),
        "value": float(_q(best.adjustment_value)),
        "label": offer_label(best),
        "name": best.name,
    }
