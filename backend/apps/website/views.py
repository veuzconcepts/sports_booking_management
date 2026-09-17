"""Website CMS endpoints.

Two surfaces:
  * Authenticated CMS viewsets (router) — gated by `website.*`, audited.
  * One PUBLIC, unauthenticated, read-only endpoint that returns the published +
    enabled homepage payload for the marketing website to render.
"""

from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auditlogs.services import log_event

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
from . import campaigns as campaign_rules
from .permissions import WebsiteCMSPermission
from .serializers import (
    BannerSerializer,
    BrandLogoSerializer,
    FAQItemSerializer,
    FooterConfigSerializer,
    MediaAssetSerializer,
    ProcessStepSerializer,
    SEOSettingSerializer,
    SiteSectionSerializer,
    StatItemSerializer,
    PublicCampaignSerializer,
    TestimonialSerializer,
    WebsiteCampaignSerializer,
    WhyChooseUsPointSerializer,
)

# Obvious fake / disposable email domains rejected on public booking.
_JUNK_EMAIL_DOMAINS = frozenset({
    "test.com", "test.test", "example.com", "example.org", "example.net", "domain.com",
    "mailinator.com", "tempmail.com", "temp-mail.org", "10minutemail.com", "guerrillamail.com",
    "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com",
    "maildrop.cc", "fakeinbox.com", "throwawaymail.com", "mailnesia.com", "tempmail.net", "mintemail.com",
})


def _email_looks_real(email: str) -> bool:
    """Reject malformed and obvious throwaway/test emails (format + blocklist)."""
    from django.core.exceptions import ValidationError as DjValidationError
    from django.core.validators import validate_email

    value = (email or "").strip().lower()
    if not value:
        return True                                     # optional
    try:
        validate_email(value)
    except DjValidationError:
        return False
    domain = value.rsplit("@", 1)[-1]
    if domain in _JUNK_EMAIL_DOMAINS:
        return False
    return not domain.startswith(("test.", "example.", "sample.", "demo."))


# --------------------------------------------------------------------------- #
# CMS (authenticated, permission-gated, audited)
# --------------------------------------------------------------------------- #
class CMSViewSet(viewsets.ModelViewSet):
    """Base CMS viewset: website.* gate + audit on every write."""

    permission_classes = [WebsiteCMSPermission]
    audit_label = "content"

    def perform_create(self, serializer):
        obj = serializer.save()
        log_event(self.request, "website_content_created",
                  {"type": self.audit_label, "id": obj.id})

    def perform_update(self, serializer):
        obj = serializer.save()
        log_event(self.request, "website_content_updated",
                  {"type": self.audit_label, "id": obj.id})

    def perform_destroy(self, instance):
        obj_id = instance.id
        instance.delete()
        log_event(self.request, "website_content_deleted",
                  {"type": self.audit_label, "id": obj_id})


class PublishMixin:
    """Adds a `set_published` action (gated by `website.publish`) that toggles a
    content row between draft and live, separate from ordinary editing."""

    @action(detail=True, methods=["post"], url_path="set-published")
    def set_published(self, request, pk=None):
        obj = self.get_object()
        published = request.data.get("is_published", True)
        published = published if isinstance(published, bool) else str(published).lower() in ("1", "true", "yes")
        obj.is_published = published
        obj.published_at = timezone.now() if published else None
        obj.save(update_fields=["is_published", "published_at", "updated_at"])
        log_event(request, "website_content_published" if published else "website_content_unpublished",
                  {"type": self.audit_label, "id": obj.id})
        return Response(self.get_serializer(obj).data)


class MediaAssetViewSet(CMSViewSet):
    """Media Library — uploads are gated by `website.media`."""

    queryset = MediaAsset.objects.all()
    serializer_class = MediaAssetSerializer
    audit_label = "media"
    filterset_fields = ["kind"]
    search_fields = ["title", "alt_text"]
    # Library writes require website.media (not the generic edit cap).
    cap_overrides = {"create": "media", "update": "media", "partial_update": "media", "destroy": "media"}


