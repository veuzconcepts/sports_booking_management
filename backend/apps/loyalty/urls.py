from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import LoyaltyConfigView, LoyaltyReportViewSet, LoyaltyTierViewSet

router = DefaultRouter()
router.register("tiers", LoyaltyTierViewSet, basename="loyalty-tier")
router.register("reports", LoyaltyReportViewSet, basename="loyalty-report")

urlpatterns = [
    path("config/", LoyaltyConfigView.as_view(), name="loyalty-config"),
]
urlpatterns += router.urls
