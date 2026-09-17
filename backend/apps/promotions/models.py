"""Promo / discount codes — single or bulk-generated, with usage limits,
validity windows, and order constraints."""

from django.conf import settings
from django.db import models
from django.utils import timezone


class PromoCode(models.Model):
    class DiscountType(models.TextChoices):
        PERCENT = "percent", "Percentage"
        FIXED = "fixed", "Fixed amount"

    class AppliesTo(models.TextChoices):
        ALL = "all", "All services & add-ons"
        CATEGORY = "category", "Specific categories"
        PACKAGE = "package", "Specific services"
        ADDON = "addon", "Specific add-ons"

    code = models.CharField(max_length=40, unique=True, db_index=True)
    description = models.CharField(max_length=200, blank=True)

    discount_type = models.CharField(max_length=10, choices=DiscountType.choices,
                                     default=DiscountType.PERCENT)
    discount_value = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    # Cap applied to a percentage discount (optional).
    max_discount_amount = models.DecimalField(max_digits=11, decimal_places=3, null=True, blank=True)
    # Minimum order/booking total required to redeem.
    min_order_amount = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    # For fixed-amount codes; blank = system default currency.
    currency = models.CharField(max_length=3, blank=True)

    valid_from = models.DateField(null=True, blank=True)
    valid_to = models.DateField(null=True, blank=True)

    # null = unlimited
    usage_limit = models.PositiveIntegerField(null=True, blank=True)
    usage_limit_per_customer = models.PositiveIntegerField(null=True, blank=True)
    used_count = models.PositiveIntegerField(default=0)

    first_order_only = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    # Scope: ALL by default; otherwise specific categories, services, or add-ons.
    applies_to = models.CharField(max_length=10, choices=AppliesTo.choices, default=AppliesTo.ALL)
    categories = models.ManyToManyField("facilities.FacilityCategory", blank=True, related_name="promo_codes")
    services = models.ManyToManyField("facilities.FacilityType", blank=True, related_name="promo_codes")
    addons = models.ManyToManyField("facilities.AddOn", blank=True, related_name="promo_codes")

    # Codes created together in one bulk run share a batch tag.
    batch = models.CharField(max_length=40, blank=True, db_index=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                                   on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["is_active", "valid_to"])]

    def __str__(self):
        return self.code

    @property
    def status(self):
        """Lifecycle: inactive / scheduled / expired / exhausted / active."""
        if not self.is_active:
            return "inactive"
        today = timezone.localdate()
        if self.valid_from and today < self.valid_from:
            return "scheduled"
        if self.valid_to and today > self.valid_to:
            return "expired"
        if self.usage_limit is not None and self.used_count >= self.usage_limit:
            return "exhausted"
        return "active"

    @property
    def remaining(self):
        """Redemptions left, or None when unlimited."""
        if self.usage_limit is None:
            return None
        return max(0, self.usage_limit - self.used_count)


class PromoRedemption(models.Model):
    """A single use of a promo code — who, when, how much, on which booking."""

    promo = models.ForeignKey(PromoCode, on_delete=models.CASCADE, related_name="redemptions")
    customer = models.ForeignKey("customers.Customer", null=True, blank=True,
                                 on_delete=models.SET_NULL, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                             on_delete=models.SET_NULL, related_name="+")
    booking = models.ForeignKey("bookings.Booking", null=True, blank=True,
                                on_delete=models.SET_NULL, related_name="promo_redemptions")
    discount_amount = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)

    def __str__(self):
        return f"{self.promo.code} @ {self.created_at:%Y-%m-%d}"
