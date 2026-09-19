"""Bookings — the operational heart of the platform.

A `Booking` ties a customer to a facility type (or facility category) at a club,
for a scheduled slot, plus optional add-ons. Prices are snapshotted at booking
time so later catalogue edits never rewrite history. A `BookingStatusHistory`
row is written on every lifecycle transition.

The slot/availability engine lives in `services.py`: per-slot capacity is the
number of active `Facility` rows (courts, pitches, lanes, halls, rooms) at the
club, and a booking may be pinned to one specific facility.
"""

import secrets
from datetime import timedelta
from decimal import Decimal

from django.conf import settings

# The system default currency is configurable (Settings -> Currency); reading it
# as a callable means a new record follows the CURRENT choice, not the value the
# module happened to be imported with.
from apps.settings_app.currency import get_default_currency
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q
from django.db.models.signals import post_save
from django.dispatch import receiver
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


def generate_reference() -> str:
    """Short, collision-resistant, human-friendly booking code."""
    return f"BK-{secrets.token_hex(3).upper()}"


class BookingType(models.TextChoices):
    WALK_IN = "walk_in", _("Walk-in")
    ADVANCE = "advance", _("Advance")


class BookingSource(models.TextChoices):
    ADMIN = "admin", _("Admin")
    WEBSITE = "website", _("Website")
    PHONE = "phone", _("Phone")
    WALK_IN = "walk_in", _("Walk-in")
    OTHER = "other", _("Other")


class BookingPriority(models.TextChoices):
    NORMAL = "normal", _("Normal")
    URGENT = "urgent", _("Urgent")
    VIP = "vip", _("VIP")


class PaymentStatus(models.TextChoices):
    PENDING = "pending", _("Pending")
    PAID = "paid", _("Paid")
    PARTIALLY_PAID = "partially_paid", _("Partially paid")
    # Nothing is owed: COVERED = a subscription absorbed the whole amount;
    # NO_PAYMENT_REQUIRED = zero payable for another reason (e.g. a 100% promo).
    COVERED = "covered", _("Covered by membership")
    NO_PAYMENT_REQUIRED = "no_payment_required", _("No payment required")


class PaymentMethod(models.TextChoices):
    CASH = "cash", _("Cash")
    CARD = "card", _("Card")
    ONLINE = "online", _("Online")
    BANK_TRANSFER = "bank_transfer", _("Bank transfer")


class BookingStatus(models.TextChoices):
    BOOKED = "booked", _("Pending")
    CONFIRMED = "confirmed", _("Confirmed")
    ASSIGNED = "assigned", _("Assigned")
    ARRIVED = "arrived", _("Checked in")
    IN_PROGRESS = "in_progress", _("In progress")
    COMPLETED = "completed", _("Completed")
    CLOSED = "closed", _("Closed")
    CANCELLED = "cancelled", _("Cancelled")
    NO_SHOW = "no_show", _("No-show")


# Allowed forward transitions. Any status may move to CANCELLED (handled
# separately). Used by the API to reject illegal jumps. A customer can be
# marked NO_SHOW any time before the booking has started.
STATUS_TRANSITIONS = {
    BookingStatus.BOOKED: {BookingStatus.CONFIRMED, BookingStatus.CANCELLED, BookingStatus.NO_SHOW},
    BookingStatus.CONFIRMED: {BookingStatus.ASSIGNED, BookingStatus.CANCELLED, BookingStatus.NO_SHOW},
    BookingStatus.ASSIGNED: {BookingStatus.ARRIVED, BookingStatus.IN_PROGRESS,
                             BookingStatus.CANCELLED, BookingStatus.NO_SHOW},
    BookingStatus.ARRIVED: {BookingStatus.IN_PROGRESS, BookingStatus.CANCELLED, BookingStatus.NO_SHOW},
    BookingStatus.IN_PROGRESS: {BookingStatus.COMPLETED, BookingStatus.CANCELLED},
    BookingStatus.COMPLETED: {BookingStatus.CLOSED},
    BookingStatus.CLOSED: set(),
    BookingStatus.CANCELLED: set(),
    BookingStatus.NO_SHOW: set(),
}

# Statuses that count against slot capacity (i.e. still occupy a facility).
ACTIVE_STATUSES = {
    BookingStatus.BOOKED,
    BookingStatus.CONFIRMED,
    BookingStatus.ASSIGNED,
    BookingStatus.ARRIVED,
    BookingStatus.IN_PROGRESS,
}

# A booking that has finished service (completed, and then optionally closed).
COMPLETED_STATUSES = {BookingStatus.COMPLETED, BookingStatus.CLOSED}

# THE definition of "this facility is spoken for at this time".
#
# Wider than ACTIVE_STATUSES on purpose. A completed booking used the court for
# its period; releasing the slot the moment it is marked complete meant staff
# closing a booking a few minutes early handed the court to somebody else while
# it was still in use. Cancelled and no-show are excluded: nobody is there, and
# the club should be able to resell the time.
#
# Availability, allocation and the database constraint all read this one set.
# Keep `ACTIVE_STATUSES` for "a live booking the customer still holds", which
# is a different question and drives per-customer caps and upcoming lists.
SLOT_BLOCKING_STATUSES = ACTIVE_STATUSES | COMPLETED_STATUSES

# Statuses that mean the booking was confirmed (or has progressed past it). A
# customer with any booking in one of these is treated as a real, verified
# customer. Pending (booked), cancelled and no-show are excluded.
VERIFIED_BOOKING_STATUSES = {
    BookingStatus.CONFIRMED,
    BookingStatus.ASSIGNED,
    BookingStatus.ARRIVED,
    BookingStatus.IN_PROGRESS,
    BookingStatus.COMPLETED,
    BookingStatus.CLOSED,
}

# Payment states that mean money has been taken — such a booking can NEVER be
# deleted (reverse with a credit note / refund and cancel instead).
PAID_PAYMENT_STATUSES = {PaymentStatus.PAID, PaymentStatus.PARTIALLY_PAID}

