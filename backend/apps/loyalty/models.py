"""Loyalty configuration + tiers.

`LoyaltyConfiguration` is a single-row, admin-editable settings model (same
`get_solo()` pattern as `settings_app.BookingConfiguration`) controlling how
points are earned, redeemed and expired. `LoyaltyTier` defines the configurable
tiers a customer is promoted into. The point LEDGER and per-customer balance live
on `apps.customers` (the existing `LoyaltyLedger` + `Customer` fields), so this
app owns rules/tiers + the engine, while customer data stays with the customer.
"""

from decimal import Decimal

from django.db import models


class LoyaltyConfiguration(models.Model):
    """Single-row loyalty rules: earning, redemption, expiry."""

    # --- Earning -----------------------------------------------------------
    earning_enabled = models.BooleanField(default=False)
    # When points are awarded. "completion" (default) = when a booking is
    # completed AND paid; "payment" = as soon as payment is captured.
    EARN_ON_COMPLETION = "completion"
    EARN_ON_PAYMENT = "payment"
    EARN_TRIGGERS = [(EARN_ON_COMPLETION, "On completion"), (EARN_ON_PAYMENT, "On payment")]
    earn_trigger = models.CharField(max_length=12, choices=EARN_TRIGGERS, default=EARN_ON_COMPLETION)
    # Points awarded per 1.0 of net paid amount (e.g. 1 => 1 point per AED).
    points_per_currency = models.DecimalField(max_digits=8, decimal_places=3, default=Decimal("1"))
    # Flat points granted on every qualifying booking, on top of the amount rule.
    fixed_points_per_booking = models.PositiveIntegerField(default=0)
    # Optional bonus points keyed by id: {"<facility_type_id>": 50, ...} etc.
    service_bonuses = models.JSONField(default=dict, blank=True)
    package_bonuses = models.JSONField(default=dict, blank=True)
    membership_bonuses = models.JSONField(default=dict, blank=True)

    # --- Redemption --------------------------------------------------------
    redemption_enabled = models.BooleanField(default=False)
    # Money value of one point (e.g. 0.05 => 1 point = AED 0.05).
    currency_per_point = models.DecimalField(max_digits=8, decimal_places=3, default=Decimal("0"))
    min_redeem_points = models.PositiveIntegerField(default=0)
    # 0 = no cap.
    max_redeem_points_per_booking = models.PositiveIntegerField(default=0)
    # Cap redemption to this % of the booking payable (0 = no cap).
    max_redeem_percent = models.PositiveIntegerField(default=0)
    stack_with_promo = models.BooleanField(default=True)
    stack_with_membership = models.BooleanField(default=True)

    # --- Expiry ------------------------------------------------------------
    # Months after which earned points expire (0 = never). Enforced by the
    # `loyalty_maintenance` management command; off until configured.
    expiry_months = models.PositiveIntegerField(default=0)

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Loyalty Configuration"

    def __str__(self):
        return "Loyalty Configuration"

    @classmethod
    def get_solo(cls):
        """Return the single config row, creating it (with defaults) on first access."""
        obj = cls.objects.first()
        return obj or cls.objects.create()


class LoyaltyTier(models.Model):
    """A configurable loyalty tier. A customer is promoted to the highest active
    tier whose thresholds they meet (blank threshold = not required). Upgrade-only:
    the recompute never lowers a customer's tier."""

    name = models.CharField(max_length=60)
    # Stable key stored on `customer.loyalty_tier` (e.g. bronze/silver/gold/platinum).
    slug = models.SlugField(max_length=40, unique=True)
    rank = models.PositiveIntegerField(default=0, help_text="Order, low = entry tier.")
    # Thresholds (null = not required for this tier).
    min_points = models.PositiveIntegerField(null=True, blank=True)
    min_spend = models.DecimalField(max_digits=13, decimal_places=3, null=True, blank=True)
    # Benefits.
    discount_percent = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal("0"))
    priority_booking = models.BooleanField(default=False)
    benefits = models.TextField(blank=True)
    color = models.CharField(max_length=20, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ("rank",)

    def __str__(self):
        return self.name
