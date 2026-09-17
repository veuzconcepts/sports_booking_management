"""Customer-website CMS content models.

The public marketing club (separate `web/` module) reads *published + enabled*
content from these models; the admin panel manages them under the "Website" menu,
gated by the `website.*` capabilities. Single-company system — content is global
(no club scoping). Contact details / socials are NOT duplicated here: they come
from `settings_app.Organization` (the single source of truth) and are merged into
the public payload by the API.
"""

from django.core.exceptions import ValidationError
from django.db import models


class TimeStamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class PublishableContent(TimeStamped):
    """Shared content controls: show/hide in the page, draft↔live, and ordering.

    The public API returns only rows with `is_enabled` AND `is_published` true,
    ordered by `display_order`.
    """

    is_enabled = models.BooleanField(
        default=True, help_text="Show this item on the club (section-level on/off).")
    is_published = models.BooleanField(
        default=False, help_text="Live on the public club. Toggled via the publish action.")
    published_at = models.DateTimeField(null=True, blank=True)
    display_order = models.PositiveIntegerField(default=0)

    class Meta:
        abstract = True
        ordering = ["display_order", "id"]


class MediaAsset(TimeStamped):
    """Reusable upload for the Media Library — referenced by content sections so
    images/icons/logos have a single managed source with accessible alt text."""

    class Kind(models.TextChoices):
        IMAGE = "image", "Image"
        ICON = "icon", "Icon"
        LOGO = "logo", "Logo"
        VIDEO = "video", "Video"

    title = models.CharField(max_length=140, blank=True)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.IMAGE)
    file = models.FileField(upload_to="website/media/")
    alt_text = models.CharField(
        max_length=200, blank=True, help_text="Describes the image for SEO / screen readers.")

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.title or (self.file.name if self.file else f"Media {self.pk}")


class SiteSection(PublishableContent):
    """Per-section heading / copy / background for the fixed homepage sections
    (one row per `key`). Collection items (banners, services, FAQs…) live in their
    own models; this controls the section-level wrapper around them."""

    class Key(models.TextChoices):
        HERO = "hero", "Hero"
        HOW_IT_WORKS = "how_it_works", "How It Works"
        WHY_CHOOSE_US = "why_choose_us", "Why Choose Us"
        SERVICES = "services", "Services"
        # Discovery sections on the redesigned homepage. Additive: an
        # organization that has not authored one simply does not get it.
        CLUBS = "clubs", "Clubs & Venues"
        AVAILABILITY = "availability", "Live Availability"
        OWNER_CTA = "owner_cta", "For Club Owners"
        PACKAGES = "packages", "Packages"
        MEMBERSHIP = "membership", "Membership Highlights"
        PROJECTS = "projects", "Latest Projects"
        STATS = "stats", "Stats"
        BRANDS = "brands", "Trusted Brands"
        TESTIMONIALS = "testimonials", "Testimonials"
        FAQ = "faq", "FAQ"
        CTA_BAND = "cta_band", "Call To Action"
        APP_PROMO = "app_promo", "App Promo"

    key = models.CharField(max_length=32, choices=Key.choices, unique=True)
    eyebrow = models.CharField(max_length=120, blank=True, help_text="Small label above the title.")
    title = models.CharField(max_length=200, blank=True)
    subtitle = models.CharField(max_length=300, blank=True)
    description = models.TextField(blank=True)
    image = models.ForeignKey(MediaAsset, null=True, blank=True, on_delete=models.SET_NULL,
                              related_name="+")
    background_image = models.ForeignKey(MediaAsset, null=True, blank=True, on_delete=models.SET_NULL,
                                         related_name="+")
    primary_button_label = models.CharField(max_length=60, blank=True)
    primary_button_url = models.CharField(max_length=255, blank=True)
    secondary_button_label = models.CharField(max_length=60, blank=True)
    secondary_button_url = models.CharField(max_length=255, blank=True)
    animation = models.CharField(max_length=60, blank=True, help_text="Optional animation hint, e.g. fade / slide.")

    def __str__(self):
        return self.get_key_display()