# Standard reasons offered when deleting a (still-deletable) booking. The picker
# requires one of these or a free-text reason; "Other" must include a note.
BOOKING_DELETION_REASONS = [
    "Junk customer",
    "Fake / spam booking",
    "Duplicate booking",
    "Test booking",
    "Customer cancelled / no longer needed",
    "Created in error",
    "Other",
]


class RecurrenceRule(models.TextChoices):
    NONE = "none", _("One-off")
    WEEKLY = "weekly", _("Weekly")
    FORTNIGHTLY = "fortnightly", _("Fortnightly")


class BookingOrder(models.Model):
    """One customer checkout that produced several bookings.

    A multi-slot selection stays N ordinary `Booking` rows, one per slot. That
    is deliberate: availability, the calendar, staff assignment, reports,
    notifications and the `(facility, date, time)` unique index that prevents
    double-booking all work per booking, and every one of them keeps working
    untouched. The order is only the thread that ties them to a single
    checkout.

    It holds NO money. Each booking keeps its own authoritative price snapshot,
    because slots can be priced differently (a peak evening costs more than an
    afternoon) and a later refund of one slot has to return what that slot
    actually cost. Totals here are summed from the bookings, so there is never
    a second figure that can drift from them.
    """

    reference = models.CharField(
        max_length=14, unique=True, editable=False, db_index=True,
    )
    customer = models.ForeignKey(
        "customers.Customer", on_delete=models.PROTECT, related_name="booking_orders",
    )
    # Every slot in one order shares a club and an activity. Mixing facilities
    # in one checkout is a shopping cart, which is deliberately out of scope.
    club = models.ForeignKey(
        "clubs.Club", on_delete=models.PROTECT, related_name="booking_orders",
    )
    facility_type = models.ForeignKey(
        "facilities.FacilityType", on_delete=models.PROTECT,
        related_name="booking_orders", null=True, blank=True,
    )
    currency = models.CharField(max_length=3, default=get_default_currency)
    source = models.CharField(
        max_length=20, choices=BookingSource.choices, default=BookingSource.WEBSITE,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="created_booking_orders", null=True, blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["customer", "-created_at"])]

    def __str__(self):
        return f"{self.reference} ({self.slot_count} slots)"

    def save(self, *args, **kwargs):
        if not self.reference:
            for _attempt in range(5):
                candidate = f"ORD-{secrets.token_hex(4).upper()}"
                if not BookingOrder.objects.filter(reference=candidate).exists():
                    self.reference = candidate
                    break
        super().save(*args, **kwargs)

    @property
    def live_bookings(self):
        """Slots that still count: a cancelled one is history, not part of the order."""
        return [b for b in self.bookings.all()
                if b.status not in (BookingStatus.CANCELLED, BookingStatus.NO_SHOW)]

    @property
    def slot_count(self) -> int:
        return len(self.live_bookings)

    @property
    def total_amount(self):
        """Summed from the bookings, never stored. One source of truth per slot."""
        return sum((Decimal(str(b.total_amount or 0)) for b in self.live_bookings),
                   Decimal("0"))

    @property
    def total_duration_minutes(self) -> int:
        return sum(b.duration_minutes or 0 for b in self.live_bookings)