class SiteSectionViewSet(PublishMixin, CMSViewSet):
    queryset = SiteSection.objects.select_related("image", "background_image").all()
    serializer_class = SiteSectionSerializer
    audit_label = "section"
    filterset_fields = ["key", "is_enabled", "is_published"]


class BannerViewSet(PublishMixin, CMSViewSet):
    queryset = Banner.objects.select_related("image").all()
    serializer_class = BannerSerializer
    audit_label = "banner"
    filterset_fields = ["is_enabled", "is_published"]


class ProcessStepViewSet(PublishMixin, CMSViewSet):
    queryset = ProcessStep.objects.select_related("icon").all()
    serializer_class = ProcessStepSerializer
    audit_label = "process_step"
    filterset_fields = ["is_enabled", "is_published"]


class WhyChooseUsPointViewSet(PublishMixin, CMSViewSet):
    queryset = WhyChooseUsPoint.objects.select_related("icon").all()
    serializer_class = WhyChooseUsPointSerializer
    audit_label = "why_choose_us"
    filterset_fields = ["is_enabled", "is_published"]


class StatItemViewSet(PublishMixin, CMSViewSet):
    queryset = StatItem.objects.all()
    serializer_class = StatItemSerializer
    audit_label = "stat"
    filterset_fields = ["is_enabled", "is_published"]


class TestimonialViewSet(PublishMixin, CMSViewSet):
    queryset = Testimonial.objects.select_related("author_photo").all()
    serializer_class = TestimonialSerializer
    audit_label = "testimonial"
    filterset_fields = ["is_enabled", "is_published"]


class BrandLogoViewSet(PublishMixin, CMSViewSet):
    queryset = BrandLogo.objects.select_related("logo").all()
    serializer_class = BrandLogoSerializer
    audit_label = "brand_logo"
    filterset_fields = ["is_enabled", "is_published"]


class FAQItemViewSet(PublishMixin, CMSViewSet):
    queryset = FAQItem.objects.all()
    serializer_class = FAQItemSerializer
    audit_label = "faq"
    filterset_fields = ["is_enabled", "is_published"]


class FooterConfigViewSet(viewsets.ViewSet):
    """Singleton footer config — GET/PUT against the one row (no list/create)."""

    permission_classes = [WebsiteCMSPermission]

    def list(self, request):
        cfg = FooterConfig.get_solo()
        return Response(FooterConfigSerializer(cfg, context={"request": request}).data)

    def update(self, request, pk=None):
        cfg = FooterConfig.get_solo()
        ser = FooterConfigSerializer(cfg, data=request.data, partial=True, context={"request": request})
        ser.is_valid(raise_exception=True)
        ser.save()
        log_event(request, "website_content_updated", {"type": "footer", "id": cfg.id})
        return Response(ser.data)


class SEOSettingViewSet(CMSViewSet):
    queryset = SEOSetting.objects.select_related("og_image").all()
    serializer_class = SEOSettingSerializer
    audit_label = "seo"
    filterset_fields = ["path"]


# --------------------------------------------------------------------------- #
# Public read endpoint (unauthenticated, only published + enabled content)
# --------------------------------------------------------------------------- #
def _live(qs):
    return qs.filter(is_enabled=True, is_published=True)


def branding_payload(request):
    """Org branding for the public website: absolute URLs for each logo variant +
    favicon + default OG image, plus the SEO fallback title/description. Absolute
    so the separate-origin marketing website can load them."""
    from apps.settings_app import theme as theme_cfg
    from apps.settings_app.models import Organization
    org = Organization.get_solo()
    theme = theme_cfg.resolve(org.theme)

    def url(field):
        try:
            return request.build_absolute_uri(field.url) if field else None
        except ValueError:
            return None

    return {
        "logo_light": url(org.logo_light),
        "logo_dark": url(org.logo_dark),
        "logo_light_vertical": url(org.logo_light_vertical),
        "logo_dark_vertical": url(org.logo_dark_vertical),
        "favicon": url(org.favicon),
        "og_image": url(org.og_image),
        "meta_title": org.meta_title,
        "meta_description": org.meta_description,
        "name": org.name,
        # Brand colours only. The website's own surfaces are tuned for its
        # light and dark modes and are not driven from the admin theme.
        "brand": {
            "primary": theme["primary"],
            "secondary": theme["secondary"],
            "accent": theme["accent"],
        },
    }


