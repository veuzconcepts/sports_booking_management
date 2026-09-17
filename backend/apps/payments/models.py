"""Payments — wallet, payments, refunds, memberships, and VAT invoices.

Money movement is append-only where it matters: the wallet keeps a `WalletTxn`
ledger and its `balance` is the sum of entries; `Payment` and `Refund` are
immutable financial records. Memberships sell a recurring pass; invoices are
VAT-compliant documents rendered to PDF (see `pdf.py`).
"""

import hashlib
import secrets
from decimal import Decimal

from django.conf import settings

# The system default currency is configurable (Settings -> Currency); reading it
# as a callable means a new record follows the CURRENT choice, not the value the
# module happened to be imported with.
from apps.settings_app.currency import get_default_currency
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


# --------------------------------------------------------------------------- #
# Wallet
# --------------------------------------------------------------------------- #
class Wallet(models.Model):
    customer = models.OneToOneField(
        "customers.Customer",
        on_delete=models.CASCADE,
        related_name="wallet",
    )
    currency = models.CharField(max_length=3, default=get_default_currency)
    balance = models.DecimalField(max_digits=13, decimal_places=3, default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Wallet({self.customer.email}) = {self.balance} {self.currency}"


class WalletTxnType(models.TextChoices):
    TOPUP = "topup", _("Top-up")
    CHARGE = "charge", _("Charge")
    REFUND = "refund", _("Refund")
    ADJUST = "adjust", _("Adjustment")


class WalletTxn(models.Model):
    """Append-only ledger of every wallet movement."""

    wallet = models.ForeignKey(
        Wallet,
        on_delete=models.CASCADE,
        related_name="transactions",
    )
    txn_type = models.CharField(max_length=10, choices=WalletTxnType.choices)
    amount = models.DecimalField(
        max_digits=13, decimal_places=3,
        help_text="Positive credits the wallet, negative debits it.",
    )
    balance_after = models.DecimalField(max_digits=13, decimal_places=3)
    note = models.CharField(max_length=255, blank=True)
    related_payment = models.ForeignKey(
        "payments.Payment",
        on_delete=models.SET_NULL,
        related_name="wallet_txns",
        null=True, blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["wallet", "-created_at"])]

    def __str__(self):
        return f"{self.wallet_id} {self.txn_type} {self.amount}"


# --------------------------------------------------------------------------- #
# Memberships
# --------------------------------------------------------------------------- #
class MembershipInterval(models.TextChoices):
    MONTHLY = "monthly", _("Monthly")
    QUARTERLY = "quarterly", _("Quarterly")
    HALF_YEARLY = "half_yearly", _("Half-yearly")
    ANNUAL = "annual", _("Yearly")
    CUSTOM = "custom", _("Custom duration")


class ValidityMode(models.TextChoices):
    ROLLING = "rolling", _("Rolling from purchase date")
    FIXED = "fixed", _("Fixed start & end date")


class MembershipPlan(models.Model):
    name = models.CharField(max_length=120)
    # Human / accounting code (e.g. GOLD-M). Unique; required on create via the
    # serializer. Nullable at the DB so historical rows backfill cleanly.
    code = models.CharField(max_length=40, unique=True, null=True, blank=True)
    description = models.TextField(blank=True)
    interval = models.CharField(
        max_length=12, choices=MembershipInterval.choices,
        default=MembershipInterval.MONTHLY,
    )
    # Validity window. ROLLING = N days/interval from purchase; FIXED = a fixed
    # calendar range. `duration_days` is used when interval == custom.
    validity_mode = models.CharField(
        max_length=8, choices=ValidityMode.choices, default=ValidityMode.ROLLING)
    duration_days = models.PositiveSmallIntegerField(null=True, blank=True)
    fixed_start = models.DateField(null=True, blank=True)
    fixed_end = models.DateField(null=True, blank=True)
    price = models.DecimalField(max_digits=9, decimal_places=3)
    # Club availability (empty = all clubs).
    available_clubs = models.ManyToManyField(
        "clubs.Club", blank=True, related_name="membership_plans")
    # Eligibility: loyalty tiers allowed to buy this plan (empty = everyone).
    eligible_tiers = models.JSONField(default=list, blank=True)
    is_group = models.BooleanField(
        default=False, help_text="Family / group plan shared by several members.",
    )
    is_active = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("price",)

    def __str__(self):
        return f"{self.name} ({self.get_interval_display()})"


