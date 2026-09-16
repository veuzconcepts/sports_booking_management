"""Facility catalogue: categories, bookable facility types, physical facilities,
add-ons and the dynamic pricing rules applied on top of catalogue prices.

The domain reads top-down:

    FacilityCategory   merchandising group shown on the website
                       (e.g. "Racket Sports", "Aquatics", "Indoor Spaces")
        FacilityType   the bookable, priced offering
                       (e.g. "Tennis Court", "Padel Court", "Meeting Room")
            Facility   a physical unit at a club that a booking occupies
                       (e.g. "Court 1", "Lane 3", "Hall A")

`Facility` rows are what the slot engine counts for per-club capacity.
"""

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils.translation import gettext_lazy as _


class FacilityKind(models.TextChoices):
    """Broad nature of a facility category - used for grouping and filtering."""

    OUTDOOR_COURT = "outdoor_court", _("Outdoor Court")
    INDOOR_COURT = "indoor_court", _("Indoor Court")
    PITCH = "pitch", _("Pitch / Field")
    AQUATIC = "aquatic", _("Aquatic")
    HALL = "hall", _("Hall")
    MEETING_ROOM = "meeting_room", _("Meeting Room")
    OTHER = "other", _("Other")


class BadgeStatus(models.TextChoices):
    SHOW = "show", _("Show")
    HIDE = "hide", _("Hide")


class FacilityBadge(models.TextChoices):
    PREMIUM = "premium", _("Premium")
    RECOMMENDED = "recommended", _("Recommended")
    BESTSELLER = "bestseller", _("Bestseller")


class FacilityCategory(models.Model):
    """A merchandising group of facility types (website + admin navigation)."""

    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=140, unique=True)
    kind = models.CharField(
        max_length=15,
        choices=FacilityKind.choices,
        default=FacilityKind.OUTDOOR_COURT,
    )
    description = models.TextField(blank=True, help_text="Short description.")
    base_duration_minutes = models.PositiveSmallIntegerField(default=60)
    base_price = models.DecimalField(
        max_digits=12, decimal_places=6, default=0,
        help_text="Default price for a booking made against the category itself "
                  "(high-precision; line amounts round to the currency's precision).",
    )

    # Presentation / merchandising
    banner_image = models.ImageField(upload_to="facility_categories/banners/", null=True, blank=True)
    icon = models.ImageField(
        upload_to="facility_categories/icons/", null=True, blank=True,
        help_text="Optional, for admin / compact list views.",
    )
    badge_label = models.CharField(
        max_length=30, blank=True, help_text="e.g. NEW, POPULAR, PREMIUM.",
    )
    badge_status = models.CharField(
        max_length=4, choices=BadgeStatus.choices, default=BadgeStatus.HIDE,
    )
    is_featured = models.BooleanField(default=False)
    available_clubs = models.ManyToManyField(
        "clubs.Club", blank=True, related_name="facility_categories",
        help_text="Clubs this category is available at.",
    )

    # SEO
    meta_title = models.CharField(max_length=160, blank=True)
    meta_description = models.TextField(blank=True)

    is_active = models.BooleanField(default=True)
    display_order = models.PositiveSmallIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("display_order", "name")
        verbose_name_plural = "facility categories"
        indexes = [
            models.Index(fields=["kind", "is_active"]),
        ]

    def __str__(self):
        return self.name


class FacilityType(models.Model):
    """A bookable, priced offering created under one or more categories."""

    categories = models.ManyToManyField(
        FacilityCategory,
        related_name="facility_types",
        help_text="The categories this facility type belongs to.",
    )
    name = models.CharField(max_length=120)
    tagline = models.CharField(
        max_length=120, blank=True,
        help_text="Short subtitle shown next to the name, e.g. 'Floodlit, all-weather'.",
    )
    badge = models.CharField(
        max_length=12, choices=FacilityBadge.choices, blank=True, default="",
        help_text="Highlight pill: Premium / Recommended / Bestseller.",
    )
    description = models.TextField(blank=True)
    # Rich-text (sanitised HTML) "What's Included" shown in the website modal.
    # Edited with the admin rich-text editor; sanitised on save.
    whats_included = models.TextField(blank=True)
    # Plain-text "What's NOT included" - short caveats shown as small print at the
    # foot of the website "What's Included" modal (one point per line).
    whats_not_included = models.TextField(blank=True)
    duration_minutes = models.PositiveSmallIntegerField(default=60)

    # Media - an image and/or a short video clip.
    image = models.ImageField(upload_to="facility_types/images/", null=True, blank=True)
    video = models.FileField(upload_to="facility_types/videos/", null=True, blank=True)

    # Club availability - either all clubs, or a chosen subset.
    available_all_clubs = models.BooleanField(
        default=True,
        help_text="If on, this facility type is bookable at every club.",
    )
    available_clubs = models.ManyToManyField(
        "clubs.Club", blank=True, related_name="facility_types",
        help_text="Clubs this facility type is bookable at (when not 'all clubs').",
    )

    price = models.DecimalField(
        max_digits=12, decimal_places=6, default=0,
        help_text="Price for one booking slot (high-precision unit price).",
    )
    tax_percent = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        help_text="Tax / VAT applied on top of the price.",
    )
    tax_inclusive = models.BooleanField(
        default=False,
        help_text="On = the price already includes tax; off = tax is added on top.",
    )
    discount_percent = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
    )

    add_ons = models.ManyToManyField(
        "AddOn", related_name="facility_types", blank=True,
    )

    staff_required = models.BooleanField(default=False)
    facility_required = models.BooleanField(
        default=True,
        help_text="On = a booking must occupy a physical facility (court, lane, room).",
    )
    online_booking_enabled = models.BooleanField(default=True)
    is_active = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("name",)
        indexes = [
            models.Index(fields=["is_active"]),
        ]

    def __str__(self):
        return self.name


