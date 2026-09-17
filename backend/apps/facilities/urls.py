from rest_framework.routers import DefaultRouter

from .views import (
    AddOnViewSet,
    FacilityCategoryViewSet,
    FacilityTypeViewSet,
    FacilityViewSet,
    MaintenanceBlockViewSet,
    PricingRuleViewSet,
)

router = DefaultRouter()
router.register("categories", FacilityCategoryViewSet, basename="facility-category")
router.register("types", FacilityTypeViewSet, basename="facility-type")
router.register("addons", AddOnViewSet, basename="addon")
router.register("pricing-rules", PricingRuleViewSet, basename="pricing-rule")
router.register("maintenance-blocks", MaintenanceBlockViewSet, basename="maintenance-block")
router.register("", FacilityViewSet, basename="facility")

urlpatterns = router.urls
