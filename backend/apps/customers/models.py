"""Customer profile, saved addresses, and a loyalty-points ledger.

A `Customer` is the customer-facing profile attached one-to-one to a `User`
whose role is `customer`. Staff users do not get a `Customer` row.
"""

from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _


class CustomerSource(models.TextChoices):
    WEB = "web", _("Website")
    ADMIN = "admin", _("Admin")
    WALK_IN = "walk_in", _("Walk-in")
    REFERRAL = "referral", _("Referral")
    OTHER = "other", _("Other")


class LoyaltyTier(models.TextChoices):
    BRONZE = "bronze", _("Bronze")
    SILVER = "silver", _("Silver")
    GOLD = "gold", _("Gold")
    PLATINUM = "platinum", _("Platinum")


class CustomerType(models.TextChoices):
    INDIVIDUAL = "individual", _("Individual")
    CORPORATE = "corporate", _("Corporate")
    FLEET = "fleet", _("Fleet")


class CustomerStatus(models.TextChoices):
    ACTIVE = "active", _("Active")
    INACTIVE = "inactive", _("Inactive")


class VerificationMethod(models.TextChoices):
    MANUAL = "manual", _("Verified by staff")
    BOOKING_CONFIRMED = "booking_confirmed", _("Booking confirmed")
    ONLINE_PAYMENT = "online_payment", _("Online payment")


class Customer(models.Model):
    # Optional login. A customer may exist with no User (guest / walk-in /
    # admin-created without login); a User is linked only on signup / verified
    # phone-email / explicit admin "create login". related_name kept as
    # "customer_profile" so user.customer_profile keeps working.
    linked_user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="customer_profile",
    )
    # Set when staff invites the customer to create a mobile login but no User
    # exists yet (login_status = "Invite Pending"). Cleared once linked.
    login_invited_at = models.DateTimeField(null=True, blank=True)

    # --- Profile (business identity — owned by the Customer table) --------- #
    customer_code = models.CharField(max_length=20, unique=True, null=True, blank=True)
    customer_type = models.CharField(
        max_length=12, choices=CustomerType.choices, default=CustomerType.INDIVIDUAL,
    )
    full_name = models.CharField(max_length=160, blank=True)
    mobile_number = models.CharField(max_length=20, blank=True)
    email = models.EmailField(blank=True)   # not unique — guests may share / omit
    whatsapp_number = models.CharField(max_length=20, blank=True)
    gender = models.CharField(max_length=10, blank=True)
    date_of_birth = models.DateField(null=True, blank=True)
    nationality = models.CharField(max_length=80, blank=True)
    preferred_language = models.CharField(max_length=20, blank=True)
    address = models.CharField(max_length=255, blank=True)
    city = models.CharField(max_length=100, blank=True)
    area = models.CharField(max_length=100, blank=True)
    # Recipient Tax Registration Number — printed on tax docs for B2B (VAT-registered) customers.
    trn = models.CharField("Tax Registration Number (TRN)", max_length=30, blank=True)
    status = models.CharField(
        max_length=10, choices=CustomerStatus.choices, default=CustomerStatus.ACTIVE,
    )
    is_vip = models.BooleanField(default=False)
    is_member = models.BooleanField(default=False)
    is_group = models.BooleanField(default=False)

    # Verification: a customer is "verified" once their identity/contact is trusted
    # — set manually (Verify action, permission-gated), automatically when a booking
    # of theirs is confirmed, or on a successful online payment (when the payment
    # gateway is live). Unverified customers can be deleted (junk/fake cleanup);
    # verified ones are protected. The full who/when/how trail lives in the audit
    # log as `customer_verified` events (shown in the customer's Activity Log).
    is_verified = models.BooleanField(default=False)
    verified_at = models.DateTimeField(null=True, blank=True)
    verified_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="+",
    )
    verification_method = models.CharField(max_length=24, blank=True)

    source = models.CharField(
        max_length=20,
        choices=CustomerSource.choices,
        default=CustomerSource.WEB,
    )
    # `loyalty_points` is the CACHED current balance — always reconciled to the
    # append-only LoyaltyLedger by the loyalty engine. `loyalty_tier` is the
    # current tier (read by the pricing engine); it is recomputed by the engine.
    loyalty_points = models.PositiveIntegerField(default=0)
    loyalty_tier = models.CharField(
        max_length=10,
        choices=LoyaltyTier.choices,
        default=LoyaltyTier.BRONZE,
    )
    # Lifetime loyalty aggregates (cached, maintained by the loyalty engine).
    loyalty_points_earned = models.PositiveIntegerField(default=0)
    loyalty_points_redeemed = models.PositiveIntegerField(default=0)
    loyalty_points_expired = models.PositiveIntegerField(default=0)
    # Lifetime net amount paid that counts toward spend-based tier thresholds.
    loyalty_spend = models.DecimalField(max_digits=13, decimal_places=3, default=0)
    tier_since = models.DateField(null=True, blank=True)
    lifetime_value = models.DecimalField(
        max_digits=13, decimal_places=3, default=0,
    )
    member_since = models.DateField(auto_now_add=True)
    is_corporate = models.BooleanField(
        default=False,
        help_text="Fleet / corporate account with PO billing.",
    )
    notes = models.TextField(blank=True)

    # Staff member who registered this customer — record-ownership scoping.
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="+",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="+",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["loyalty_tier"]),
            models.Index(fields=["is_corporate"]),
        ]

    def save(self, *args, **kwargs):
        is_new = self._state.adding
        super().save(*args, **kwargs)
        if is_new and not self.customer_code:
            # Human-friendly, unique customer number starting at C1001.
            self.customer_code = f"C{1000 + self.pk}"
            super().save(update_fields=["customer_code"])

    def __str__(self):
        return f"Customer({self.full_name or self.email or self.customer_code or self.pk})"

    # `full_name`, `email` are now real columns (profile lives on Customer).
    # `phone` stays as a read alias to `mobile_number` so existing callers keep
    # working until the read-sweep (M4); the canonical field is `mobile_number`.
    @property
    def phone(self) -> str:
        return self.mobile_number