class EntitlementTarget(models.TextChoices):
    FACILITY_TYPE = "facility_type", _("Facility type")
    CATEGORY = "category", _("Facility category")
    ADDON = "addon", _("Add-on")


class EntitlementLimit(models.TextChoices):
    UNLIMITED = "unlimited", _("Unlimited")
    LIMITED = "limited", _("Limited")


class EntitlementPeriod(models.TextChoices):
    LIFETIME = "lifetime", _("Per membership (lifetime)")
    MONTHLY = "monthly", _("Per month")
    WEEKLY = "weekly", _("Per week")
    DAILY = "daily", _("Per day")


class PlanEntitlement(models.Model):
    """One usage entitlement on a plan: a specific facility type, a facility
    category (covers any type in it), or an add-on - unlimited or limited to a
    count within a period."""
    plan = models.ForeignKey(
        MembershipPlan, on_delete=models.CASCADE, related_name="entitlements")
    target_type = models.CharField(max_length=16, choices=EntitlementTarget.choices)
    facility_type = models.ForeignKey(
        "facilities.FacilityType", on_delete=models.CASCADE,
        related_name="+", null=True, blank=True)
    facility_category = models.ForeignKey(   # covers every facility type in the category
        "facilities.FacilityCategory", on_delete=models.CASCADE,
        related_name="+", null=True, blank=True)
    addon = models.ForeignKey(
        "facilities.AddOn", on_delete=models.CASCADE,
        related_name="+", null=True, blank=True)
    limit_type = models.CharField(
        max_length=10, choices=EntitlementLimit.choices, default=EntitlementLimit.LIMITED)
    quantity = models.PositiveSmallIntegerField(null=True, blank=True)   # null when unlimited
    period = models.CharField(
        max_length=10, choices=EntitlementPeriod.choices, default=EntitlementPeriod.MONTHLY)

    class Meta:
        ordering = ("id",)

    def clean(self):
        from django.core.exceptions import ValidationError
        targets = {
            EntitlementTarget.FACILITY_TYPE: self.facility_type_id,
            EntitlementTarget.CATEGORY: self.facility_category_id,
            EntitlementTarget.ADDON: self.addon_id,
        }
        if not targets.get(self.target_type):
            raise ValidationError("Select the entitlement's target for its type.")
        if self.limit_type == EntitlementLimit.LIMITED and not self.quantity:
            raise ValidationError("A limited entitlement needs a usage count.")

    def __str__(self):
        return f"{self.plan.name}: {self.target_type} ({self.limit_type})"


class MembershipStatus(models.TextChoices):
    DRAFT = "draft", _("Draft")
    ACTIVE = "active", _("Active")
    SUSPENDED = "suspended", _("Suspended")
    EXPIRED = "expired", _("Expired")
    CANCELLED = "cancelled", _("Cancelled")