class Facility(models.Model):
    """A physical bookable unit at a club - court, pitch, lane, hall or room.

    This is what the slot engine counts for a club's per-slot capacity, and what
    a booking is allocated to. `facility_types` says which bookable types this
    unit can serve, so a multi-purpose space (a hall that is badminton courts by
    day and a function room by night) is ONE row that can never double-book
    itself.
    """

    club = models.ForeignKey(
        "clubs.Club", on_delete=models.CASCADE, related_name="facilities",
    )
    name = models.CharField(max_length=40, help_text="e.g. 'Court 1', 'Lane 3', 'Hall A'.")
    facility_types = models.ManyToManyField(
        "FacilityType", blank=True, related_name="facilities",
        help_text="Which facility types this unit can be booked as. "
                  "Leave empty to make it usable for any type.",
    )
    # --- Scheduling ---------------------------------------------------------
    # Per-facility operating pattern, resolved by apps.settings_app.schedule.
    # EMPTY = inherit the club entirely. A dict holding only some weekdays
    # overrides just those days and inherits the rest, so a unit that differs
    # only on Friday stores only Friday.
    booking_hours = models.JSONField(
        default=dict, blank=True,
        help_text="Weekday overrides. Empty inherits the club.")
    slot_minutes = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="How often a slot starts, in minutes. Empty inherits the club.")
    buffer_before_minutes = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Preparation time held before each booking. Empty inherits the club.")
    buffer_after_minutes = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Changeover time held after each booking. Empty inherits the club.")

    is_active = models.BooleanField(default=True)
    notes = models.CharField(max_length=255, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("club", "name")
        verbose_name_plural = "facilities"
        constraints = [
            models.UniqueConstraint(fields=["club", "name"], name="unique_facility_per_club"),
        ]

    def __str__(self):
        return f"{self.club.code} - {self.name}"

    def serves(self, facility_type) -> bool:
        """Whether this unit can host `facility_type`. A unit with no declared
        types is unrestricted, which keeps a simple single-purpose club working
        without any per-facility setup."""
        if facility_type is None:
            return True
        type_ids = {t.id for t in self.facility_types.all()}
        return not type_ids or facility_type.id in type_ids


class MaintenanceBlock(models.Model):
    """A period during which one facility is out of service.

    Counts against capacity exactly like a booking does, so a court closed for
    resurfacing simply stops being offered. All-day when both times are blank;
    otherwise it only blocks the given window on each day in the range.
    """

    facility = models.ForeignKey(
        Facility, on_delete=models.CASCADE, related_name="maintenance_blocks",
    )
    start_date = models.DateField()
    end_date = models.DateField(help_text="Inclusive - the last day out of service.")
    start_time = models.TimeField(
        null=True, blank=True, help_text="Blank = all day.",
    )
    end_time = models.TimeField(null=True, blank=True)
    reason = models.CharField(
        max_length=255, blank=True, help_text="e.g. 'Resurfacing', 'Net replacement'.",
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-start_date", "facility")
        indexes = [
            models.Index(fields=["facility", "start_date", "end_date"]),
        ]

    def __str__(self):
        return f"{self.facility} blocked {self.start_date} to {self.end_date}"

    @property
    def is_all_day(self) -> bool:
        return self.start_time is None and self.end_time is None

    def clean(self):
        super().clean()
        errors = {}
        if self.start_date and self.end_date and self.end_date < self.start_date:
            errors["end_date"] = _("End date cannot be before the start date.")
        if bool(self.start_time) != bool(self.end_time):
            errors["start_time"] = _(
                "Give both a start and an end time, or leave both blank for all day.")
        elif (self.start_time and self.end_time and self.end_time <= self.start_time):
            errors["end_time"] = _("End time must be after start time.")
        if errors:
            raise ValidationError(errors)

    def covers(self, on_date, start_time=None, end_time=None) -> bool:
        """True when this block removes the facility for the given date, and
        (when times are given) for that time window."""
        if not (self.start_date <= on_date <= self.end_date):
            return False
        if self.is_all_day or start_time is None or end_time is None:
            return True
        return self.start_time < end_time and start_time < self.end_time


class AddOn(models.Model):
    """An optional extra that can be added to a booking (equipment hire,
    refreshments, floodlights, and so on). Priced and taxed independently."""

    name = models.CharField(max_length=100)
    code = models.CharField(
        max_length=40, unique=True, null=True, blank=True,
        help_text="Optional unique code / SKU.",
    )
    description = models.TextField(blank=True)
    categories = models.ManyToManyField(
        FacilityCategory, blank=True, related_name="addons",
        help_text="Optional facility categories this add-on belongs to.",
    )
    price = models.DecimalField(max_digits=12, decimal_places=6, default=0)   # unit price (high precision)
    tax_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    tax_inclusive = models.BooleanField(
        default=False,
        help_text="On = the price already includes tax; off = tax is added on top.",
    )
    duration_minutes = models.PositiveSmallIntegerField(default=0)

    # Club availability - either all clubs, or a chosen subset.
    available_all_clubs = models.BooleanField(default=True)
    available_clubs = models.ManyToManyField(
        "clubs.Club", blank=True, related_name="addons",
    )

    image = models.ImageField(upload_to="addons/icons/", null=True, blank=True)
    is_featured = models.BooleanField(default=False)
    display_order = models.PositiveSmallIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ("display_order", "name")

    def __str__(self):
        return self.name


class PricingRuleType(models.TextChoices):
    CLUB = "club", _("Club Pricing")
    MEMBERSHIP = "membership", _("Membership Discount")
    PROMO = "promo", _("Promo Pricing")
    DATE_RANGE = "date_range", _("Date Range Pricing")
    WEEKEND = "weekend", _("Weekend Pricing")
    PEAK_HOUR = "peak_hour", _("Peak Hour Pricing")
    CUSTOM = "custom", _("Custom Pricing")


class PricingAdjustmentType(models.TextChoices):
    FIXED_INCREASE = "fixed_increase", _("Fixed Amount Increase")
    FIXED_DISCOUNT = "fixed_discount", _("Fixed Amount Discount")
    PERCENT_INCREASE = "percent_increase", _("Percentage Increase")
    PERCENT_DISCOUNT = "percent_discount", _("Percentage Discount")
    OVERRIDE = "override", _("Override Price")


class PricingRule(models.Model):
    """Dynamic pricing adjustment applied on top of a base price."""

    name = models.CharField(max_length=120)
    code = models.CharField(max_length=40, unique=True)
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    priority = models.PositiveIntegerField(
        default=100, help_text="Lower number = higher priority when several rules match.",
    )
    display_order = models.PositiveIntegerField(default=0)

    rule_type = models.CharField(max_length=20, choices=PricingRuleType.choices)
    adjustment_type = models.CharField(max_length=20, choices=PricingAdjustmentType.choices)
    adjustment_value = models.DecimalField(max_digits=11, decimal_places=3, default=0)
    currency = models.CharField(max_length=3, blank=True, help_text="Blank = system default.")
    tax_applicable = models.BooleanField(default=False)
    allow_stacking = models.BooleanField(
        default=True, help_text="If off, stop after this rule is applied.",
    )

    # --- Apply rule to (targets) ---
    categories = models.ManyToManyField(
        "FacilityCategory", blank=True, related_name="pricing_rules",
    )
    facility_types = models.ManyToManyField(
        "FacilityType", blank=True, related_name="pricing_rules",
    )
    addons = models.ManyToManyField(
        "AddOn", blank=True, related_name="pricing_rules",
    )

    # --- Conditions ---
    clubs = models.ManyToManyField(
        "clubs.Club", blank=True, related_name="pricing_rules",
    )
    membership_plans = models.ManyToManyField(
        "payments.MembershipPlan", blank=True, related_name="pricing_rules",
    )
    customer_types = models.JSONField(default=list, blank=True)  # LoyaltyTier values
    days_of_week = models.JSONField(default=list, blank=True)    # ints 0=Mon .. 6=Sun

    valid_from = models.DateField(null=True, blank=True)
    valid_to = models.DateField(null=True, blank=True)
    start_time = models.TimeField(null=True, blank=True)
    end_time = models.TimeField(null=True, blank=True)
    min_amount = models.DecimalField(max_digits=11, decimal_places=3, null=True, blank=True)
    min_quantity = models.PositiveIntegerField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("priority", "display_order", "name")
        indexes = [
            models.Index(fields=["is_active", "rule_type"]),
            models.Index(fields=["priority"]),
        ]

    def __str__(self):
        return f"{self.name} ({self.code})"