class Address(models.Model):
    LABEL_CHOICES = [
        ("home", "Home"),
        ("office", "Office"),
        ("parking", "Parking"),
        ("other", "Other"),
    ]

    customer = models.ForeignKey(
        Customer,
        on_delete=models.CASCADE,
        related_name="addresses",
    )
    label = models.CharField(max_length=20, choices=LABEL_CHOICES, default="home")
    line1 = models.CharField(max_length=255)
    line2 = models.CharField(max_length=255, blank=True)
    city = models.CharField(max_length=100)
    state = models.CharField(max_length=100, blank=True)
    country = models.CharField(max_length=100, default="UAE")
    postal_code = models.CharField(max_length=20, blank=True)
    parking_bay = models.CharField(max_length=50, blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    is_default = models.BooleanField(default=False)
    # True for entries the customer explicitly saved to their address book (the
    # reusable list they pick from when booking). Per-booking snapshot addresses
    # created by the booking flow stay False, so they never clutter the book and a
    # saved address can be deleted without touching booking history.
    is_saved = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-is_default", "-created_at")

    def __str__(self):
        return f"{self.label} - {self.line1}, {self.city}"

    def save(self, *args, **kwargs):
        if self.is_default:
            # Ensure only one default per customer
            (Address.objects
                .filter(customer=self.customer, is_default=True)
                .exclude(pk=self.pk)
                .update(is_default=False))
        super().save(*args, **kwargs)


class LoyaltyTxnType(models.TextChoices):
    EARN = "earn", "Earned"
    REDEEM = "redeem", "Redeemed"
    EXPIRE = "expire", "Expired"
    ADJUST = "adjust", "Adjusted"
    REVERSED = "reversed", "Reversed"
    MERGED = "merged", "Merged"
    BONUS = "bonus", "Bonus"
    CORRECTION = "correction", "Correction"


class LoyaltySource(models.TextChoices):
    SYSTEM = "system", "System"
    ADMIN = "admin", "Admin"
    BOOKING = "booking", "Booking"
    INVOICE = "invoice", "Invoice"
    MERGE = "merge", "Merge"
    SEED = "seed", "Seed"
    WEBSITE = "website", "Website"


class LoyaltyLedger(models.Model):
    """Append-only ledger of every loyalty-point movement (single source of
    truth). `customer.loyalty_points` is the cached running total of these rows."""

    customer = models.ForeignKey(
        Customer,
        on_delete=models.CASCADE,
        related_name="loyalty_entries",
    )
    txn_type = models.CharField(max_length=12, choices=LoyaltyTxnType.choices)
    points = models.IntegerField(
        help_text="Positive for earn/adjust+/bonus, negative for redeem/expire/reverse."
    )
    # Running balance snapshot for an auditable, reconcilable trail.
    balance_before = models.IntegerField(default=0)
    balance_after = models.IntegerField(default=0)
    source = models.CharField(max_length=12, choices=LoyaltySource.choices,
                              default=LoyaltySource.SYSTEM)
    note = models.CharField(max_length=255, blank=True)
    related_booking_id = models.PositiveIntegerField(null=True, blank=True)
    related_invoice_ref = models.CharField(max_length=40, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["customer", "-created_at"])]

    def __str__(self):
        return f"{self.customer.email} {self.txn_type} {self.points}"
