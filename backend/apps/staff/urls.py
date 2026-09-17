from rest_framework.routers import DefaultRouter

from .views import (
    PerformanceSnapshotViewSet, ShiftViewSet, StaffClubTransferViewSet,
    StaffProfileViewSet,
)

router = DefaultRouter()
router.register("shifts", ShiftViewSet, basename="shift")
router.register("transfers", StaffClubTransferViewSet, basename="staff-transfer")
router.register("performance", PerformanceSnapshotViewSet, basename="performance")
router.register("", StaffProfileViewSet, basename="staff")

urlpatterns = router.urls
