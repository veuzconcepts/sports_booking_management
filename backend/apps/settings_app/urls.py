from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    BookingConfigView,
    CurrencyView,
    EffectiveScheduleView,
    LanguageViewSet,
    PublicLanguagesView,
    OrganizationView,
    PublicThemeView,
    ScheduleExceptionViewSet,
    ScheduleImpactView,
    SystemConfigViewSet,
    TaxRateViewSet,
    ThemeContrastView,
    ThemePresetViewSet,
    ThemeView,
)

router = DefaultRouter()
router.register("tax-rates", TaxRateViewSet, basename="tax-rate")
router.register("config", SystemConfigViewSet, basename="system-config")
router.register("schedule-exceptions", ScheduleExceptionViewSet,
                basename="schedule-exception")
router.register("languages", LanguageViewSet, basename="language")
router.register("theme-presets", ThemePresetViewSet, basename="theme-preset")

urlpatterns = [
    path("organization/", OrganizationView.as_view(), name="organization"),
    path("booking-config/", BookingConfigView.as_view(), name="booking-config"),
    path("currency/", CurrencyView.as_view(), name="currency"),
    path("theme/", ThemeView.as_view(), name="theme"),
    path("theme/contrast/", ThemeContrastView.as_view(), name="theme-contrast"),
    # Unauthenticated: the login and public pages need these before a user exists.
    path("languages/public/", PublicLanguagesView.as_view(), name="languages-public"),
    path("theme/public/", PublicThemeView.as_view(), name="theme-public"),
    path("schedule/effective/", EffectiveScheduleView.as_view(), name="schedule-effective"),
    path("schedule/impact/", ScheduleImpactView.as_view(), name="schedule-impact"),
    *router.urls,
]
