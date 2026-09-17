"""Website CMS serializers.

One serializer per content model, used for BOTH the authenticated CMS endpoints
(writable, including the media FK ids) and the public read endpoint (the resolved
`*_detail` media blocks are what the public website consumes). `is_published` /
`published_at` are read-only here — publishing goes through the dedicated action
so it can be gated by `website.publish` separately from `website.edit`.
"""

from rest_framework import serializers

from .models import (
    Banner,
    BrandLogo,
    FAQItem,
    FooterConfig,
    MediaAsset,
    ProcessStep,
    SEOSetting,
    SiteSection,
    StatItem,
    Testimonial,
    WebsiteCampaign,
    WhyChooseUsPoint,
)


def media_repr(asset, request=None):
    """Compact, front-end-ready representation of a MediaAsset: absolute URL + alt."""
    if not asset or not getattr(asset, "file", None):
        return None
    url = asset.file.url
    if request is not None:
        url = request.build_absolute_uri(url)
    return {"id": asset.id, "url": url, "alt": asset.alt_text, "kind": asset.kind}


class _Base(serializers.ModelSerializer):
    """Common read-only publishing fields for content serializers."""

    class Meta:
        read_only_fields = ("is_published", "published_at", "created_at", "updated_at")

    def _media(self, asset):
        return media_repr(asset, self.context.get("request"))


class MediaAssetSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()

    class Meta:
        model = MediaAsset
        fields = ("id", "title", "kind", "file", "url", "alt_text", "created_at")
        read_only_fields = ("id", "url", "created_at")

    def get_url(self, obj):
        if not obj.file:
            return None
        request = self.context.get("request")
        return request.build_absolute_uri(obj.file.url) if request else obj.file.url


class SiteSectionSerializer(_Base):
    image_detail = serializers.SerializerMethodField()
    background_image_detail = serializers.SerializerMethodField()
    key_display = serializers.CharField(source="get_key_display", read_only=True)

    class Meta(_Base.Meta):
        model = SiteSection
        fields = (
            "id", "key", "key_display", "eyebrow", "title", "subtitle", "description",
            "image", "image_detail", "background_image", "background_image_detail",
            "primary_button_label", "primary_button_url",
            "secondary_button_label", "secondary_button_url", "animation",
            "is_enabled", "is_published", "published_at", "display_order",
            "created_at", "updated_at",
        )

    def get_image_detail(self, obj):
        return self._media(obj.image)

    def get_background_image_detail(self, obj):
        return self._media(obj.background_image)


class BannerSerializer(_Base):
    image_detail = serializers.SerializerMethodField()

    class Meta(_Base.Meta):
        model = Banner
        fields = (
            "id", "heading", "subheading", "image", "image_detail",
            "cta_label", "cta_url",
            "is_enabled", "is_published", "published_at", "display_order",
            "created_at", "updated_at",
        )

    def get_image_detail(self, obj):
        return self._media(obj.image)


class ProcessStepSerializer(_Base):
    icon_detail = serializers.SerializerMethodField()

    class Meta(_Base.Meta):
        model = ProcessStep
        fields = (
            "id", "step_no", "title", "description", "icon", "icon_detail",
            "is_enabled", "is_published", "published_at", "display_order",
            "created_at", "updated_at",
        )

    def get_icon_detail(self, obj):
        return self._media(obj.icon)


class WhyChooseUsPointSerializer(_Base):
    icon_detail = serializers.SerializerMethodField()

    class Meta(_Base.Meta):
        model = WhyChooseUsPoint
        fields = (
            "id", "title", "description", "icon", "icon_detail",
            "is_enabled", "is_published", "published_at", "display_order",
            "created_at", "updated_at",
        )

    def get_icon_detail(self, obj):
        return self._media(obj.icon)


class StatItemSerializer(_Base):
    class Meta(_Base.Meta):
        model = StatItem
        fields = (
            "id", "value", "label",
            "is_enabled", "is_published", "published_at", "display_order",
            "created_at", "updated_at",
        )