class Membership(models.Model):
    # Human-facing membership number (MBR-YYYY-NNNNNN), assigned on save.
    number = models.CharField(max_length=20, unique=True, null=True, blank=True,
                              editable=False, db_index=True)
    customer = models.ForeignKey(
        "customers.Customer",
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    plan = models.ForeignKey(
        MembershipPlan,
        on_delete=models.PROTECT,
        related_name="memberships",
    )
    club = models.ForeignKey(
        "clubs.Club", on_delete=models.SET_NULL,
        related_name="memberships", null=True, blank=True)
    status = models.CharField(
        max_length=10, choices=MembershipStatus.choices,
        default=MembershipStatus.ACTIVE, db_index=True,
    )
    start_date = models.DateField()
    end_date = models.DateField()
    auto_renew = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-start_date",)
        indexes = [
            models.Index(fields=["customer", "status"]),
            models.Index(fields=["status", "end_date"]),
        ]

    def __str__(self):
        return f"{self.number or self.pk} · {self.customer.email} · {self.plan.name}"

    def save(self, *args, **kwargs):
        if not self.number:
            self.number = _next_doc_number(Membership, "MBR")
        super().save(*args, **kwargs)


class MembershipUsageType(models.TextChoices):
    RESERVE = "reserve", _("Reserve")
    RELEASE = "release", _("Release")
    CONSUME = "consume", _("Consume")
    RESTORE = "restore", _("Restore")
    ADJUST = "adjust", _("Adjust")


class MembershipBalance(models.Model):
    """Denormalized counters per (membership, entitlement, period bucket).
    Remaining = entitlement.quantity + granted − consumed − reserved (unlimited ⇒
    always available). `reserved` holds units for not-yet-completed bookings;
    `granted` is bonus units added manually beyond the plan quantity."""
    membership = models.ForeignKey(
        Membership, on_delete=models.CASCADE, related_name="balances")
    entitlement = models.ForeignKey(
        PlanEntitlement, on_delete=models.CASCADE, related_name="+")
    # Period bucket: "" (lifetime), "2026-06" (month), "2026-W25" (week),
    # "2026-06-21" (day). New period ⇒ new row, so limits reset automatically.
    period_key = models.CharField(max_length=12, blank=True)
    consumed = models.PositiveIntegerField(default=0)
    reserved = models.PositiveIntegerField(default=0)
    granted = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["membership", "entitlement", "period_key"],
                name="unique_membership_balance_bucket"),
        ]


class MembershipUsage(models.Model):
    """Append-only usage ledger — the source of truth for consumption + the
    audit history. Consume/restore are tied to a booking for reversibility."""
    membership = models.ForeignKey(
        Membership, on_delete=models.CASCADE, related_name="usage")
    entitlement = models.ForeignKey(
        PlanEntitlement, on_delete=models.SET_NULL, related_name="+", null=True, blank=True)
    txn_type = models.CharField(max_length=10, choices=MembershipUsageType.choices)
    quantity = models.PositiveSmallIntegerField(default=1)
    booking = models.ForeignKey(
        "bookings.Booking", on_delete=models.SET_NULL,
        related_name="membership_usage", null=True, blank=True)
    # Snapshot of what was consumed (survives catalogue changes).
    target_label = models.CharField(max_length=160, blank=True)
    period_key = models.CharField(max_length=12, blank=True)
    note = models.CharField(max_length=255, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="+", null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["membership", "-created_at"]),
                   models.Index(fields=["booking", "txn_type"])]


# --------------------------------------------------------------------------- #
# Payments & refunds
# --------------------------------------------------------------------------- #
class PaymentMethod(models.TextChoices):
    CARD = "card", _("Card")
    CASH = "cash", _("Cash")
    WALLET = "wallet", _("Wallet")
    MEMBERSHIP = "membership", _("Membership")


class PaymentStatus(models.TextChoices):
    PENDING = "pending", _("Pending")
    PAID = "paid", _("Paid")
    FAILED = "failed", _("Failed")
    REFUNDED = "refunded", _("Refunded")
    PARTIALLY_REFUNDED = "partially_refunded", _("Partially refunded")


