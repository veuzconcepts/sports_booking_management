"""Customer-website CMS content models.

The public marketing club (separate `web/` module) reads *published + enabled*
content from these models; the admin panel manages them under the "Website" menu,
gated by the `website.*` capabilities. Single-company system — content is global
(no club scoping). Contact details / socials are NOT duplicated here: they come
from `settings_app.Organization` (the single source of truth) and are merged into
the public payload by the API.
"""

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