class Booking(models.Model):
    reference = models.CharField(
        max_length=14, unique=True, editable=False, db_index=True,
        help_text="Human-friendly booking code, e.g. BK-2A4F9C.",
    )
    # Optional for walk-in bookings, which carry a guest-name snapshot instead.
    customer = models.ForeignKey(
        "customers.Customer",
        on_delete=models.PROTECT,
        related_name="bookings",
        null=True, blank=True,
    )
    # Walk-in guest snapshot (used when no Customer record is selected).
    walk_in_name = models.CharField(max_length=120, blank=True)
    walk_in_phone = models.CharField(max_length=40, blank=True)
    walk_in_email = models.EmailField(blank=True)
    facility_category = models.ForeignKey(
        "facilities.FacilityCategory",
        on_delete=models.PROTECT,
        related_name="bookings",
        null=True, blank=True,
    )
    # The bookable, priced offering — the primary booking target.
    facility_type = models.ForeignKey(
        "facilities.FacilityType",
        on_delete=models.PROTECT,
        related_name="bookings",
        null=True, blank=True,
    )
    add_ons = models.ManyToManyField(
        "facilities.AddOn",
        related_name="bookings",
        blank=True,
    )

    booking_type = models.CharField(max_length=10, choices=BookingType.choices, blank=True)
    # Where the booking originated (admin panel, public website, app, …).
    source = models.CharField(
        max_length=12, choices=BookingSource.choices, default=BookingSource.ADMIN, blank=True,
    )
    # Origin context surfaced on the booking detail page:
    #  - customer_was_new: this booking created a brand-new customer record.
    #  - customer_info_updated: a returning customer changed their saved details
    #    while placing this booking (e.g. on the website) — flagged for attention.
    customer_was_new = models.BooleanField(default=False)
    customer_info_updated = models.BooleanField(default=False)
    priority = models.CharField(
        max_length=10, choices=BookingPriority.choices, default=BookingPriority.NORMAL,
    )
    status = models.CharField(
        max_length=12,
        choices=BookingStatus.choices,
        default=BookingStatus.BOOKED,
        db_index=True,
    )

    scheduled_date = models.DateField()
    scheduled_time = models.TimeField()
    duration_minutes = models.PositiveSmallIntegerField(default=60)
    # Derived from scheduled_time + duration_minutes and kept in sync on save.
    # Stored (not computed per query) so the slot engine can test interval
    # overlap in SQL, which is what makes a multi-slot booking block the slots
    # it actually spans. Clamped to 23:59 on a booking that would run past
    # midnight - the engine never offers such a slot.
    end_time = models.TimeField(null=True, blank=True, editable=False)

    # The club this booking is at (drives per-user club scoping) and, optionally,
    # the specific facility (court / lane / hall / room) it occupies.
    club = models.ForeignKey(
        "clubs.Club",
        on_delete=models.SET_NULL,
        related_name="bookings",
        null=True, blank=True,
    )
    facility = models.ForeignKey(
        "facilities.Facility",
        on_delete=models.SET_NULL,
        related_name="bookings",
        null=True, blank=True,
    )

    # Staff member looking after this booking, when the facility type needs one.
    assigned_to = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="assigned_bookings",
        null=True, blank=True,
    )

    # --- Price snapshot (frozen at creation) ---
    currency = models.CharField(max_length=3, default=get_default_currency)
    base_amount = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    addons_amount = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    discount_amount = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    surcharge_amount = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    tax_amount = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    total_amount = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    # --- Audit-safe calculation trail (rule 10) ---
    # raw = exact computed total before currency rounding; extended = at the
    # currency's extended precision; total_amount = final (currency precision);
    # rounding_difference = total_amount - total_raw (the cent the rounding moved).
    total_raw = models.DecimalField(max_digits=16, decimal_places=6, default=0)
    total_extended = models.DecimalField(max_digits=16, decimal_places=6, default=0)
    rounding_difference = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    # When this price snapshot was last computed (audit; historical bookings
    # are never recalculated when rules change later).
    calculated_at = models.DateTimeField(null=True, blank=True)
    # Snapshot of pricing rules applied at computation time (for traceability).
    applied_rules = models.JSONField(default=list, blank=True)
    # Peak / off-peak as classified on the business hours WHEN THIS WAS PRICED.
    # A snapshot, like `applied_rules` beside it: schedules get re-classified,
    # and a report about last quarter must describe the hours as they were.
    period_type = models.CharField(max_length=10, blank=True, db_index=True)
    # Redeemed promo code (optional) + the discount it produced.
    promo_code = models.ForeignKey(
        "promotions.PromoCode", on_delete=models.SET_NULL,
        related_name="+", null=True, blank=True,
    )
    promo_discount = models.DecimalField(max_digits=11, decimal_places=3, default=0)

    # Loyalty points redeemed against THIS booking (set by the loyalty redeem
    # action before payment). `loyalty_discount` is folded into the total exactly
    # like `promo_discount`; `loyalty_points_redeemed` records the points spent.
    # `loyalty_points_earned` records points awarded on completion (idempotency).
    loyalty_discount = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    loyalty_points_redeemed = models.PositiveIntegerField(default=0)
    loyalty_points_earned = models.PositiveIntegerField(default=0)

    # --- Payment ---
    payment_status = models.CharField(
        max_length=20, choices=PaymentStatus.choices, default=PaymentStatus.PENDING,
    )
    payment_method = models.CharField(max_length=15, choices=PaymentMethod.choices, blank=True)
    # Immutable booking-time record of what a subscription covered + the resulting
    # money breakdown (actual prices, covered amount, payable, status reason), so a
    # completed booking shows what happened then — not today's dynamic coverage.
    coverage_snapshot = models.JSONField(default=None, null=True, blank=True)
    # When True, this booking deliberately does NOT use subscription coverage even
    # if the customer has an eligible membership (staff "Unapply Subscription").
    subscription_opt_out = models.BooleanField(default=False)

    # --- Recurrence ---
    recurrence = models.CharField(
        max_length=12, choices=RecurrenceRule.choices, default=RecurrenceRule.NONE,
    )
    parent_booking = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        related_name="recurrences",
        null=True, blank=True,
    )

    # --- Multi-slot checkout -------------------------------------------------
    # The order this slot was bought in, when the customer picked several at
    # once. Null for an ordinary single-slot booking, which is most of them.
    # Distinct from `parent_booking`, which means "a repeat of": a weekly
    # series and a three-slot checkout are different things and must stay
    # tellable apart in reports and cancellation.
    order = models.ForeignKey(
        "BookingOrder",
        on_delete=models.SET_NULL,
        related_name="bookings",
        null=True, blank=True,
    )

    customer_notes = models.TextField(blank=True)
    internal_notes = models.TextField(blank=True)
    special_instructions = models.TextField(blank=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="created_bookings",
        null=True, blank=True,
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="updated_bookings",
        null=True, blank=True,
    )
    completed_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancellation_reason = models.CharField(max_length=255, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-scheduled_date", "-scheduled_time")
        indexes = [
            models.Index(fields=["scheduled_date", "club"]),
            models.Index(fields=["status", "scheduled_date"]),
            models.Index(fields=["customer", "-created_at"]),
            models.Index(fields=["assigned_to", "scheduled_date"]),
            models.Index(fields=["club", "scheduled_date"]),
            # Drives the overlap lookup in the slot engine.
            models.Index(fields=["facility", "scheduled_date", "scheduled_time"]),
        ]
        constraints = [
            # Backstop against a double-allocation race: two LIVE bookings can
            # never hold the same facility at the same start time. Overlapping
            # (not identical) starts are prevented in `services.allocate_facility`,
            # which locks the club's day before choosing. NULL facility rows are
            # exempt (SQL treats NULLs as distinct), so unallocated bookings and
            # facility-less types are unaffected.
            models.UniqueConstraint(
                fields=["facility", "scheduled_date", "scheduled_time"],
                # Spelled out because an index cannot import a Python set.
                # `test_workflow_integrity` asserts this list and
                # SLOT_BLOCKING_STATUSES stay identical, so the two cannot
                # drift apart unnoticed.
                condition=Q(status__in=[
                    "booked", "confirmed", "assigned", "arrived", "in_progress",
                    "completed", "closed",
                ]),
                name="unique_live_booking_per_facility_slot",
            ),
        ]

    def __str__(self):
        return f"{self.reference} - {self.scheduled_date}"

    def save(self, *args, **kwargs):
        self.sync_end_time()
        if not self.reference:
            # Retry on the (vanishingly rare) collision.
            for _attempt in range(5):
                candidate = generate_reference()
                if not Booking.objects.filter(reference=candidate).exists():
                    self.reference = candidate
                    break
        super().save(*args, **kwargs)

    # ------------------------------------------------------------------ #
    # Validation
    # ------------------------------------------------------------------ #
    def clean(self):
        # Exactly one bookable target: a facility type or a facility category.
        targets = (bool(self.facility_type_id), bool(self.facility_category_id))
        if sum(targets) != 1:
            raise ValidationError(
                "A booking must reference exactly one of facility type or facility category."
            )
        is_walk_in = self.booking_type == BookingType.WALK_IN
        # Customer required unless this is a walk-in (which snapshots the name).
        if not is_walk_in and not self.customer_id:
            raise ValidationError("Select a customer, or mark the booking as walk-in.")
        # A pinned facility must belong to the booking's club.
        if self.facility_id and self.club_id and self.facility.club_id != self.club_id:
            raise ValidationError("The selected facility does not belong to this club.")

    # ------------------------------------------------------------------ #
    # Pricing
    # ------------------------------------------------------------------ #
    def _slot_period(self):
        """How this booking's time is classified on the business hours.

        Resolved through the one schedule engine, so a facility that
        overrides its club's hours also overrides their classification.
        Returns None when there is no schedule to read, which leaves every
        pricing rule applying exactly as it did before.
        """
        if not (self.scheduled_date and self.scheduled_time):
            return None
        from apps.bookings.services import _resolve_schedule, slot_period

        day = _resolve_schedule(self.scheduled_date, club=self.club,
                                facility=self.facility)
        start = self.scheduled_time.hour * 60 + self.scheduled_time.minute
        return slot_period(day, start, start + (self.duration_minutes or 0))

    def compute_pricing(self, addons=None, covered_override=None,
                        promo_discount_override=None):
        """Recompute the price snapshot from the current catalogue selection.

        `covered_override` (a cov-shaped dict, or {} for "nothing covered") forces
        the coverage used for pricing instead of computing it live — set at
        completion from what was actually CONSUMED, so the final price reflects
        reality (reallocation / revalidation) rather than the soft hold.

        Applies any matching active PricingRules (club/membership/weekend/promo/
        etc.) on top of the catalogue subtotal via the shared pricing engine,
        then tax. Returns the total without saving so callers can persist in a
        single write.

        `addons` may be passed explicitly (a list of AddOn objects) so an
        unsaved/transient booking can be priced for a live preview; when None
        the already-set M2M (`self.add_ons`) is used.
        """
        from apps.facilities.pricing import calculate_price
        from apps.settings_app.currency import round_extended, round_money

        # Final amounts round to this booking's currency (precision + MAU + method);
        # `qx` keeps a multi-step intermediate at extended precision.
        def q(v):
            return round_money(v, self.currency)

        def qx(v):
            return round_extended(v, self.currency)

        tax_rate = self._resolve_tax_rate()

        base = Decimal("0.00")
        discount = Decimal("0.00")

        if self.facility_type_id:
            base = Decimal(self.facility_type.price)
            discount = q(base * Decimal(self.facility_type.discount_percent) / Decimal("100"))
        elif self.facility_category_id:
            base = Decimal(self.facility_category.base_price)

        addon_objs = list(addons) if addons is not None else list(self.add_ons.all())
        addon_ids = [a.id for a in addon_objs]

        # Membership coverage: a covered facility type / add-on is zero-priced here
        # ("Covered by Membership"); usage is deducted only on completion
        # (consume_for_booking). Uncovered items + extras are charged normally.
        covered_addon_ids = set()
        cov = None
        pre_coverage_base = base                 # the price before coverage zeroes it
        if covered_override is not None:
            cov = covered_override or None       # {} → no coverage (revalidated away)
        elif self.customer_id:
            from apps.payments.services import coverage_for_booking
            cov = coverage_for_booking(self, addon_objs=addon_objs)
        if cov:
            if cov.get("covered_facility_type"):
                base = Decimal("0.00")
                discount = Decimal("0.00")
            covered_addon_ids = set(cov.get("covered_addon_ids") or set())
        addons_total = sum((Decimal(a.price) for a in addon_objs
                            if a.id not in covered_addon_ids), Decimal("0.00"))

        catalogue_subtotal = (base + addons_total - discount)
        if catalogue_subtotal < 0:
            catalogue_subtotal = Decimal("0.00")

        # Categories this booking belongs to — the high-level `facility_category`
        # link, or the chosen facility type's own categories (type-based bookings:
        # admin catalogue + all website bookings) — so category-scoped rules match.
        if self.facility_category_id:
            rule_category_ids = [self.facility_category_id]
        elif self.facility_type_id:
            rule_category_ids = list(self.facility_type.categories.values_list("id", flat=True))
        else:
            rule_category_ids = []

        # Peak/off-peak, resolved once from the business hours this slot falls
        # in, then both priced against and snapshotted for reporting.
        period = self._slot_period()
        self.period_type = period or ""

        # Apply dynamic pricing rules on top of the catalogue subtotal.
        result = calculate_price(
            catalogue_subtotal,
            category_ids=rule_category_ids,
            addon_ids=addon_ids,
            facility_type=self.facility_type if self.facility_type_id else None,
            club_id=self.club_id,
            customer_type=self._customer_loyalty_tier(),
            membership_plan_id=self._active_membership_plan_id(),
            booking_date=self.scheduled_date,
            booking_time=self.scheduled_time,
            quantity=1,
            # Only rules that name a period ever see it, so classifying a
            # shift changes nothing until somebody prices it.
            period=period,
        )
        rule_discount = Decimal(str(result["total_discount"]))
        rule_surcharge = Decimal(str(result["total_surcharge"]))
        adjusted_subtotal = Decimal(str(result["final_price"]))
        applied = result.get("applied_rules", [])

        # The SERVICE's tax mode, kept only to express "already paid" in subtotal
        # terms for the partial-payment promo guard below. VAT itself is computed
        # PER LINE further down — each line taxed by its own inclusive/exclusive
        # flag, never one blanket mode for the whole document.
        tax_inclusive = bool(getattr(self.facility_type, "tax_inclusive", False)) if self.facility_type_id else False

        # Promo code discount, applied on top of the adjusted subtotal — but ONLY
        # against the UNPAID portion. A promo added against a later add-on balance
        # must never re-discount services that were already invoiced and paid.
        promo_discount = Decimal("0.00")
        if promo_discount_override is not None:
            # A multi-slot order redeems one promo ONCE and hands each slot its
            # allocated share. Recomputing per slot here would consume a
            # redemption per slot, apply `max_discount_amount` per slot, and
            # test `min_order_amount` against one slot instead of the order.
            promo_discount = min(Decimal(str(promo_discount_override)),
                                 adjusted_subtotal)
        elif self.promo_code_id:
            from apps.promotions.services import compute_discount
            promo_base = adjusted_subtotal
            if self.pk:
                from apps.bookings.services import booking_amount_paid
                paid = Decimal(booking_amount_paid(self))
                paid_in_subtotal_terms = (paid if tax_inclusive
                                          else (paid / (Decimal("1") + tax_rate) if tax_rate else paid))
                promo_base = max(Decimal("0.00"), adjusted_subtotal - paid_in_subtotal_terms)
            promo_discount = compute_discount(self.promo_code, promo_base)
        after_promo = adjusted_subtotal - promo_discount
        if after_promo < 0:
            after_promo = Decimal("0.00")

        # Loyalty redemption — a flat discount funded by points, applied on top of
        # the promo (pre-VAT, exactly like promo) so VAT is computed on the reduced
        # base. Clamped so it never drives the taxable base negative; the redeem
        # action validates the amount/caps before storing it.
        loyalty_discount = Decimal(str(self.loyalty_discount or 0))
        if loyalty_discount > after_promo:
            loyalty_discount = after_promo
        after_promo = after_promo - loyalty_discount
        if after_promo < 0:
            after_promo = Decimal("0.00")

        # ---- VAT, computed PER LINE by each line's own tax treatment ----------
        # A government VAT invoice taxes every line on its OWN inclusive/exclusive
        # setting (a mixed invoice — e.g. a tax-inclusive service plus a tax-
        # exclusive add-on — taxes each correctly). So rebuild the priced lines
        # (service + each uncovered add-on), allocate the document-level rule/promo
        # adjustments across them in proportion to their catalogue value, then tax
        # each line by its own `tax_inclusive` flag:
        #   • inclusive line -> VAT embedded:   net = gross / (1 + rate)
        #   • exclusive line -> VAT on top:     tax = net * rate
        # `catalogue_subtotal` is the sum of these line amounts (post item-discount,
        # post-coverage). Non-taxable surcharges are added to the total untaxed.
        tax_lines = []
        service_line_amount = base - discount        # post item-discount; 0 if covered
        if (self.facility_type_id or self.facility_category_id) and service_line_amount > 0:
            tax_lines.append((service_line_amount, tax_inclusive))
        for a in addon_objs:
            if a.id in covered_addon_ids:
                continue
            tax_lines.append((Decimal(a.price), bool(getattr(a, "tax_inclusive", False))))

        gross_base = sum((amt for amt, _ in tax_lines), Decimal("0.00"))

        # Non-taxable surcharges (rules with tax_applicable=False) ride on top of
        # the total but are never taxed; discounts, promo and taxable surcharges are
        # folded into the per-line taxable spend (`net_target`).
        nontaxable_surcharge = Decimal("0.00")
        for r in applied:
            if not r.get("tax_applicable", False):
                amt = Decimal(str(r.get("amount", 0)))
                if amt > 0:
                    nontaxable_surcharge += amt

        net_target = after_promo - nontaxable_surcharge      # taxable spend across all lines
        if net_target < 0:
            net_target = Decimal("0.00")

        # Tax at EXTENDED precision; the final total is rounded to the currency once
        # at the end (round once, not per-step).
        tax_ext = Decimal("0.00")
        lines_total = Decimal("0.00")
        if gross_base > 0:
            factor = net_target / gross_base                 # spread adjustments by line value
            for amt, incl in tax_lines:
                line_net = amt * factor                      # this line's share of the taxable spend
                if incl:
                    net = line_net / (Decimal("1") + tax_rate) if tax_rate else line_net
                    tax_ext += line_net - net
                    lines_total += line_net
                else:
                    line_tax = line_net * tax_rate
                    tax_ext += line_tax
                    lines_total += line_net + line_tax
        elif net_target > 0:
            # No catalogue lines to spread onto (e.g. a surcharge-only charge):
            # treat as exclusive — VAT added on top.
            tax_ext = net_target * tax_rate
            lines_total = net_target + tax_ext

        tax_ext = qx(tax_ext)
        final_total = lines_total + nontaxable_surcharge

        # Audit-safe calculation trail (rule 10): raw -> extended -> final -> diff.
        self.total_raw = qx(final_total)
        self.total_extended = round_extended(final_total, self.currency)
        self.total_amount = q(final_total)                       # final, rounded once
        self.rounding_difference = self.total_amount - self.total_raw

        # Display components follow the currency's precision (rule 3).
        self.base_amount = q(base)
        self.addons_amount = q(addons_total)
        self.promo_discount = q(promo_discount)
        self.discount_amount = q(discount + rule_discount + promo_discount + loyalty_discount)
        self.surcharge_amount = q(rule_surcharge)
        self.tax_amount = q(tax_ext)
        self.applied_rules = applied
        self.calculated_at = timezone.now()
        self.coverage_snapshot = self._build_coverage_snapshot(
            cov, pre_coverage_base, addon_objs, covered_addon_ids, q)
        return self.total_amount

    def _build_coverage_snapshot(self, cov, pre_coverage_base, addon_objs,
                                 covered_addon_ids, q):
        """Immutable record of what a subscription covered on this booking, with the
        catalogue prices captured BEFORE coverage zeroed them. None when no coverage
        applied. Read-only data — it drives the payment-status reason + booking-time
        display, and never feeds back into pricing."""
        if not cov or not (cov.get("covered_facility_type") or cov.get("covered_addon_ids")):
            return None
        membership = cov["membership"]
        lines, covered_amount = [], Decimal("0.00")
        if cov["covered_facility_type"] and self.facility_type_id:
            price = q(pre_coverage_base)
            lines.append({"kind": "facility_type", "label": self.facility_type.name,
                          "actual_price": str(price)})
            covered_amount += price
        for a in addon_objs:
            if a.id in covered_addon_ids:
                price = q(Decimal(a.price))
                lines.append({"kind": "addon", "label": a.name, "actual_price": str(price)})
                covered_amount += price
        covered_amount = q(covered_amount)
        payable = self.total_amount
        return {
            "membership_id": membership.id,
            "membership_number": membership.number,
            "plan_name": membership.plan.name,
            "covered_lines": lines,
            "covered_amount": str(covered_amount),
            "payable_amount": str(payable),
            "price_before_coverage": str(q(covered_amount + payable)),
            "deduction": "on_completion",
            "status_reason": ("Fully covered by membership" if payable == 0
                              else "Partially covered by membership; balance payable"),
            "currency": self.currency,
            "captured_at": timezone.now().isoformat(),
        }

    def sync_payment_status(self):
        """Reconcile payment_status with the current payable amount (call from the
        save path, never from a preview). Never overrides a real payment."""
        if self.payment_status in (PaymentStatus.PAID, PaymentStatus.PARTIALLY_PAID):
            return
        if self.total_amount == 0:
            self.payment_status = (PaymentStatus.COVERED if self.coverage_snapshot
                                   else PaymentStatus.NO_PAYMENT_REQUIRED)
        else:
            self.payment_status = PaymentStatus.PENDING

    @staticmethod
    def _resolve_tax_rate():
        """Active VAT rate from the configured default TaxRate, else the env default."""
        from apps.settings_app.models import TaxRate
        rate = (
            TaxRate.objects.filter(is_default=True)
            .values_list("rate", flat=True)
            .first()
        )
        if rate is None:
            rate = TaxRate.objects.values_list("rate", flat=True).first()
        return Decimal(str(rate if rate is not None else settings.DEFAULT_TAX_RATE))

    def _customer_loyalty_tier(self):
        return getattr(self.customer, "loyalty_tier", None) if self.customer_id else None

    def _active_membership_plan_id(self):
        if not self.customer_id:
            return None
        from apps.payments.models import Membership, MembershipStatus
        m = (
            Membership.objects
            .filter(customer_id=self.customer_id, status=MembershipStatus.ACTIVE)
            .values_list("plan_id", flat=True)
            .first()
        )
        return m

    def compute_duration(self):
        """Sum the facility type + add-on durations into `duration_minutes`."""
        minutes = 0
        if self.facility_type_id:
            minutes = self.facility_type.duration_minutes
        elif self.facility_category_id:
            minutes = self.facility_category.base_duration_minutes
        minutes += sum(a.duration_minutes for a in self.add_ons.all())
        self.duration_minutes = minutes or 30
        self.sync_end_time()
        return self.duration_minutes

    def sync_end_time(self):
        """Recompute the stored `end_time` from start + duration."""
        if not self.scheduled_time:
            self.end_time = None
            return None
        from datetime import date as _date, datetime as _dt, time as _time, timedelta
        end = (_dt.combine(_date(2000, 1, 1), self.scheduled_time)
               + timedelta(minutes=self.duration_minutes or 0))
        # A booking must not wrap past midnight; clamp so the interval stays sane.
        self.end_time = _time(23, 59) if end.day != 1 else end.time()
        return self.end_time

    @property
    def occupies(self):
        """The (start, end) time interval this booking holds its facility for."""
        return self.scheduled_time, (self.end_time or self.scheduled_time)


class BookingPolicy(models.Model):
    """When a booking may be made, and when it may still be cancelled.

    One row is the ORGANIZATION default (`is_default=True`, `club` empty); any
    club may have its own row that replaces it wholesale. Resolve with
    `services.resolve_policy(club)` rather than querying directly.

    The rules exist to protect the operator from bookings they cannot staff and
    from no-shows they cannot resell, so by default they bind SELF-SERVICE
    bookings (website / customer) only: reception must still be able to take a
    walk-in for the next ten minutes. Turn on `enforce_for_staff` to apply them
    to admin-created bookings too.

    Every limit uses 0 to mean "no limit", so a fresh install is unrestricted
    apart from the shipped defaults below.
    """

    club = models.OneToOneField(
        "clubs.Club", on_delete=models.CASCADE, null=True, blank=True,
        related_name="booking_policy",
        help_text="Leave empty for the organization-wide default.",
    )
    facility = models.OneToOneField(
        "facilities.Facility", on_delete=models.CASCADE, null=True, blank=True,
        related_name="booking_policy",
        help_text="A policy for one physical unit. Leave empty for a club or "
                  "organization policy.",
    )
    is_default = models.BooleanField(
        default=False,
        help_text="The organization-wide policy. Exactly one row may set this.",
    )

    # --- Multiple slots in one booking --------------------------------------
    # These four are NULLABLE, and null means "inherit from the level above".
    #
    # That differs from the older fields on this model, which replace their
    # parent wholesale, and the difference is deliberate: a court that wants to
    # cap itself at two slots should not have to restate the club's lead time,
    # advance window and cancellation cutoff just to say so. The older fields
    # keep their existing behaviour untouched; only these new ones merge.
    allow_multiple_slots = models.BooleanField(
        null=True, blank=True,
        help_text="Let a customer put several time slots in one booking. "
                  "Empty inherits.",
    )
    allow_multiple_dates = models.BooleanField(
        null=True, blank=True,
        help_text="Let those slots fall on different dates. Empty inherits.",
    )
    require_consecutive_slots = models.BooleanField(
        null=True, blank=True,
        help_text="Selected slots must run back to back. Empty inherits.",
    )
    min_slots_per_booking = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Fewest slots a multi-slot booking may contain. Empty inherits.",
    )
    max_slots_per_booking = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Most slots one booking may contain. Empty inherits.",
    )

    # --- When a booking may be made -----------------------------------------
    min_lead_minutes = models.PositiveIntegerField(
        default=0,
        help_text="Minimum notice before the slot starts. 0 = up to the moment it begins.",
    )
    max_advance_days = models.PositiveSmallIntegerField(
        default=90,
        help_text="How far ahead a slot may be booked. 0 = no limit.",
    )

    # --- How much a customer may hold ---------------------------------------
    max_active_bookings_per_customer = models.PositiveSmallIntegerField(
        default=0,
        help_text="Upcoming bookings one customer may hold at once. 0 = no limit.",
    )
    max_bookings_per_customer_per_day = models.PositiveSmallIntegerField(
        default=0,
        help_text="Bookings one customer may hold on a single day. 0 = no limit.",
    )

    # --- Cancellation --------------------------------------------------------
    cancellation_cutoff_hours = models.PositiveSmallIntegerField(
        default=24,
        help_text="A customer may cancel until this many hours before the slot. "
                  "0 = right up to the start. Staff are never blocked.",
    )

    enforce_for_staff = models.BooleanField(
        default=False,
        help_text="Apply the booking limits to admin-created bookings too.",
    )

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = "booking policies"
        ordering = ("-is_default", "club")
        constraints = [
            # Exactly one organization-wide row (same partial-unique trick the
            # single super-admin invariant uses).
            models.UniqueConstraint(
                fields=["is_default"],
                condition=Q(is_default=True),
                name="unique_default_booking_policy",
            ),
        ]

    def __str__(self):
        return f"Booking policy - {self.scope_label}"

    @property
    def scope_label(self) -> str:
        if self.facility_id:
            return self.facility.name
        if self.club_id:
            return self.club.name
        return "Organization default"

    def clean(self):
        super().clean()
        # A row names exactly one scope. Two would make "which policy applies"
        # ambiguous, and none would make the row unreachable.
        scopes = [bool(self.is_default), bool(self.club_id), bool(self.facility_id)]
        if sum(scopes) > 1:
            raise ValidationError(_(
                "A booking policy belongs to one scope: the organization, a club, "
                "or a facility."))
        if not any(scopes):
            raise ValidationError(
                {"club": _("Choose a club or a facility, or mark this as the "
                           "organization default.")})

    # ------------------------------------------------------------------ #
    # Window helpers - one place that answers "is this bookable now?"
    # ------------------------------------------------------------------ #
    def earliest_start(self, now=None):
        """The soonest slot start this policy allows."""
        from django.utils import timezone as _tz
        now = now or _tz.localtime()
        return now + timedelta(minutes=self.min_lead_minutes)

    def latest_date(self, now=None):
        """The furthest date this policy allows, or None when unlimited."""
        from django.utils import timezone as _tz
        if not self.max_advance_days:
            return None
        now = now or _tz.localtime()
        return now.date() + timedelta(days=self.max_advance_days)

    def cancellation_deadline(self, booking):
        """The moment after which the customer may no longer cancel, or None."""
        if not self.cancellation_cutoff_hours:
            return None
        from datetime import datetime as _dt
        from django.utils import timezone as _tz
        start = _dt.combine(booking.scheduled_date, booking.scheduled_time)
        if _tz.is_naive(start):
            start = _tz.make_aware(start, _tz.get_current_timezone())
        return start - timedelta(hours=self.cancellation_cutoff_hours)


