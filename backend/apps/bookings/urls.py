from rest_framework.routers import DefaultRouter

from .views import (
    BookingHoldViewSet, BookingOrderViewSet, BookingPolicyViewSet, BookingViewSet,
)

router = DefaultRouter()
router.register("policies", BookingPolicyViewSet, basename="booking-policy")
# Before the catch-all "" registration, which would otherwise swallow them.
router.register("reservations", BookingHoldViewSet, basename="booking-hold")
router.register("orders", BookingOrderViewSet, basename="booking-order")
router.register("", BookingViewSet, basename="booking")

urlpatterns = router.urls
