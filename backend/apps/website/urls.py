from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    BannerViewSet,
    BrandLogoViewSet,
    FAQItemViewSet,
    FooterConfigViewSet,
    MediaAssetViewSet,
    ProcessStepViewSet,
    PublicAvailabilityView,
    PublicCampaignEventView,
    PublicCampaignsView,
    PublicBookingConfigView,
    PublicBookingCreateView,
    PublicBrandingView,
    PublicClubsView,
    PublicContactPrecheckView,
    PublicContactVerifyView,
    PublicQuoteView,
    PublicCatalogueView,
    PublicHomeView,
    SEOSettingViewSet,
    SiteSectionViewSet,
    StatItemViewSet,
    TestimonialViewSet,
    WebsiteCampaignViewSet,
    WhyChooseUsPointViewSet,
)

router = DefaultRouter()
router.register("media", MediaAssetViewSet, basename="website-media")
router.register("sections", SiteSectionViewSet, basename="website-section")
router.register("banners", BannerViewSet, basename="website-banner")
router.register("process-steps", ProcessStepViewSet, basename="website-process-step")
router.register("why-choose-us", WhyChooseUsPointViewSet, basename="website-why")
router.register("stats", StatItemViewSet, basename="website-stat")
router.register("testimonials", TestimonialViewSet, basename="website-testimonial")
router.register("brands", BrandLogoViewSet, basename="website-brand")
router.register("faqs", FAQItemViewSet, basename="website-faq")
router.register("seo", SEOSettingViewSet, basename="website-seo")
router.register("campaigns", WebsiteCampaignViewSet, basename="website-campaign")

urlpatterns = [
    # Public, unauthenticated marketing-website reads.
    path("public/home/", PublicHomeView.as_view(), name="website-public-home"),
    path("public/catalogue/", PublicCatalogueView.as_view(), name="website-public-catalogue"),
    path("public/clubs/", PublicClubsView.as_view(), name="website-public-clubs"),
    path("public/availability/", PublicAvailabilityView.as_view(), name="website-public-availability"),
    path("public/bookings/", PublicBookingCreateView.as_view(), name="website-public-booking-create"),
    path("public/branding/", PublicBrandingView.as_view(), name="website-public-branding"),
    path("public/booking-config/", PublicBookingConfigView.as_view(), name="website-public-booking-config"),
    path("public/contact-precheck/", PublicContactPrecheckView.as_view(), name="website-public-contact-precheck"),
    path("public/contact-verify/", PublicContactVerifyView.as_view(), name="website-public-contact-verify"),
    path("public/quote/", PublicQuoteView.as_view(), name="website-public-quote"),
    path("public/campaigns/", PublicCampaignsView.as_view(), name="website-public-campaigns"),
    path("public/campaign-event/", PublicCampaignEventView.as_view(),
         name="website-public-campaign-event"),
    # Singleton footer config (no list/create — one row).
    path("footer/", FooterConfigViewSet.as_view({"get": "list", "put": "update", "patch": "update"}),
         name="website-footer"),
]
urlpatterns += router.urls
