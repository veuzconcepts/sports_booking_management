from rest_framework.routers import DefaultRouter

from .views import BookingHoldViewSet, BookingPolicyViewSet, BookingViewSet

router = DefaultRouter()
router.register("policies", BookingPolicyViewSet, basename="booking-policy")
# Before the catch-all "" registration, which would otherwise swallow it.
router.register("reservations", BookingHoldViewSet, basename="booking-hold")
router.register("", BookingViewSet, basename="booking")

urlpatterns = router.urls