class Payment(models.Model):
    reference = models.CharField(
        max_length=18, unique=True, editable=False, db_index=True,
    )
    booking = models.ForeignKey(
        "bookings.Booking",
        on_delete=models.PROTECT,
        related_name="payments",
        null=True, blank=True,
    )
    customer = models.ForeignKey(
        "customers.Customer",
        on_delete=models.PROTECT,
        related_name="payments",
    )
    method = models.CharField(max_length=12, choices=PaymentMethod.choices)
    status = models.CharField(
        max_length=20, choices=PaymentStatus.choices,
        default=PaymentStatus.PENDING, db_index=True,
    )
    currency = models.CharField(max_length=3, default=get_default_currency)
    amount = models.DecimalField(max_digits=13, decimal_places=3)
    refunded_amount = models.DecimalField(max_digits=13, decimal_places=3, default=0)

    gateway = models.CharField(max_length=40, default="mock")
    gateway_reference = models.CharField(max_length=120, blank=True)
    failure_reason = models.CharField(max_length=255, blank=True)
    # The ONLY card data this system keeps. Brand and last four digits are what a
    # receipt shows and what a customer recognises on a statement; the PAN and
    # the CVV are never stored, never logged and never leave the gateway module.
    card_brand = models.CharField(max_length=20, blank=True)
    card_last4 = models.CharField(max_length=4, blank=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="created_payments",
        null=True, blank=True,
    )
    paid_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["customer", "-created_at"]),
            models.Index(fields=["status", "-created_at"]),
        ]

    def __str__(self):
        return f"{self.reference} · {self.amount} {self.currency} ({self.status})"

    def save(self, *args, **kwargs):
        if not self.reference:
            for _attempt in range(5):
                candidate = f"PAY-{secrets.token_hex(4).upper()}"
                if not Payment.objects.filter(reference=candidate).exists():
                    self.reference = candidate
                    break
        super().save(*args, **kwargs)

    @property
    def refundable_amount(self) -> Decimal:
        return max(Decimal("0.00"), self.amount - self.refunded_amount)


class RefundStatus(models.TextChoices):
    COMPLETED = "completed", _("Completed")
    PENDING = "pending", _("Pending")
    FAILED = "failed", _("Failed")


class Refund(models.Model):
    """Internal money-movement record for a refund (updates the Payment). The
    customer-facing refund document + number is the linked CreditNote — Refund no
    longer carries its own REF- number."""
    # Deprecated: kept nullable for historical rows; new refunds rely on the
    # CreditNote number as the official reference (no separate REF- numbering).
    reference = models.CharField(
        max_length=18, unique=True, editable=False, db_index=True,
        null=True, blank=True,
    )
    payment = models.ForeignKey(
        Payment,
        on_delete=models.PROTECT,
        related_name="refunds",
    )
    amount = models.DecimalField(max_digits=13, decimal_places=3)
    reason = models.CharField(max_length=255, blank=True)
    method = models.CharField(max_length=15, blank=True)
    status = models.CharField(
        max_length=10, choices=RefundStatus.choices, default=RefundStatus.COMPLETED,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="created_refunds",
        null=True, blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)

    def __str__(self):
        return f"Refund {self.amount} on {self.payment.reference}"


# --------------------------------------------------------------------------- #
# Invoices
# --------------------------------------------------------------------------- #
class InvoiceStatus(models.TextChoices):
    ISSUED = "issued", _("Issued")            # raised, awaiting payment
    PAID = "paid", _("Paid")                  # settled in full
    CANCELLED = "cancelled", _("Cancelled")   # withdrawn before any payment (error)
    # Reversed by credit note(s) — the credit note IS the refund document.
    PARTIALLY_REFUNDED = "partially_refunded", _("Partially refunded")
    REFUNDED = "refunded", _("Refunded")      # fully reversed by credit note(s)


class InvoicePurpose(models.TextChoices):
    """What an invoice was raised for — so a membership purchase and its later
    renewals read distinctly in the customer's financial history (two invoices
    for one membership is a purchase + a renewal, not a duplicate)."""
    SALE = "sale", _("Sale")                                  # booking / general
    MEMBERSHIP_PURCHASE = "membership_purchase", _("Membership purchase")
    MEMBERSHIP_RENEWAL = "membership_renewal", _("Membership renewal")