class BookingStatusHistory(models.Model):
    """Immutable trail of every booking activity — status transitions AND
    non-transition events (the "Booking Log"). `meta` carries structured detail:
    source (Admin/Staff/System/Customer/API), amount impact, and old→new values
    for non-status changes."""

    booking = models.ForeignKey(
        Booking,
        on_delete=models.CASCADE,
        related_name="status_history",
    )
    from_status = models.CharField(max_length=12, choices=BookingStatus.choices, blank=True)
    to_status = models.CharField(max_length=12, choices=BookingStatus.choices)
    # Optional machine-readable kind for the log entry (e.g. coverage_applied,
    # payment_status, usage_deducted, invoice_generated); blank for plain notes.
    event = models.CharField(max_length=40, blank=True)
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="booking_transitions",
        null=True, blank=True,
    )
    note = models.CharField(max_length=255, blank=True)
    meta = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("created_at",)
        indexes = [models.Index(fields=["booking", "created_at"])]

    def __str__(self):
        return f"{self.booking_id}: {self.from_status or '∅'} → {self.to_status}"


@receiver(post_save, sender=Booking)
def _log_booking_created(sender, instance, created, **kwargs):
    """Seed the status timeline with a 'Booking created' entry so it always shows
    who created the booking and when (transitions are logged separately)."""
    if not created:
        return
    BookingStatusHistory.objects.create(
        booking=instance,
        from_status="",
        to_status=instance.status,
        changed_by=instance.created_by,
        note="Booking created",
    )