class TestimonialSerializer(_Base):
    author_photo_detail = serializers.SerializerMethodField()

    class Meta(_Base.Meta):
        model = Testimonial
        fields = (
            "id", "author_name", "author_role", "author_photo", "author_photo_detail",
            "rating", "quote",
            "is_enabled", "is_published", "published_at", "display_order",
            "created_at", "updated_at",
        )

    def get_author_photo_detail(self, obj):
        return self._media(obj.author_photo)


class BrandLogoSerializer(_Base):
    logo_detail = serializers.SerializerMethodField()

    class Meta(_Base.Meta):
        model = BrandLogo
        fields = (
            "id", "name", "logo", "logo_detail", "url",
            "is_enabled", "is_published", "published_at", "display_order",
            "created_at", "updated_at",
        )

    def get_logo_detail(self, obj):
        return self._media(obj.logo)


class FAQItemSerializer(_Base):
    class Meta(_Base.Meta):
        model = FAQItem
        fields = (
            "id", "question", "answer",
            "is_enabled", "is_published", "published_at", "display_order",
            "created_at", "updated_at",
        )


class FooterConfigSerializer(serializers.ModelSerializer):
    class Meta:
        model = FooterConfig
        fields = (
            "id", "about_text", "link_columns", "newsletter_enabled",
            "newsletter_heading", "copyright_text", "bottom_links", "updated_at",
        )
        read_only_fields = ("id", "updated_at")


class SEOSettingSerializer(serializers.ModelSerializer):
    og_image_detail = serializers.SerializerMethodField()

    class Meta:
        model = SEOSetting
        fields = (
            "id", "path", "meta_title", "meta_description",
            "og_image", "og_image_detail", "canonical_url", "robots", "structured_data",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "created_at", "updated_at")

    def get_og_image_detail(self, obj):
        return media_repr(obj.og_image, self.context.get("request"))


# --------------------------------------------------------------------------- #
# Public catalogue - read-only views over the EXISTING Operations modules
# (facility categories / facility types / subscriptions). The website never
# re-authors this data; it reads it live, honouring the operational flags.
# --------------------------------------------------------------------------- #
def _abs_image(field, request):
    if not field:
        return None
    return request.build_absolute_uri(field.url) if request is not None else field.url


class PublicCategorySerializer(serializers.Serializer):
    """A facility category (apps.facilities.FacilityCategory)."""

    id = serializers.IntegerField()
    name = serializers.CharField()
    slug = serializers.CharField()
    kind = serializers.CharField()
    kind_display = serializers.CharField(source="get_kind_display")
    description = serializers.CharField()
    is_featured = serializers.BooleanField()
    display_order = serializers.IntegerField()
    icon = serializers.SerializerMethodField()
    banner = serializers.SerializerMethodField()
    badge = serializers.SerializerMethodField()

    def get_icon(self, obj) -> str:
        return _abs_image(obj.icon, self.context.get("request"))

    def get_banner(self, obj) -> str:
        return _abs_image(obj.banner_image, self.context.get("request"))

    def get_badge(self, obj) -> str:
        return obj.badge_label if obj.badge_status == "show" and obj.badge_label else None