class Invoice(models.Model):
    number = models.CharField(
        max_length=20, unique=True, editable=False, db_index=True,
    )
    # Optional: walk-in (B2C) invoices may have no customer account. The bill-to
    # name/email below are snapshotted on the document so it stands on its own.
    customer = models.ForeignKey(
        "customers.Customer",
        on_delete=models.PROTECT,
        related_name="invoices",
        null=True, blank=True,
    )
    bill_to_name = models.CharField(max_length=160, blank=True)
    bill_to_email = models.CharField(max_length=254, blank=True)
    bill_to_trn = models.CharField(max_length=30, blank=True)   # recipient TRN snapshot
    payment = models.OneToOneField(
        Payment,
        on_delete=models.SET_NULL,
        related_name="invoice",
        null=True, blank=True,
    )
    booking = models.ForeignKey(
        "bookings.Booking",
        on_delete=models.SET_NULL,
        related_name="invoices",
        null=True, blank=True,
    )
    # A membership sale/renewal invoice (no booking) links here for the customer's
    # financial history.
    membership = models.ForeignKey(
        "payments.Membership",
        on_delete=models.SET_NULL,
        related_name="invoices",
        null=True, blank=True,
    )
    currency = models.CharField(max_length=3, default=get_default_currency)
    subtotal = models.DecimalField(max_digits=13, decimal_places=3)
    tax_amount = models.DecimalField(max_digits=13, decimal_places=3)
    total = models.DecimalField(max_digits=13, decimal_places=3)
    tax_rate = models.DecimalField(max_digits=5, decimal_places=4, default=0)
    # Audit-safe calculation trail (rule 10): the source total before rounding,
    # at extended precision, and the rounding difference applied to `total`.
    total_raw = models.DecimalField(max_digits=16, decimal_places=6, default=0)
    total_extended = models.DecimalField(max_digits=16, decimal_places=6, default=0)
    rounding_difference = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    status = models.CharField(max_length=20, choices=InvoiceStatus.choices,
                              default=InvoiceStatus.ISSUED, db_index=True)
    purpose = models.CharField(max_length=20, choices=InvoicePurpose.choices,
                               default=InvoicePurpose.SALE)
    issued_at = models.DateTimeField(auto_now_add=True)
    # Set when an unpaid invoice is withdrawn in error (paid invoices are reversed
    # with a credit note instead — the document is never deleted).
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancel_reason = models.CharField(max_length=255, blank=True)
    pdf = models.FileField(upload_to="invoices/", null=True, blank=True)

    class Meta:
        ordering = ("-issued_at",)
        indexes = [models.Index(fields=["customer", "-issued_at"])]

    def __str__(self):
        return self.number

    def save(self, *args, **kwargs):
        if not self.number:
            # Sequential, human-friendly invoice number: INV-YYYY-NNNNNN.
            year = timezone.now().year
            last = (
                Invoice.objects
                .filter(number__startswith=f"INV-{year}-")
                .order_by("-number")
                .first()
            )
            seq = (int(last.number.split("-")[-1]) + 1) if last else 1
            self.number = f"INV-{year}-{seq:06d}"
        super().save(*args, **kwargs)

    @property
    def bill_to_display(self) -> str:
        """Name to print on the document: customer, else the snapshot, else walk-in."""
        if self.customer_id:
            return self.customer.full_name
        return self.bill_to_name or "Walk-in customer"

    @property
    def refunded_total(self) -> Decimal:
        """Sum of all ISSUED credit notes against this invoice (pending/rejected
        ones don't count toward the refunded balance)."""
        return sum(
            (cn.total for cn in self.credit_notes.all()
             if cn.status == CreditNoteStatus.ISSUED),
            Decimal("0"),
        )

    @property
    def refundable_amount(self) -> Decimal:
        """How much of this invoice can still be refunded (total − already refunded)."""
        return max(Decimal("0"), Decimal(self.total) - self.refunded_total)