class PublicBrandingView(APIView):
    """Public org branding (logos / favicon / OG / SEO defaults) for the website
    header, footer and <head>."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        return Response(branding_payload(request))


class PublicHomeView(APIView):
    """The full published homepage payload for the marketing website.

    Unauthenticated and read-only: returns only enabled + published content, plus
    contact/social details sourced from the Organization profile (single source of
    truth — never duplicated in the CMS).
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        ctx = {"request": request}

        sections = {
            s.key: SiteSectionSerializer(s, context=ctx).data
            for s in _live(SiteSection.objects.select_related("image", "background_image"))
        }

        def many(serializer, qs):
            return serializer(_live(qs), many=True, context=ctx).data

        payload = {
            "sections": sections,
            "banners": many(BannerSerializer, Banner.objects.select_related("image")),
            "process_steps": many(ProcessStepSerializer, ProcessStep.objects.select_related("icon")),
            # Services & Subscriptions are NOT re-authored here — they live under
            # Operations. The public website reads them from those modules directly.
            "why_choose_us": many(WhyChooseUsPointSerializer, WhyChooseUsPoint.objects.select_related("icon")),
            "stats": many(StatItemSerializer, StatItem.objects.all()),
            "testimonials": many(TestimonialSerializer, Testimonial.objects.select_related("author_photo")),
            "brands": many(BrandLogoSerializer, BrandLogo.objects.select_related("logo")),
            "faqs": many(FAQItemSerializer, FAQItem.objects.all()),
            "footer": FooterConfigSerializer(FooterConfig.get_solo(), context=ctx).data,
            "organization": self._organization_info(),
            "seo": self._seo("/"),
            "branding": branding_payload(request),
        }
        return Response(payload)

    def _organization_info(self):
        """Contact + social details from the Organization profile (not duplicated in CMS)."""
        from apps.settings_app.models import Organization
        org = Organization.get_solo()
        return {
            "name": org.name,
            "email": org.email,
            "phone": org.phone,
            "address": org.address,
            "city": org.city,
            "country": org.country,
            "social": {
                "facebook": org.facebook, "instagram": org.instagram, "twitter": org.twitter,
                "linkedin": org.linkedin, "youtube": org.youtube, "tiktok": org.tiktok,
                "whatsapp": org.whatsapp,
            },
        }

    def _seo(self, path):
        seo = SEOSetting.objects.select_related("og_image").filter(path=path).first()
        return SEOSettingSerializer(seo, context={"request": self.request}).data if seo else None


class PublicCatalogueView(APIView):
    """Public, read-only catalogue sourced LIVE from the Operations modules -
    facility categories, bookable facility types, and membership plans. The
    website never re-authors this; it honours the operational flags
    (`is_active`, `online_booking_enabled`)."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        from apps.payments.models import MembershipPlan
        from apps.facilities.models import FacilityCategory, FacilityType
        from apps.settings_app.currency import get_default_currency
        from .serializers import (
            PublicCategorySerializer, PublicPlanSerializer, PublicFacilityTypeSerializer,
        )

        currency = get_default_currency()
        ctx = {"request": request, "currency": currency}

        categories = FacilityCategory.objects.filter(is_active=True).order_by("display_order", "name")
        facility_types = (FacilityType.objects
                          .filter(is_active=True, online_booking_enabled=True)
                          .prefetch_related("categories", "add_ons").order_by("name"))
        plans = (MembershipPlan.objects.filter(is_active=True)
                 .prefetch_related("entitlements__facility_type", "entitlements__facility_category",
                                   "entitlements__addon").order_by("price"))

        return Response({
            "currency": currency,
            "categories": PublicCategorySerializer(categories, many=True, context=ctx).data,
            "facility_types": PublicFacilityTypeSerializer(facility_types, many=True, context=ctx).data,
            "plans": PublicPlanSerializer(plans, many=True, context=ctx).data,
        })


class PublicClubsView(APIView):
    """Public, read-only list of active clubs/locations for the booking
    location step (searchable + map pins)."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        from apps.clubs.models import Club
        from .serializers import PublicClubSerializer

        clubs = Club.objects.filter(is_active=True).order_by("name")
        return Response({
            "clubs": PublicClubSerializer(clubs, many=True, context={"request": request}).data,
        })