class Banner(PublishableContent):
    """A rotating hero banner slide."""

    heading = models.CharField(max_length=200)
    subheading = models.CharField(max_length=300, blank=True)
    image = models.ForeignKey(MediaAsset, null=True, blank=True, on_delete=models.SET_NULL,
                              related_name="+")
    cta_label = models.CharField(max_length=60, blank=True)
    cta_url = models.CharField(max_length=255, blank=True)

    def __str__(self):
        return self.heading


class ProcessStep(PublishableContent):
    """A "How it works" step (e.g. 01 Booking, 02 Inspection)."""

    step_no = models.CharField(max_length=8, blank=True)
    title = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    icon = models.ForeignKey(MediaAsset, null=True, blank=True, on_delete=models.SET_NULL,
                             related_name="+")

    def __str__(self):
        return f"{self.step_no} {self.title}".strip()


# Services and Subscriptions are managed under Operations (Services & Subscriptions);
# the website reads them from those modules directly, so there is no CMS content
# type for them here.


class WhyChooseUsPoint(PublishableContent):
    title = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    icon = models.ForeignKey(MediaAsset, null=True, blank=True, on_delete=models.SET_NULL,
                             related_name="+")

    def __str__(self):
        return self.title


class StatItem(PublishableContent):
    """A headline figure (e.g. 1830+ Works executed)."""

    value = models.CharField(max_length=40)
    label = models.CharField(max_length=120)

    def __str__(self):
        return f"{self.value} {self.label}".strip()


class Testimonial(PublishableContent):
    author_name = models.CharField(max_length=120)
    author_role = models.CharField(max_length=120, blank=True)
    author_photo = models.ForeignKey(MediaAsset, null=True, blank=True, on_delete=models.SET_NULL,
                                     related_name="+")
    rating = models.PositiveSmallIntegerField(default=5, help_text="1–5 stars.")
    quote = models.TextField()

    def __str__(self):
        return self.author_name


class BrandLogo(PublishableContent):
    """A trusted-brand / partner logo."""

    name = models.CharField(max_length=120)
    logo = models.ForeignKey(MediaAsset, null=True, blank=True, on_delete=models.SET_NULL,
                             related_name="+")
    url = models.URLField(blank=True)

    def __str__(self):
        return self.name


class FAQItem(PublishableContent):
    question = models.CharField(max_length=255)
    answer = models.TextField()

    def __str__(self):
        return self.question


class FooterConfig(TimeStamped):
    """Footer-specific content (singleton). Contact details and socials are NOT
    stored here — they come from `Organization`; only the footer link columns,
    newsletter and legal/bottom links live here."""

    about_text = models.TextField(blank=True)
    link_columns = models.JSONField(
        default=list, blank=True,
        help_text='[{"title": "About Us", "links": [{"label": "...", "url": "..."}]}]')
    newsletter_enabled = models.BooleanField(default=True)
    newsletter_heading = models.CharField(max_length=200, blank=True)
    copyright_text = models.CharField(max_length=200, blank=True)
    bottom_links = models.JSONField(
        default=list, blank=True,
        help_text='[{"label": "Terms", "url": "/terms"}] - legal links on the bottom bar.')

    class Meta:
        verbose_name = "Footer configuration"

    def __str__(self):
        return "Footer configuration"

    @classmethod
    def get_solo(cls):
        obj = cls.objects.first()
        return obj or cls.objects.create()


