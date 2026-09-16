from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    BookingConfigView,
    CurrencyView,
    EffectiveScheduleView,
    OrganizationView,
    ScheduleExceptionViewSet,
    ScheduleImpactView,
    SystemConfigViewSet,
    TaxRateViewSet,
)

router = DefaultRouter()
router.register("tax-rates", TaxRateViewSet, basename="tax-rate")
router.register("config", SystemConfigViewSet, basename="system-config")
router.register("schedule-exceptions", ScheduleExceptionViewSet,
                basename="schedule-exception")

urlpatterns = [
    path("organization/", OrganizationView.as_view(), name="organization"),
    path("booking-config/", BookingConfigView.as_view(), name="booking-config"),
    path("currency/", CurrencyView.as_view(), name="currency"),
    path("schedule/effective/", EffectiveScheduleView.as_view(), name="schedule-effective"),
    path("schedule/impact/", ScheduleImpactView.as_view(), name="schedule-impact"),
    *router.urls,
]