def _next_doc_number(model, prefix: str) -> str:
    """Sequential, human-friendly document number: <PREFIX>-YYYY-NNNNNN.

    Shared by Receipt/CreditNote so finance documents read consistently.
    """
    year = timezone.now().year
    last = (model.objects
            .filter(number__startswith=f"{prefix}-{year}-")
            .order_by("-number")
            .first())
    seq = (int(last.number.split("-")[-1]) + 1) if last else 1
    return f"{prefix}-{year}-{seq:06d}"


class Receipt(models.Model):
    """Proof that an invoice was paid in full. Issued once the invoice settles."""
    number = models.CharField(max_length=20, unique=True, editable=False, db_index=True)
    invoice = models.OneToOneField(
        Invoice, on_delete=models.PROTECT, related_name="receipt",
    )
    customer = models.ForeignKey(
        "customers.Customer", on_delete=models.PROTECT, related_name="receipts",
        null=True, blank=True,
    )
    payment = models.ForeignKey(
        Payment, on_delete=models.SET_NULL, related_name="receipts",
        null=True, blank=True,
    )
    currency = models.CharField(max_length=3, default=get_default_currency)
    amount = models.DecimalField(max_digits=13, decimal_places=3)
    method = models.CharField(max_length=12, blank=True)
    issued_at = models.DateTimeField(auto_now_add=True)
    pdf = models.FileField(upload_to="receipts/", null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="created_receipts", null=True, blank=True,
    )

    class Meta:
        ordering = ("-issued_at",)
        indexes = [models.Index(fields=["customer", "-issued_at"])]

    def __str__(self):
        return self.number

    def save(self, *args, **kwargs):
        if not self.number:
            self.number = _next_doc_number(Receipt, "RCPT")
        super().save(*args, **kwargs)


class CreditNoteStatus(models.TextChoices):
    PENDING_APPROVAL = "pending_approval", _("Pending approval")
    ISSUED = "issued", _("Issued")            # approved (or no approval needed) + refund processed
    REJECTED = "rejected", _("Rejected")


class CreditNote(models.Model):
    """A VAT credit note: the official refund document. Reverses all or part of an
    issued invoice and carries the matching money refund. The original invoice
    stays on the books; this document offsets it. It is also the refund *request*:
    when org approval is required it is created PENDING_APPROVAL and processed on
    approval; otherwise it is created and processed (ISSUED) in one step."""
    number = models.CharField(max_length=20, unique=True, editable=False, db_index=True)
    status = models.CharField(
        max_length=20, choices=CreditNoteStatus.choices,
        default=CreditNoteStatus.ISSUED, db_index=True,
    )
    invoice = models.ForeignKey(
        Invoice, on_delete=models.PROTECT, related_name="credit_notes",
    )
    customer = models.ForeignKey(
        "customers.Customer", on_delete=models.PROTECT, related_name="credit_notes",
        null=True, blank=True,
    )
    refund = models.OneToOneField(
        Refund, on_delete=models.SET_NULL, related_name="credit_note",
        null=True, blank=True,
    )
    currency = models.CharField(max_length=3, default=get_default_currency)
    subtotal = models.DecimalField(max_digits=13, decimal_places=3)
    tax_amount = models.DecimalField(max_digits=13, decimal_places=3)
    total = models.DecimalField(max_digits=13, decimal_places=3)
    tax_rate = models.DecimalField(max_digits=5, decimal_places=4, default=0)
    # Audit-safe calculation trail (mirrors Invoice).
    total_raw = models.DecimalField(max_digits=16, decimal_places=6, default=0)
    total_extended = models.DecimalField(max_digits=16, decimal_places=6, default=0)
    rounding_difference = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    reason = models.CharField(max_length=255, blank=True)
    # How the money was returned (cash / card / wallet / bank transfer).
    method = models.CharField(max_length=15, blank=True)
    # Maker-checker: who requested, who approved / rejected, and when.
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="requested_credit_notes", null=True, blank=True,
    )
    requested_at = models.DateTimeField(default=timezone.now)
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="approved_credit_notes", null=True, blank=True,
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    rejected_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="rejected_credit_notes", null=True, blank=True,
    )
    rejected_at = models.DateTimeField(null=True, blank=True)
    remarks = models.TextField(blank=True, default="")
    # Set when the credit note is issued (refund processed); null while pending.
    issued_at = models.DateTimeField(null=True, blank=True)
    pdf = models.FileField(upload_to="credit-notes/", null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="created_credit_notes", null=True, blank=True,
    )

    class Meta:
        ordering = ("-requested_at",)
        indexes = [models.Index(fields=["customer", "-requested_at"]),
                   models.Index(fields=["invoice", "status"])]

    def __str__(self):
        return self.number

    def save(self, *args, **kwargs):
        if not self.number:
            self.number = _next_doc_number(CreditNote, "CN")
        super().save(*args, **kwargs)