class PublicAvailabilityView(APIView):
    """Public, read-only booking availability for one club + date.

    `?club=<id>&date=YYYY-MM-DD&facility_type=<id>` -> the day's bookable slots
    plus the per-weekday open/closed map for the date strip. Reuses the same slot
    engine as the admin, so the customer never sees a time the club cannot serve.
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        from datetime import date as date_cls

        from apps.bookings import services as booking_services
        from apps.clubs.models import Club

        raw_date = request.query_params.get("date")
        try:
            on_date = date_cls.fromisoformat(raw_date) if raw_date else date_cls.today()
        except (ValueError, TypeError):
            return Response({"detail": "Invalid date (expected YYYY-MM-DD)"},
                            status=status.HTTP_400_BAD_REQUEST)

        club = None
        club_id = request.query_params.get("club")
        if club_id:
            club = Club.objects.filter(pk=club_id, is_active=True).first()
            if club is None:
                return Response({"detail": "Club not found"}, status=status.HTTP_404_NOT_FOUND)

        facility_type = None
        ft_id = request.query_params.get("facility_type")
        if ft_id:
            from apps.facilities.models import FacilityType
            facility_type = FacilityType.objects.filter(
                pk=ft_id, is_active=True, online_booking_enabled=True).first()
            if facility_type is None:
                return Response({"detail": "Facility type not found"},
                                status=status.HTTP_404_NOT_FOUND)

        payload = booking_services.public_availability(
            on_date, club=club, facility_type=facility_type)
        # The bookable window (lead time + horizon) travels with availability so
        # the wizard's date strip can grey out what the server would refuse.
        payload["window"] = booking_services.booking_window(club)
        return Response(payload)


class PublicBookingConfigView(APIView):
    """Public read of the WEBSITE booking contact rules (email/phone required +
    unique) so the wizard can mark required fields and run the duplicate flow."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        from apps.bookings import contacts
        return Response(contacts.rules_for("website"))


class PublicContactVerifyView(APIView):
    """Verify the (dummy) OTP for an email/phone that already exists and return the
    existing record's details so the website can prepopulate the booking form."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_scope = "public_booking"

    def post(self, request):
        from apps.bookings import contacts
        d = request.data
        email = str(d.get("email") or "").strip()
        phone = str(d.get("phone") or "").strip()
        otp = str(d.get("otp") or "").strip()
        if not contacts.otp_is_valid(otp):
            return Response({"ok": False, "detail": "Incorrect code. Please try again."},
                            status=status.HTTP_400_BAD_REQUEST)
        rules = contacts.rules_for("website")
        source, obj, field = contacts.find_match(
            email=email, phone=phone,
            check_email=bool(rules.get("email_unique")),
            check_phone=bool(rules.get("phone_unique")),
        )
        if not obj:
            return Response({"ok": False, "detail": "No existing record found for these details."},
                            status=status.HTTP_404_NOT_FOUND)
        prefill = contacts.match_prefill(source, obj)
        # Verify by a SINGLE field (email has priority over phone). Bind the token to
        # that field's canonical value so the booking can trust it without a raw OTP.
        value = prefill.get("email") if field == "email" else prefill.get("phone")
        token = contacts.issue_verification_token(
            customer_id=prefill.get("customer_id"), field=field, value=value)
        return Response({"ok": True, "token": token, "field": field, "prefill": prefill})


class PublicContactPrecheckView(APIView):
    """Tell the wizard whether OTP verification is needed for the entered unique
    contact, so it can start verification on 'Book' BEFORE the rest of the form is
    filled. Returns {requires_otp, field, masked} only — never any PII."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_scope = "public_booking"

    def post(self, request):
        from apps.bookings import contacts
        d = request.data
        email = str(d.get("email") or "").strip()
        phone = str(d.get("phone") or "").strip()
        rules = contacts.rules_for("website")
        conflict = contacts.find_conflict(rules, email=email, phone=phone)
        if not conflict:
            return Response({"requires_otp": False})
        return Response({"requires_otp": True, "field": conflict["field"], "masked": conflict["masked"]})