class HoldStatus(models.TextChoices):
    """Where a reservation is in its own life, which is not the booking's.

    Kept apart from `BookingStatus` on purpose. A booking is a commercial
    record; a hold is a temporary claim on a court. Folding the two together
    is what produces statuses like "pending forever" that block a slot with
    nothing behind them.
    """

    ACTIVE = "active", _("Active")
    CONVERTED = "converted", _("Converted")     # became a confirmed booking
    RELEASED = "released", _("Released")        # given up deliberately
    EXPIRED = "expired", _("Expired")           # ran out of time
    CANCELLED = "cancelled", _("Cancelled")


#: Only an ACTIVE hold keeps other people off a court. Everything else is
#: history, exactly as cancelled bookings are.
LIVE_HOLD_STATUSES = {HoldStatus.ACTIVE}


class BookingHold(models.Model):
    """A time-limited claim on one or more slots while a customer pays.

    A booking is Confirmed only when it has been paid for, so something else
    has to keep the court in the meantime. That used to be the booking row
    itself, created unpaid and blocking its slot with no deadline; a customer
    who closed the tab held a Saturday evening court until somebody noticed.

    The hold owns the deadline and the booking owns the commerce. When payment
    completes the hold CONVERTS and the confirmed booking takes over holding
    the slot permanently; when the clock runs out the hold EXPIRES and the
    court is free again, with the abandoned booking left as history.

    Guests have no account, so a hold is addressed by a bearer token stored
    only as a digest, the same treatment split payment links get. That is what
    lets a refresh, a second tab or the back button find the same reservation
    instead of starting a new one.
    """

    reference = models.CharField(
        max_length=14, unique=True, editable=False, db_index=True,
        help_text="Human-friendly reservation code, e.g. HLD-2A4F9C.",
    )
    # A digest, never the token. A leaked backup cannot be replayed.
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)

    # Nullable: a guest checkout holds a court before we know who they are.
    customer = models.ForeignKey(
        "customers.Customer", on_delete=models.CASCADE,
        related_name="booking_holds", null=True, blank=True,
    )
    club = models.ForeignKey(
        "clubs.Club", on_delete=models.CASCADE, related_name="booking_holds",
    )
    facility_type = models.ForeignKey(
        "facilities.FacilityType", on_delete=models.CASCADE,
        related_name="booking_holds", null=True, blank=True,
    )
    source = models.CharField(
        max_length=20, choices=BookingSource.choices, default=BookingSource.WEBSITE,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        related_name="created_booking_holds", null=True, blank=True,
    )

    # What it turned into, once it did. Either, never both.
    booking = models.ForeignKey(
        "Booking", on_delete=models.SET_NULL, related_name="holds",
        null=True, blank=True,
    )
    order = models.ForeignKey(
        "BookingOrder", on_delete=models.SET_NULL, related_name="holds",
        null=True, blank=True,
    )

    status = models.CharField(
        max_length=12, choices=HoldStatus.choices,
        default=HoldStatus.ACTIVE, db_index=True,
    )
    expires_at = models.DateTimeField(db_index=True)
    # The ceiling. `expires_at` may be pushed out when the first real payment
    # arrives, but never past this, so repeated small payments cannot keep a
    # court locked indefinitely.
    max_expires_at = models.DateTimeField()
    # Set the once the unpaid window becomes the part-paid window, so the
    # extension happens exactly once however many friends pay.
    extended_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [
            # The expiry sweep asks exactly this question.
            models.Index(fields=["status", "expires_at"]),
        ]
        constraints = [
            models.CheckConstraint(
                check=Q(booking__isnull=True) | Q(order__isnull=True),
                name="hold_converts_to_one_of_booking_or_order",
            ),
        ]

    def __str__(self):
        return f"{self.reference} ({self.status})"

    def save(self, *args, **kwargs):
        if not self.reference:
            for _attempt in range(5):
                candidate = f"HLD-{secrets.token_hex(3).upper()}"
                if not BookingHold.objects.filter(reference=candidate).exists():
                    self.reference = candidate
                    break
        super().save(*args, **kwargs)

    @property
    def is_live(self) -> bool:
        """Active AND still within its deadline.

        Both halves matter: a sweep that has not run yet leaves rows ACTIVE
        past their expiry, and those must not hold a court. Every read path
        asks this rather than the status alone.
        """
        return (self.status == HoldStatus.ACTIVE
                and self.expires_at > timezone.now())

    @property
    def seconds_remaining(self) -> int:
        """What a countdown should show. Never negative."""
        if self.status != HoldStatus.ACTIVE:
            return 0
        return max(0, int((self.expires_at - timezone.now()).total_seconds()))