class PublicFacilityTypeSerializer(serializers.Serializer):
    """A bookable facility type (apps.facilities.FacilityType). `price` is the
    slot price; currency is the org default."""

    id = serializers.IntegerField()
    name = serializers.CharField()
    tagline = serializers.CharField()
    description = serializers.CharField()
    whats_included = serializers.CharField()
    whats_not_included = serializers.CharField()
    badge = serializers.CharField()
    badge_display = serializers.CharField(source="get_badge_display")
    duration_minutes = serializers.IntegerField()
    image = serializers.SerializerMethodField()
    video = serializers.SerializerMethodField()
    category_ids = serializers.SerializerMethodField()
    category_names = serializers.SerializerMethodField()
    price = serializers.SerializerMethodField()
    tax_percent = serializers.SerializerMethodField()
    tax_inclusive = serializers.BooleanField()
    add_ons = serializers.SerializerMethodField()
    currency = serializers.SerializerMethodField()

    def get_image(self, obj) -> str:
        return _abs_image(obj.image, self.context.get("request"))

    def get_video(self, obj) -> str:
        return _abs_image(obj.video, self.context.get("request"))

    def get_category_ids(self, obj) -> list:
        return [c.id for c in obj.categories.all()]

    def get_category_names(self, obj) -> list:
        return [c.name for c in obj.categories.all()]

    def get_price(self, obj) -> str:
        return str(obj.price)

    def get_tax_percent(self, obj) -> str:
        return str(obj.tax_percent)

    def get_add_ons(self, obj) -> list:
        req = self.context.get("request")
        items = sorted(
            (a for a in obj.add_ons.all() if a.is_active),
            key=lambda a: (a.display_order, a.name),
        )
        return [{
            "id": a.id,
            "name": a.name,
            "description": a.description,
            "price": str(a.price),
            "tax_inclusive": a.tax_inclusive,
            "duration_minutes": a.duration_minutes,
            "image": _abs_image(a.image, req),
        } for a in items]

    def get_currency(self, obj) -> str:
        return self.context.get("currency")


class PublicClubSerializer(serializers.Serializer):
    """An active club / location (apps.clubs.Club) for the booking
    location step — searchable by address and pinnable on the map."""

    id = serializers.IntegerField()
    code = serializers.CharField()
    name = serializers.CharField()
    address = serializers.CharField()
    city = serializers.CharField()
    phone = serializers.CharField()
    latitude = serializers.SerializerMethodField()
    longitude = serializers.SerializerMethodField()

    def get_latitude(self, obj) -> float:
        return float(obj.latitude) if obj.latitude is not None else None

    def get_longitude(self, obj) -> float:
        return float(obj.longitude) if obj.longitude is not None else None


class PublicPlanSerializer(serializers.Serializer):
    """A subscription plan (apps.payments.MembershipPlan)."""

    id = serializers.IntegerField()
    name = serializers.CharField()
    code = serializers.CharField()
    description = serializers.CharField()
    price = serializers.SerializerMethodField()
    currency = serializers.SerializerMethodField()
    interval = serializers.CharField()
    interval_display = serializers.CharField(source="get_interval_display")
    entitlements = serializers.SerializerMethodField()

    def get_price(self, obj) -> str:
        return str(obj.price)

    def get_currency(self, obj) -> str:
        return self.context.get("currency")

    def get_entitlements(self, obj) -> list:
        out = []
        for e in obj.entitlements.all():
            label = (getattr(e.facility_type, "name", None) or getattr(e.facility_category, "name", None)
                     or getattr(e.addon, "name", None) or "Item")
            limit = "Unlimited" if e.limit_type == "unlimited" else f"{e.quantity} per {e.period}"
            out.append(f"{label}: {limit}")
        return out


# --------------------------------------------------------------------------- #
# Website campaigns
# --------------------------------------------------------------------------- #
def _safe_link(value, field):
    """A link a campaign may point at.

    An internal path or an ordinary web address only. `javascript:` and `data:`
    are refused outright: a campaign is content an operator types, and content
    that can execute is not content. Everything else is left alone so an
    operator can link wherever they legitimately need to.
    """
    text = (value or "").strip()
    if not text:
        return ""
    lowered = text.lower()
    if lowered.startswith(("javascript:", "data:", "vbscript:")):
        raise serializers.ValidationError({field: "That link type is not allowed."})
    if text.startswith("/") or lowered.startswith(("http://", "https://", "mailto:", "tel:")):
        return text
    raise serializers.ValidationError(
        {field: "Use an internal path such as /book, or a full https:// address."})