class SEOSetting(TimeStamped):
    """Per-path SEO metadata. The home page uses path "/"."""

    path = models.CharField(max_length=200, unique=True, default="/",
                            help_text='Page path, e.g. "/" for the home page.')
    meta_title = models.CharField(max_length=255, blank=True)
    meta_description = models.CharField(max_length=400, blank=True)
    og_image = models.ForeignKey(MediaAsset, null=True, blank=True, on_delete=models.SET_NULL,
                                 related_name="+", help_text="Social share image (Open Graph).")
    canonical_url = models.URLField(blank=True)
    robots = models.CharField(max_length=60, blank=True, default="index,follow")
    structured_data = models.JSONField(
        default=dict, blank=True, help_text="Optional JSON-LD object served in the page head.")

    class Meta:
        ordering = ["path"]

    def __str__(self):
        return f"SEO {self.path}"


class WebsiteCampaign(PublishableContent):
    """A promotional card shown on the customer website for a fixed period.

    Offers, Ramadan and Eid greetings, National Day, tournaments, a new court,
    a maintenance notice. One record covers all of them because the difference
    between them is the artwork and the words, not the mechanism.

    WHAT THIS IS NOT
        A campaign promotes; it never decides. It does not price anything,
        validate a discount, grant an entitlement, open a slot or move a
        closure. A campaign advertising "20 percent off in Ramadan" carries a
        reference to the promo code that already exists, and the promo engine
        still validates it at booking time exactly as it would without any
        campaign. Linking a holiday likewise only borrows its dates; the
        scheduling engine remains the authority on when a club is open.

    ELIGIBILITY
        Resolved on the server, never in the browser. The browser is told only
        which campaigns it may show, and then decides how often to show them
        from `frequency`. Nothing private travels with that.
    """

    class Type(models.TextChoices):
        OFFER = "offer", "Offer / Promotion"
        HOLIDAY = "holiday", "Holiday Greeting"
        RAMADAN = "ramadan", "Ramadan"
        EID = "eid", "Eid"
        NATIONAL_DAY = "national_day", "National Day"
        EVENT = "event", "Event"
        TOURNAMENT = "tournament", "Tournament"
        MEMBERSHIP = "membership", "Membership Offer"
        NEW_FACILITY = "new_facility", "New Facility"
        ANNOUNCEMENT = "announcement", "Announcement"
        MAINTENANCE = "maintenance", "Maintenance Notice"
        MARKETING = "marketing", "General Marketing"
        CUSTOM = "custom", "Custom"

    class Frequency(models.TextChoices):
        """How often one browser sees the same campaign."""

        EVERY_VISIT = "every_visit", "Every visit"
        SESSION = "session", "Once per session"
        DAILY = "daily", "Once per day"
        ONCE = "once", "Once per browser"
        UNTIL_CLOSED = "until_closed", "Every page until closed"

    class Placement(models.TextChoices):
        HOME = "home", "Homepage only"
        BOOKING = "booking", "Booking pages"
        ALL = "all", "All public pages"

    class Audience(models.TextChoices):
        EVERYONE = "everyone", "Everyone"
        GUESTS = "guests", "Guests only"
        MEMBERS = "members", "Signed-in customers"

    class Priority(models.IntegerChoices):
        LOW = 10, "Low"
        NORMAL = 20, "Normal"
        HIGH = 30, "High"

    name = models.CharField(
        max_length=140, help_text="Internal name, e.g. Ramadan 2027 offer.")
    campaign_type = models.CharField(
        max_length=20, choices=Type.choices, default=Type.OFFER)
    title = models.CharField(
        max_length=160, blank=True, help_text="Headline shown to the customer.")
    subtitle = models.CharField(max_length=240, blank=True)
    description = models.TextField(blank=True)

    # The artwork is the campaign. Both images are optional so a text-only
    # notice (a maintenance warning, say) needs no design work.
    image = models.ForeignKey(
        MediaAsset, null=True, blank=True, on_delete=models.SET_NULL, related_name="+",
        help_text="Main artwork. Used on every screen unless a mobile version is set.")
    mobile_image = models.ForeignKey(
        MediaAsset, null=True, blank=True, on_delete=models.SET_NULL, related_name="+",
        help_text="Optional portrait artwork for phones. Falls back to the main image.")
    alt_text = models.CharField(
        max_length=200, blank=True,
        help_text="Describes the artwork for screen readers. Leave empty if decorative.")

    cta_label = models.CharField(max_length=60, blank=True)
    cta_url = models.CharField(
        max_length=500, blank=True,
        help_text="An internal path such as /book, or a full https:// address.")
    secondary_cta_label = models.CharField(max_length=60, blank=True)
    secondary_cta_url = models.CharField(max_length=500, blank=True)

    starts_at = models.DateTimeField(help_text="When the campaign starts showing.")
    ends_at = models.DateTimeField(help_text="When it stops showing.")

    frequency = models.CharField(
        max_length=14, choices=Frequency.choices, default=Frequency.SESSION)
    placement = models.CharField(
        max_length=10, choices=Placement.choices, default=Placement.HOME)
    audience = models.CharField(
        max_length=10, choices=Audience.choices, default=Audience.EVERYONE)
    priority = models.PositiveSmallIntegerField(
        choices=Priority.choices, default=Priority.NORMAL,
        help_text="Only the highest-priority eligible campaign opens first.")
    dismissible = models.BooleanField(
        default=True,
        help_text="Customers can close it. Turn off only for a notice they must read.")

    # Scope. Empty means the whole organization, which is the common case; a
    # selection narrows the campaign to those venues.
    clubs = models.ManyToManyField(
        "clubs.Club", blank=True, related_name="website_campaigns",
        help_text="Leave empty to show on the whole website.")
    facilities = models.ManyToManyField(
        "facilities.Facility", blank=True, related_name="website_campaigns")

    # References, not copies. The linked systems stay authoritative.
    promo_code = models.ForeignKey(
        "promotions.PromoCode", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="website_campaigns",
        help_text="Promotes this code. Validation stays with the promo engine.")
    schedule_exception = models.ForeignKey(
        "settings_app.ScheduleException", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="website_campaigns",
        help_text="Borrows a special date's period. Changes nothing about the schedule.")

    internal_notes = models.TextField(
        blank=True, help_text="Never shown on the website.")
    is_archived = models.BooleanField(
        default=False, help_text="Hidden from the list but kept, along with its figures.")

    # Engagement. Counters rather than rows: the question is whether a campaign
    # worked, which does not need to know who saw it.
    impressions = models.PositiveIntegerField(default=0)
    dismissals = models.PositiveIntegerField(default=0)
    cta_clicks = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["-priority", "display_order", "-starts_at"]
        indexes = [
            models.Index(fields=["starts_at", "ends_at"]),
            models.Index(fields=["is_enabled", "is_published"]),
        ]
        constraints = [
            models.CheckConstraint(
                check=models.Q(ends_at__gt=models.F("starts_at")),
                name="website_campaign_ends_after_start"),
        ]

    def __str__(self):
        return self.name

    # ---------------------------------------------------------------- state --
    STATUS_DRAFT = "draft"
    STATUS_DISABLED = "disabled"
    STATUS_SCHEDULED = "scheduled"
    STATUS_ACTIVE = "active"
    STATUS_EXPIRED = "expired"

    def status_at(self, now=None) -> str:
        """The campaign's state, derived rather than stored.

        Storing a status beside the dates invites the two to disagree; a row
        saying "active" while its end date is in the past is worse than no
        status at all. This is computed every time it is asked for.
        """
        from django.utils import timezone as tz

        now = now or tz.now()
        if not self.is_published:
            return self.STATUS_DRAFT
        if not self.is_enabled:
            return self.STATUS_DISABLED
        if now < self.starts_at:
            return self.STATUS_SCHEDULED
        if now > self.ends_at:
            return self.STATUS_EXPIRED
        return self.STATUS_ACTIVE

    @property
    def status(self) -> str:
        return self.status_at()

    def clean(self):
        super().clean()
        if self.starts_at and self.ends_at and self.ends_at <= self.starts_at:
            raise ValidationError({"ends_at": "The end must come after the start."})
