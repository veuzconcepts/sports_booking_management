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


def _matches(rule, *, facility_type, category, category_ids, addon_ids,
             club_id, customer_type, membership_plan_id, booking_date, booking_time,
             amount, quantity):
    """Return True if `rule` applies to the given context."""
    # Target scope — if any target set, the item must fall inside it.
    cat_ids = set(rule.categories.values_list("id", flat=True))
    ft_ids = set(rule.facility_types.values_list("id", flat=True))
    add_ids = set(rule.addons.values_list("id", flat=True))
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
    club_ids = set(rule.clubs.values_list("id", flat=True))
    if club_ids and (club_id is None or club_id not in club_ids):
        return False

    # Customer type
    if rule.customer_types and (customer_type not in rule.customer_types):
        return False

    # Membership plan
    plan_ids = set(rule.membership_plans.values_list("id", flat=True))
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
                    quantity=1, rules=None):
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
            booking_date=booking_date, booking_time=booking_time, amount=running, quantity=quantity,
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