# --------------------------------------------------------------------------- #
# Split payment: one booking, one total, several payers
# --------------------------------------------------------------------------- #
class SplitStatus(models.TextChoices):
    ACTIVE = "active", _("Awaiting payment")
    COMPLETED = "completed", _("Fully paid")
    CANCELLED = "cancelled", _("Cancelled")
    EXPIRED = "expired", _("Expired")


class ShareStatus(models.TextChoices):
    PENDING = "pending", _("Pending")
    PAID = "paid", _("Paid")
    FAILED = "failed", _("Failed")
    EXPIRED = "expired", _("Expired")
    CANCELLED = "cancelled", _("Cancelled")


# Shares that still expect money and therefore still count as allocated.
OPEN_SHARE_STATUSES = (ShareStatus.PENDING, ShareStatus.FAILED)


def hash_split_token(raw: str) -> str:
    """One-way fingerprint of a shareable payment token.

    Payment links are bearer credentials, so the database stores only a digest:
    a leaked backup cannot be replayed as a working link. A plain SHA-256 is the
    right tool here rather than a password hasher, because the token is 256 bits
    of `secrets` randomness (nothing to brute-force) and link resolution has to
    stay a single indexed lookup.
    """
    return hashlib.sha256((raw or "").encode("utf-8")).hexdigest()


