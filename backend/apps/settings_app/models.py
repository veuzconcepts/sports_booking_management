"""Organization-wide settings: currency master, tax rates, key/value config,
the single-row Organization profile and the booking contact rules.

Venues live in `apps.clubs` (Club) and their bookable resources in
`apps.facilities` (FacilityCategory, FacilityType, Facility, AddOn, PricingRule).
`TaxRate` holds VAT rates with one default. `SystemConfig` is a flexible
key/value store for branding and misc toggles.
"""

from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils.translation import gettext_lazy as _


class Currency(models.Model):
    """Centralized Currency Master — the single source of truth for how money
    behaves per currency (precision, internal-calc precision, smallest unit,
    rounding). Read through `apps.settings_app.currency` helpers (cached). Seeded
    by migration; manage in Django admin (a Settings UI comes later)."""

    class RoundingMethod(models.TextChoices):
        HALF_UP = "HALF_UP", _("Half up (0.5 → away from zero)")
        HALF_EVEN = "HALF_EVEN", _("Half even (banker's)")
        HALF_DOWN = "HALF_DOWN", _("Half down")
        UP = "UP", _("Up (away from zero)")
        DOWN = "DOWN", _("Down (truncate)")
        CEILING = "CEILING", _("Ceiling")
        FLOOR = "FLOOR", _("Floor")

    code = models.CharField(
        max_length=3, primary_key=True,
        help_text="ISO 4217 code, e.g. USD, AED, SAR, JPY.",
    )
    name = models.CharField(max_length=60)
    symbol = models.CharField(max_length=8, blank=True)
    precision = models.PositiveSmallIntegerField(
        default=2, help_text="Standard transaction decimal places (JPY 0, USD 2, BHD 3).",
    )
    extended_precision = models.PositiveSmallIntegerField(
        default=6, help_text="Internal-calculation decimal places; must be ≥ precision.",
    )
    minimum_accountable_unit = models.DecimalField(
        max_digits=12, decimal_places=6, default=Decimal("0.01"),
        help_text="Smallest valid currency unit final amounts snap to (e.g. 0.01).",
    )
    rounding_method = models.CharField(
        max_length=12, choices=RoundingMethod.choices, default=RoundingMethod.HALF_UP,
    )
    is_active = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("code",)
        verbose_name_plural = "currencies"

    def __str__(self):
        return f"{self.code} ({self.precision} dp)"

    def clean(self):
        super().clean()
        if self.extended_precision < self.precision:
            raise ValidationError(
                {"extended_precision": _("Extended precision must be ≥ standard precision.")}
            )


class Weekday(models.IntegerChoices):
    MON = 0, _("Monday")
    TUE = 1, _("Tuesday")
    WED = 2, _("Wednesday")
    THU = 3, _("Thursday")
    FRI = 4, _("Friday")
    SAT = 5, _("Saturday")
    SUN = 6, _("Sunday")


class TaxRate(models.Model):
    name = models.CharField(max_length=60)
    rate = models.DecimalField(
        max_digits=5, decimal_places=4,
        help_text="Fraction, e.g. 0.0500 for 5% VAT.",
    )
    country = models.CharField(max_length=60, default="UAE")
    is_default = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-is_default", "name")

    def __str__(self):
        return f"{self.name} ({self.rate})"

    def save(self, *args, **kwargs):
        if self.is_default:
            TaxRate.objects.filter(is_default=True).exclude(pk=self.pk).update(is_default=False)
        super().save(*args, **kwargs)


class SystemConfig(models.Model):
    """Flexible key/value store for branding and misc platform settings."""

    key = models.SlugField(max_length=60, unique=True)
    value = models.JSONField(default=dict, blank=True)
    description = models.CharField(max_length=255, blank=True)

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("key",)

    def __str__(self):
        return self.key


BOOKING_DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def default_booking_hours():
    """One 08:00–20:00 shift every day by default."""
    return {d: {"closed": False, "shifts": [{"open": "08:00", "close": "20:00"}]}
            for d in BOOKING_DAY_KEYS}


def normalize_day(cfg):
    """Coerce a day config into {closed: bool, shifts: [...], breaks: [...]}.

    Accepts the legacy single-shift shape ({open, close}), the multi-shift shape
    ({shifts: [...]}), and the current shape which also carries `breaks`
    ([{name, open, close}]) - periods inside the operating hours during which no
    slot may be generated (maintenance, prayer, cleaning).

    A closed day has neither shifts nor breaks: nothing to interrupt.
    """
    if not cfg:
        return {"closed": False, "shifts": [], "breaks": []}
    if cfg.get("closed"):
        return {"closed": True, "shifts": [], "breaks": []}
    shifts = cfg.get("shifts")
    if shifts is None and cfg.get("open") and cfg.get("close"):
        shifts = [{"open": cfg["open"], "close": cfg["close"]}]
    return {"closed": False, "shifts": shifts or [], "breaks": cfg.get("breaks") or []}


