"""Read-only valuation of a membership plan's included facilities / add-ons.

Informational only. It mirrors ``Booking.compute_pricing``'s catalogue price
resolution so the figures agree with what a real booking would charge - but it
applies NO pricing rules, promos, or per-item discounts (those are
booking-context). Unlimited entitlements have no finite value and are listed
separately, never summed into the number. Nothing here writes data or affects
pricing/entitlement logic.
"""

from decimal import Decimal

from apps.settings_app.currency import get_default_currency, quantize_money

from .models import EntitlementLimit, EntitlementTarget


def _unit_value(target_type, *, facility_type, facility_category, addon):
    """List price of ONE unit of an entitlement's target, resolved exactly as
    ``Booking.compute_pricing`` does (no rules / discounts)."""
    if target_type == EntitlementTarget.FACILITY_TYPE and facility_type is not None:
        return Decimal(facility_type.price)
    if target_type == EntitlementTarget.CATEGORY and facility_category is not None:
        return Decimal(facility_category.base_price)
    if target_type == EntitlementTarget.ADDON and addon is not None:
        return Decimal(addon.price)
    return Decimal("0")


def _label(target_type, *, facility_type, facility_category, addon):
    obj = {
        EntitlementTarget.FACILITY_TYPE: facility_type,
        EntitlementTarget.CATEGORY: facility_category,
        EntitlementTarget.ADDON: addon,
    }.get(target_type)
    return getattr(obj, "name", "") or ""


def rows_from_entitlements(entitlements):
    """Adapt saved ``PlanEntitlement`` instances to the row dicts below."""
    return [{
        "target_type": e.target_type,
        "facility_type": e.facility_type,
        "facility_category": e.facility_category,
        "addon": e.addon,
        "limit_type": e.limit_type,
        "quantity": e.quantity,
        "period": e.period,
    } for e in entitlements]


def plan_value_breakdown(entitlement_rows, price, currency=None):
    """Compute a plan's included value + savings against its price.

    ``entitlement_rows``: iterable of dicts with ``target_type``, the resolved
    ``facility_type`` / ``facility_category`` / ``addon`` model instances (or
    None), ``limit_type``, ``quantity`` and ``period``. Limited entitlements
    contribute ``quantity * list price``; unlimited ones are returned in
    ``unlimited`` and excluded from the number. Purely informational - never
    raises on odd data.
    """
    currency = currency or get_default_currency()
    price = Decimal(price or 0)

    limited, unlimited = [], []
    for r in entitlement_rows:
        if r.get("limit_type") == EntitlementLimit.UNLIMITED:
            unlimited.append(r)
        elif r.get("quantity"):
            limited.append(r)

    total = Decimal("0")
    for r in limited:
        total += _unit_value(
            r.get("target_type"), facility_type=r.get("facility_type"),
            facility_category=r.get("facility_category"),
            addon=r.get("addon")) * int(r["quantity"])

    value = quantize_money(total, currency)
    savings = quantize_money(value - price, currency)

    return {
        "currency": currency,
        "price": str(quantize_money(price, currency)),
        "included_value": str(value),
        "savings": str(savings),
        "savings_pct": (round(float(savings / price * 100), 1) if price > 0 else None),
        "unlimited": [{
            "label": _label(r.get("target_type"), facility_type=r.get("facility_type"),
                            facility_category=r.get("facility_category"), addon=r.get("addon")),
            "period": r.get("period"),
        } for r in unlimited],
    }