class WebsiteCampaignSerializer(_Base):
    """The admin view of a campaign: everything, including the internal notes."""

    image_detail = serializers.SerializerMethodField()
    mobile_image_detail = serializers.SerializerMethodField()
    status = serializers.CharField(read_only=True)
    type_display = serializers.CharField(source="get_campaign_type_display", read_only=True)
    placement_display = serializers.CharField(source="get_placement_display", read_only=True)
    frequency_display = serializers.CharField(source="get_frequency_display", read_only=True)
    promo_code_label = serializers.CharField(source="promo_code.code", read_only=True, default=None)
    holiday_label = serializers.CharField(
        source="schedule_exception.name", read_only=True, default=None)
    scope_label = serializers.SerializerMethodField()

    class Meta(_Base.Meta):
        model = WebsiteCampaign
        fields = (
            "id", "name", "campaign_type", "type_display", "title", "subtitle", "description",
            "image", "image_detail", "mobile_image", "mobile_image_detail", "alt_text",
            "cta_label", "cta_url", "secondary_cta_label", "secondary_cta_url",
            "starts_at", "ends_at",
            "frequency", "frequency_display", "placement", "placement_display",
            "audience", "priority", "dismissible",
            "clubs", "facilities", "scope_label",
            "promo_code", "promo_code_label", "schedule_exception", "holiday_label",
            "internal_notes", "is_archived", "status",
            "impressions", "dismissals", "cta_clicks",
            "is_enabled", "is_published", "published_at", "display_order",
            "created_at", "updated_at",
        )
        read_only_fields = (
            "id", "status", "impressions", "dismissals", "cta_clicks",
            "is_published", "published_at", "created_at", "updated_at",
        )

    def get_image_detail(self, obj):
        return media_repr(obj.image, self.context.get("request"))

    def get_mobile_image_detail(self, obj):
        return media_repr(obj.mobile_image, self.context.get("request"))

    def get_scope_label(self, obj) -> str:
        clubs = [club.name for club in obj.clubs.all()]
        if not clubs:
            return "Whole website"
        return ", ".join(clubs)

    def validate_cta_url(self, value):
        return _safe_link(value, "cta_url")

    def validate_secondary_cta_url(self, value):
        return _safe_link(value, "secondary_cta_url")

    def validate(self, attrs):
        def eff(name):
            return attrs.get(name, getattr(self.instance, name, None))

        starts, ends = eff("starts_at"), eff("ends_at")
        if starts and ends and ends <= starts:
            raise serializers.ValidationError({"ends_at": "The end must come after the start."})
        if eff("cta_url") and not eff("cta_label"):
            raise serializers.ValidationError(
                {"cta_label": "Give the button a label, or remove its link."})
        return attrs


class PublicCampaignSerializer(serializers.Serializer):
    """What a visitor's browser is allowed to know about a campaign.

    A deliberately separate, explicit serializer rather than a subset of the
    admin one: internal notes, engagement figures, scope and draft state must
    never reach the public payload, and listing what MAY go out is far harder to
    get wrong by accident than listing what may not.
    """

    id = serializers.IntegerField()
    type = serializers.CharField(source="campaign_type")
    title = serializers.CharField()
    subtitle = serializers.CharField()
    description = serializers.CharField()
    alt_text = serializers.CharField()
    cta_label = serializers.CharField()
    cta_url = serializers.CharField()
    secondary_cta_label = serializers.CharField()
    secondary_cta_url = serializers.CharField()
    frequency = serializers.CharField()
    dismissible = serializers.BooleanField()
    priority = serializers.IntegerField()
    image = serializers.SerializerMethodField()
    mobile_image = serializers.SerializerMethodField()
    promo_code = serializers.SerializerMethodField()

    def get_image(self, obj):
        return media_repr(obj.image, self.context.get("request"))

    def get_mobile_image(self, obj):
        # No mobile artwork means the main image is used responsively, which is
        # better than cropping a landscape design into a portrait frame.
        return media_repr(obj.mobile_image, self.context.get("request"))

    def get_promo_code(self, obj) -> str:
        """The code's public name only. Its rules stay with the promo engine."""
        return obj.promo_code.code if obj.promo_code_id else ""