class PublicBookingCreateView(APIView):
    """Create a real Operations Booking from the public website.

    The customer record is get-or-created, then the booking is built through the
    SAME `BookingCreateSerializer` the admin uses - so pricing, duration,
    reference and status all compute identically and the row lands in the
    existing `bookings.Booking` table (no separate storage)."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_scope = "public_booking"          # rate-limit mass booking per IP

    def post(self, request):
        # Delegates to the shared self-service booking helper. Website bookings
        # are tagged source="website".
        from apps.bookings.public_booking import create_public_booking
        code, payload = create_public_booking(
            request.data, request=request, source="website", customer_source="web",
            update_via="website_booking", update_by_label="Customer (website)")
        return Response(payload, status=code)


class PublicQuoteView(APIView):
    """Live price breakdown (subtotal, VAT, discounts, coupon) for the public
    Confirm & Pay step — reuses the same engine as the admin price preview, so
    the website never guesses a number. No booking is saved."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        from apps.bookings.models import Booking
        from apps.promotions import services as promo_services
        from apps.facilities.models import AddOn, FacilityType
        from apps.settings_app.currency import get_default_currency

        d = request.data
        item = FacilityType.objects.filter(
            pk=d.get("facility_type"), is_active=True, online_booking_enabled=True).first()
        if not item:
            return Response({"detail": "Select a facility to price"}, status=status.HTTP_400_BAD_REQUEST)

        # Only add-ons that actually belong to the facility type (and are active) count.
        valid_addon_ids = set(item.add_ons.filter(is_active=True).values_list("id", flat=True))
        addon_ids = [int(x) for x in (d.get("add_ons") or []) if str(x).isdigit() and int(x) in valid_addon_ids]
        addon_objs = list(AddOn.objects.filter(id__in=addon_ids))

        booking = Booking(
            currency=get_default_currency(), facility_type_id=item.id,
            booking_type="walk_in",
            club_id=(d.get("club") or None),
        )
        booking.compute_pricing(addons=addon_objs)

        coupon = {"code": "", "applied": False, "message": "", "discount": "0"}
        code = str(d.get("coupon") or d.get("promo") or "").strip()
        if code:
            subtotal = booking.total_amount - booking.tax_amount
            try:
                promo = promo_services.get_active_promo(code)
                category_ids = list(item.categories.values_list("id", flat=True))
                promo_services.validate_for_booking(
                    promo, subtotal=subtotal, facility_type_id=item.id,
                    category_ids=category_ids, addon_ids=addon_ids)
                booking.promo_code = promo
                booking.compute_pricing(addons=addon_objs)
                coupon = {"code": promo.code, "applied": True,
                          "message": "Coupon applied", "discount": str(booking.promo_discount)}
            except promo_services.PromoError as exc:
                coupon = {"code": code, "applied": False, "message": str(exc), "discount": "0"}

        from apps.bookings.services import booking_checkout_summary
        tax_rate = Booking._resolve_tax_rate()
        return Response({
            "currency": booking.currency,
            "base_amount": str(booking.base_amount),
            "addons_amount": str(booking.addons_amount),
            "subtotal": str(booking.base_amount + booking.addons_amount),
            "discount_amount": str(booking.discount_amount),
            "surcharge_amount": str(booking.surcharge_amount),
            "promo_discount": str(booking.promo_discount),
            "applied_rules": booking.applied_rules,   # [{name, adjustment, amount, …}]
            "tax_percent": float(tax_rate * 100),
            "tax_amount": str(booking.tax_amount),
            "tax_inclusive": bool(getattr(item, "tax_inclusive", False)),
            "total_amount": str(booking.total_amount),
            # Enterprise B2C order summary (VAT-inclusive lines that always reconcile).
            "summary": booking_checkout_summary(booking, addons=addon_objs, tax_rate=tax_rate),
            "coupon": coupon,
        })