class BookingPaymentSplit(models.Model):
    """An arrangement to settle ONE booking with several payments.

    This is deliberately not a second booking total. `Booking.total_amount`
    remains the only authoritative figure; a split merely allocates the amount
    still outstanding on that booking between named participants. Every payment
    it collects is an ordinary `Payment` row against the same booking, so the
    ledger, invoices, reports and the refund path keep working without knowing
    that a split exists.
    """

    booking = models.ForeignKey(
        "bookings.Booking", on_delete=models.CASCADE, related_name="payment_splits",
    )
    # The person who arranged the split: always the booking's own customer, kept
    # as an explicit column so organizer-only actions can be scoped without
    # re-deriving ownership through the booking on every request.
    organizer = models.ForeignKey(
        "customers.Customer", on_delete=models.PROTECT, related_name="payment_splits",
    )
    currency = models.CharField(max_length=3, default=get_default_currency)
    # Snapshot of the booking's outstanding balance when the split was created.
    # AUDIT AND DISPLAY ONLY: every payment revalidates against the booking's
    # live outstanding balance, so this can never authorise an overpayment even
    # if the booking is repriced after the arrangement was made.
    amount_allocated = models.DecimalField(max_digits=13, decimal_places=3, default=0)
    status = models.CharField(
        max_length=12, choices=SplitStatus.choices,
        default=SplitStatus.ACTIVE, db_index=True,
    )
    # Digest of the organizer's management link. Same bearer-token treatment as
    # a share token: the raw value is returned once, at creation, and never again.
    organizer_token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    expires_at = models.DateTimeField(db_index=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ("-created_at",)
        constraints = [
            # A booking collects through at most one live arrangement at a time,
            # so two organizers can never allocate the same outstanding balance.
            models.UniqueConstraint(
                fields=["booking"],
                condition=models.Q(status="active"),
                name="unique_active_split_per_booking",
            ),
        ]
        indexes = [models.Index(fields=["status", "expires_at"])]

    def __str__(self):
        return f"Split on booking {self.booking_id} ({self.status})"

    @property
    def is_expired(self) -> bool:
        return self.status == SplitStatus.ACTIVE and timezone.now() >= self.expires_at

    @property
    def paid_total(self) -> Decimal:
        """Money this arrangement has actually collected."""
        return sum(
            (s.amount for s in self.shares.all() if s.status == ShareStatus.PAID),
            Decimal("0"),
        )

    @property
    def open_total(self) -> Decimal:
        """Still allocated to participants who have not paid."""
        return sum(
            (s.amount for s in self.shares.all() if s.status in OPEN_SHARE_STATUSES),
            Decimal("0"),
        )


class BookingPaymentShare(models.Model):
    """One participant's portion of a split, and the link that pays it.

    A share is what a payment link authorises. It carries its own amount, which
    the backend assigns and the payer can never influence, and it can be settled
    exactly once: the payment path locks the row and re-reads its status inside
    the transaction, so two friends clicking at the same instant cannot both pay
    the same share.
    """

    split = models.ForeignKey(
        BookingPaymentSplit, on_delete=models.CASCADE, related_name="shares",
    )
    # Contact details are optional by design: an organizer may want a bare link
    # to paste into a group chat rather than hand over a friend's phone number.
    participant_name = models.CharField(max_length=120, blank=True)
    participant_email = models.EmailField(blank=True)
    participant_phone = models.CharField(max_length=32, blank=True)
    # The organizer's own portion, so "You" reads distinctly in the progress list
    # and so it is never mistaken for a friend's share when reassigning.
    is_organizer = models.BooleanField(default=False)

    amount = models.DecimalField(max_digits=13, decimal_places=3)
    status = models.CharField(
        max_length=12, choices=ShareStatus.choices,
        default=ShareStatus.PENDING, db_index=True,
    )
    # Digest of the shareable token. Unique so a link resolves in one indexed
    # lookup, and nullable because a cancelled or settled share has its token
    # destroyed rather than merely marked unusable.
    token_hash = models.CharField(
        max_length=64, unique=True, db_index=True, null=True, blank=True,
    )
    payment = models.OneToOneField(
        Payment, on_delete=models.SET_NULL, related_name="split_share",
        null=True, blank=True,
    )
    paid_at = models.DateTimeField(null=True, blank=True)
    # Ordering within the split, so the list reads the way it was entered.
    position = models.PositiveSmallIntegerField(default=0)
    # Last failure shown back to the payer: a machine code, never a card detail.
    last_failure_code = models.CharField(max_length=40, blank=True)
    # Rate limiting for "send reminder", so a customer cannot spam a friend.
    reminder_count = models.PositiveSmallIntegerField(default=0)
    last_reminder_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("position", "id")
        indexes = [models.Index(fields=["split", "status"])]

    def __str__(self):
        return f"Share {self.amount} ({self.status})"

    @property
    def display_name(self) -> str:
        if self.participant_name:
            return self.participant_name
        return "Organizer" if self.is_organizer else "Guest"

    @property
    def is_payable(self) -> bool:
        """Whether this share may still be settled through its link."""
        return (
            self.status in OPEN_SHARE_STATUSES
            and bool(self.token_hash)
            and self.split.status == SplitStatus.ACTIVE
            and not self.split.is_expired
        )