class Organization(models.Model):
    """Single-row organization profile: name, contact, location, socials."""

    name = models.CharField(max_length=200, blank=True)
    legal_name = models.CharField(max_length=200, blank=True)
    # Tax Registration Number — required on UAE tax invoices / tax credit notes.
    trn = models.CharField("Tax Registration Number (TRN)", max_length=30, blank=True)
    website = models.URLField(blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    address = models.CharField(max_length=300, blank=True)
    city = models.CharField(max_length=100, blank=True)
    country = models.CharField(max_length=100, blank=True)
    timezone = models.CharField(max_length=64, default="Asia/Dubai")
    time_format_24h = models.BooleanField(default=False)   # False = 12-hour (5:00 PM)

    # --- Scheduling ---------------------------------------------------------
    # The organization-wide operating pattern every club and facility inherits
    # from unless it overrides the day. Resolved by apps.settings_app.schedule.
    slot_minutes = models.PositiveSmallIntegerField(
        default=60, help_text="How often a bookable slot starts, in minutes.")
    booking_hours = models.JSONField(default=default_booking_hours, blank=True)
    buffer_before_minutes = models.PositiveSmallIntegerField(
        default=0, help_text="Preparation time held before each booking.")
    buffer_after_minutes = models.PositiveSmallIntegerField(
        default=0, help_text="Changeover time held after each booking.")

    # Finance: when on, refunds (credit notes) need maker-checker approval before
    # the money is returned; when off, a refund request is processed immediately.
    require_refund_approval = models.BooleanField(default=True)
    # Subscriptions: allow a customer to hold more than one active membership.
    allow_multiple_memberships = models.BooleanField(default=False)

    # --- Branding (uploaded in Organization Info; consumed by the website) ----
    # Logo variants so the right one can be called per theme + layout. Light = for
    # light backgrounds, dark = for dark backgrounds; horizontal = wide (header),
    # vertical = stacked/square (tight spaces). Favicon = browser tab; og_image =
    # default social-share image when a page has no per-page OG image.
    logo_light = models.ImageField(upload_to="branding/", blank=True, null=True)
    logo_dark = models.ImageField(upload_to="branding/", blank=True, null=True)
    logo_light_vertical = models.ImageField(upload_to="branding/", blank=True, null=True)
    logo_dark_vertical = models.ImageField(upload_to="branding/", blank=True, null=True)
    favicon = models.ImageField(upload_to="branding/", blank=True, null=True)
    og_image = models.ImageField(upload_to="branding/", blank=True, null=True)

    # --- SEO defaults (fallback when a page has no per-page CMS SEO) ----------
    meta_title = models.CharField(max_length=255, blank=True)
    meta_description = models.CharField(max_length=400, blank=True)

    summary = models.CharField(max_length=140, blank=True)
    description = models.TextField(blank=True)             # rich-text (HTML)

    facebook = models.URLField(blank=True)
    instagram = models.URLField(blank=True)
    twitter = models.URLField(blank=True)        # X
    linkedin = models.URLField(blank=True)
    youtube = models.URLField(blank=True)
    tiktok = models.URLField(blank=True)
    whatsapp = models.CharField(max_length=40, blank=True)   # number or wa.me link

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Organization"

    def __str__(self):
        return self.name or "Organization"

    @classmethod
    def get_solo(cls):
        """Always return the single org row, creating it on first access."""
        obj = cls.objects.first()
        return obj or cls.objects.create()


class BookingConfiguration(models.Model):
    """Single-row config controlling, per booking channel, whether the customer's
    Email / Phone are REQUIRED and whether they must be UNIQUE (no duplicate
    record allowed for that contact). Channels: Website / Admin / Walk-in.

    Defaults mirror today's behaviour plus the new rule that the website now
    requires both email and phone; uniqueness starts off everywhere.
    """

    # --- Website (public self-service booking) ---
    website_email_required = models.BooleanField(default=True)
    website_phone_required = models.BooleanField(default=True)
    website_email_unique = models.BooleanField(default=False)
    website_phone_unique = models.BooleanField(default=False)

    # --- Admin booking (staff booking for a registered customer) ---
    # Uniqueness defaults ON to preserve today's customer-create de-duplication.
    admin_email_required = models.BooleanField(default=False)
    admin_phone_required = models.BooleanField(default=False)
    admin_email_unique = models.BooleanField(default=True)
    admin_phone_unique = models.BooleanField(default=True)

    # --- Walk-in booking (staff capturing a walk-in snapshot) ---
    walkin_email_required = models.BooleanField(default=False)
    walkin_phone_required = models.BooleanField(default=False)
    walkin_email_unique = models.BooleanField(default=False)
    walkin_phone_unique = models.BooleanField(default=False)

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Booking Configuration"

    def __str__(self):
        return "Booking Configuration"

    @classmethod
    def get_solo(cls):
        """Return the single config row, creating it (with defaults) on first access."""
        obj = cls.objects.first()
        return obj or cls.objects.create()

    def rules_for(self, channel: str) -> dict:
        """The {email_required, phone_required, email_unique, phone_unique} rules
        for a channel key ('website' | 'admin' | 'walkin')."""
        ch = channel if channel in ("website", "admin", "walkin") else "website"
        return {
            "email_required": getattr(self, f"{ch}_email_required"),
            "phone_required": getattr(self, f"{ch}_phone_required"),
            "email_unique": getattr(self, f"{ch}_email_unique"),
            "phone_unique": getattr(self, f"{ch}_phone_unique"),
        }


# --------------------------------------------------------------------------- #
# Buffers and date exceptions. The weekly pattern lives as JSON on each scope
# (see apps.settings_app.schedule); exceptions are relational because they are
# queried by date range rather than read whole.
# --------------------------------------------------------------------------- #
class ScheduleExceptionQuerySet(models.QuerySet):
    def covering(self, on_date):
        """Active rows whose date range includes `on_date`."""
        return self.filter(
            is_active=True,
            start_date__lte=on_date,
        ).filter(models.Q(end_date__isnull=True, start_date=on_date)
                 | models.Q(end_date__gte=on_date))

    def for_scope(self, club=None, facility=None):
        """Rows that apply to this scope: the facility's own, its club's, and
        the organization-wide ones."""
        scope = models.Q(club__isnull=True, facility__isnull=True)   # organization
        if club is not None:
            scope |= models.Q(club=club, facility__isnull=True)
        if facility is not None:
            scope |= models.Q(facility=facility)
        return self.filter(scope)

    def resolve(self, on_date, club=None, facility=None):
        """The single exception in force: most specific scope wins, and within
        one scope the most recently created, so a correction beats the row it
        was entered to fix."""
        rows = list(self.covering(on_date).for_scope(club, facility))
        if not rows:
            return None
        rank = {"facility": 0, "club": 1, "organization": 2}
        rows.sort(key=lambda r: (rank[r.scope], -r.id))
        return rows[0]


class ScheduleException(models.Model):
    """A date, or run of dates, that overrides the weekly operating pattern.

    Public holidays, Ramadan timings, tournaments, temporary closures. Scope is
    implied by which foreign key is set: neither = whole organization, `club` =
    that venue, `facility` = that one unit. A date exception always beats the
    weekday pattern (see `apps.settings_app.schedule.resolve_for_date`).
    """

    name = models.CharField(max_length=120, help_text="Shown to staff, e.g. 'National Day'.")
    club = models.ForeignKey(
        "clubs.Club", on_delete=models.CASCADE, null=True, blank=True,
        related_name="schedule_exceptions",
        help_text="Leave empty to apply to the whole organization.")
    facility = models.ForeignKey(
        "facilities.Facility", on_delete=models.CASCADE, null=True, blank=True,
        related_name="schedule_exceptions",
        help_text="Leave empty to apply to the whole club.")

    start_date = models.DateField()
    end_date = models.DateField(
        null=True, blank=True, help_text="Leave empty for a single day.")

    closed = models.BooleanField(
        default=True, help_text="Closed all day. Untick to set custom hours instead.")
    # Same shape as one day of `booking_hours`; only read when `closed` is off.
    shifts = models.JSONField(default=list, blank=True)
    breaks = models.JSONField(default=list, blank=True)
    slot_minutes = models.PositiveSmallIntegerField(
        null=True, blank=True, help_text="Leave empty to keep the usual slot interval.")

    is_active = models.BooleanField(default=True)
    notes = models.TextField(blank=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="schedule_exceptions_created")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = ScheduleExceptionQuerySet.as_manager()

    class Meta:
        ordering = ("start_date", "name")
        indexes = [models.Index(fields=["start_date", "end_date"])]
        constraints = [
            models.CheckConstraint(
                check=models.Q(end_date__isnull=True)
                | models.Q(end_date__gte=models.F("start_date")),
                name="schedule_exception_end_after_start"),
            # A facility already implies its club; storing both invites them to
            # disagree after a facility moves.
            models.CheckConstraint(
                check=models.Q(facility__isnull=True) | models.Q(club__isnull=True),
                name="schedule_exception_single_scope"),
        ]

    def __str__(self):
        return f"{self.name} ({self.start_date})"

    @property
    def scope(self) -> str:
        if self.facility_id:
            return "facility"
        return "club" if self.club_id else "organization"

    @property
    def last_date(self):
        return self.end_date or self.start_date

    def covers(self, on_date) -> bool:
        return self.is_active and self.start_date <= on_date <= self.last_date

    def as_day_config(self) -> dict:
        """This exception expressed as a day of `booking_hours`."""
        if self.closed:
            return {"closed": True, "shifts": [], "breaks": []}
        return {"closed": False, "shifts": self.shifts or [], "breaks": self.breaks or []}

    def clean(self):
        super().clean()
        if self.end_date and self.end_date < self.start_date:
            raise ValidationError({"end_date": "The end date cannot precede the start date."})
        if self.facility_id and self.club_id:
            raise ValidationError(
                {"facility": "Choose a club or a facility, not both - a facility "
                             "already belongs to one club."})
        if not self.closed and not self.shifts:
            raise ValidationError(
                {"shifts": "Add the operating hours, or mark the date closed."})
