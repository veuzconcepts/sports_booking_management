"""Promo redemption logic shared by bookings (validate, price, record)."""

from decimal import Decimal

from django.db.models import F

from apps.settings_app.currency import quantize_money

from .models import PromoCode, PromoRedemption


class PromoError(Exception):
    """Raised when a promo code can't be applied; message is user-facing."""


def get_active_promo(code):
    """Look up a usable promo by code (case-insensitive). Raises PromoError."""
    if not code:
        raise PromoError("Enter a promo code.")
    promo = PromoCode.objects.filter(code=code.strip().upper()).first()
    if not promo:
        raise PromoError("That promo code doesn't exist.")
    if promo.status != "active":
        labels = {"inactive": "is inactive", "scheduled": "isn't active yet",
                  "expired": "has expired", "exhausted": "has no uses left"}
        raise PromoError(f"This promo code {labels.get(promo.status, 'is unavailable')}.")
    return promo


def compute_discount(promo, subtotal):
    """Discount amount for a given subtotal, capped sensibly."""
    subtotal = Decimal(subtotal)
    if promo.discount_type == PromoCode.DiscountType.PERCENT:
        amount = subtotal * Decimal(promo.discount_value) / Decimal("100")
        if promo.max_discount_amount:
            amount = min(amount, Decimal(promo.max_discount_amount))
    else:
        amount = Decimal(promo.discount_value)
    return quantize_money(max(Decimal("0.00"), min(amount, subtotal)))


def validate_for_booking(promo, *, subtotal, customer_id=None, facility_type_id=None,
                         category_ids=(), addon_ids=(), exclude_booking_id=None):
    """Check every constraint; raise PromoError on the first failure."""
    subtotal = Decimal(subtotal)
    if promo.min_order_amount and subtotal < Decimal(promo.min_order_amount):
        raise PromoError(f"Order must be at least {promo.min_order_amount} to use this code.")

    # Scope
    if promo.applies_to == PromoCode.AppliesTo.CATEGORY:
        allowed = set(promo.categories.values_list("id", flat=True))
        if allowed and not (set(category_ids) & allowed):
            raise PromoError("This code doesn't apply to the selected category.")
    elif promo.applies_to == PromoCode.AppliesTo.PACKAGE:
        allowed = set(promo.services.values_list("id", flat=True))
        if allowed and facility_type_id not in allowed:
            raise PromoError("This code doesn't apply to the selected facility_category.")
    elif promo.applies_to == PromoCode.AppliesTo.ADDON:
        allowed = set(promo.addons.values_list("id", flat=True))
        if allowed and not (set(addon_ids) & allowed):
            raise PromoError("This code only applies when a qualifying add-on is selected.")

    # Total usage limit
    if promo.usage_limit is not None and promo.used_count >= promo.usage_limit:
        raise PromoError("This promo code has no uses left.")

    # Per-customer limit
    if promo.usage_limit_per_customer is not None and customer_id is not None:
        used = promo.redemptions.filter(customer_id=customer_id)
        if exclude_booking_id:
            used = used.exclude(booking_id=exclude_booking_id)
        if used.count() >= promo.usage_limit_per_customer:
            raise PromoError("You've already used this code the maximum number of times.")

    # First-order-only
    if promo.first_order_only and customer_id is not None:
        from apps.bookings.models import Booking, BookingStatus
        prior = Booking.objects.filter(
            customer_id=customer_id,
            status=BookingStatus.COMPLETED,
        )
        if exclude_booking_id:
            prior = prior.exclude(pk=exclude_booking_id)
        if prior.exists():
            raise PromoError("This code is for first-time customers only.")


def record_redemption(promo, booking, discount, *, user=None):
    """Create a redemption + bump used_count, once per (promo, booking)."""
    obj, created = PromoRedemption.objects.get_or_create(
        promo=promo, booking=booking,
        defaults={
            "customer": getattr(booking, "customer", None),
            "user": user,
            "discount_amount": discount,
        },
    )
    if not created:
        obj.discount_amount = discount
        obj.save(update_fields=["discount_amount"])
    else:
        PromoCode.objects.filter(pk=promo.pk).update(used_count=F("used_count") + 1)
    return obj