# --------------------------------------------------------------------------- #
# Website campaigns
# --------------------------------------------------------------------------- #
class WebsiteCampaignViewSet(PublishMixin, CMSViewSet):
    """Promotional campaigns shown on the customer website.

    Ordinary CMS content as far as permissions and publishing go, with one
    addition: every write drops the public eligibility cache, so a campaign
    switched off stops appearing at once rather than lingering for the life of a
    cache entry.
    """

    queryset = WebsiteCampaign.objects.select_related(
        "image", "mobile_image", "promo_code", "schedule_exception",
    ).prefetch_related("clubs", "facilities")
    serializer_class = WebsiteCampaignSerializer
    audit_label = "campaign"
    filterset_fields = ["campaign_type", "placement", "is_enabled", "is_published",
                        "is_archived", "priority", "audience", "frequency"]
    search_fields = ["name", "title", "subtitle", "internal_notes"]
    ordering_fields = ["starts_at", "ends_at", "priority", "name", "created_at"]

    def get_queryset(self):
        """Archived campaigns are kept but hidden, unless asked for by name.

        They hold the engagement figures for campaigns that have run, so
        deleting them would quietly destroy the only record of what worked.
        """
        qs = super().get_queryset()
        wanted = self.request.query_params.get("is_archived")
        if wanted is None:
            qs = qs.filter(is_archived=False)
        return qs

    # The list is small and the admin wants to see the whole schedule at once.
    @extend_schema(responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["get"], url_path="live")
    def live(self, request):
        """What is on the website right now, for the dashboard."""
        rows = campaign_rules.eligible(
            placement=WebsiteCampaign.Placement.ALL, signed_in=False)
        return Response({
            "count": len(rows),
            "campaigns": self.get_serializer(rows, many=True).data,
        })

    def perform_create(self, serializer):
        super().perform_create(serializer)
        campaign_rules.invalidate()

    def perform_update(self, serializer):
        super().perform_update(serializer)
        campaign_rules.invalidate()

    def perform_destroy(self, instance):
        super().perform_destroy(instance)
        campaign_rules.invalidate()

    @action(detail=True, methods=["post"], url_path="set-published")
    def set_published(self, request, pk=None):
        response = super().set_published(request, pk=pk)
        campaign_rules.invalidate()
        return response


class PublicCampaignsView(APIView):
    """`?placement=home&club=<id>` -> the campaigns this visitor may be shown.

    Read-only and unauthenticated. Eligibility (published, enabled, inside its
    window in the organization's timezone, placement, scope, audience) is
    settled here; the browser only decides how often to show what it is given,
    because that depends on what this person has already dismissed.

    Internal notes, draft rows, engagement figures and scope never appear in the
    response: `PublicCampaignSerializer` lists what may go out rather than
    trying to strip what may not.
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        placement = request.query_params.get("placement") or WebsiteCampaign.Placement.HOME
        if placement not in WebsiteCampaign.Placement.values:
            placement = WebsiteCampaign.Placement.HOME

        club_id = request.query_params.get("club")
        # `signed_in` is a hint from the site about the visitor, never a
        # permission: the worst a wrong value can do is offer a greeting meant
        # for guests, and nothing private is gated on it.
        signed_in = str(request.query_params.get("signed_in", "")).lower() in ("1", "true", "yes")

        rows = campaign_rules.eligible(
            placement=placement, club_id=club_id, signed_in=signed_in)
        return Response({
            "campaigns": PublicCampaignSerializer(
                rows, many=True, context={"request": request}).data,
        })


class PublicCampaignEventView(APIView):
    """`POST {id, event}` -> counts an impression, dismissal or CTA click.

    Deliberately tiny and deliberately anonymous: it increments a counter on the
    campaign and stores nothing about the visitor. The site sends it without
    waiting for the reply, so a slow or failed call never delays a popup.
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_scope = "public_booking"

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def post(self, request):
        try:
            campaign_id = int(request.data.get("id"))
        except (TypeError, ValueError):
            return Response({"ok": False}, status=status.HTTP_400_BAD_REQUEST)
        event = str(request.data.get("event") or "")
        return Response({"ok": campaign_rules.record(campaign_id, event)})