class BookingHoldSlot(models.Model):
    """One court, on one date, for one interval, claimed by a hold.

    A hold pins a REAL facility rather than just a type, because that is the
    only way it can take part in the same "is this court free?" question a
    booking answers. Anything vaguer would let the allocator hand the same
    court to a booking while a hold was paying for it.
    """

    hold = models.ForeignKey(
        BookingHold, on_delete=models.CASCADE, related_name="slots",
    )
    facility = models.ForeignKey(
        "facilities.Facility", on_delete=models.CASCADE,
        related_name="held_slots",
    )
    scheduled_date = models.DateField(db_index=True)
    scheduled_time = models.TimeField()
    end_time = models.TimeField()

    class Meta:
        ordering = ("scheduled_date", "scheduled_time")
        indexes = [models.Index(fields=["scheduled_date", "facility"])]
        # No unique index here, deliberately.
        #
        # The obvious one would be (facility, date, start) WHERE the hold is
        # active, but a constraint condition cannot reach through a relation,
        # so it would mean copying the hold's status onto every slot row and
        # keeping the copy in step. That buys little: it would catch a hold
        # clashing with another HOLD, while the case that actually matters,
        # a hold clashing with a BOOKING, spans two tables and no index can
        # express it at all.
        #
        # Both cases are already prevented by the same thing: the club/day
        # advisory lock taken in `reservations`, which is what makes "is this
        # court free?" and "take it" one step. A denormalised column that can
        # drift is a worse backstop than the lock it would be backing up.

    def __str__(self):
        return f"{self.facility_id} {self.scheduled_date} {self.scheduled_time}"
