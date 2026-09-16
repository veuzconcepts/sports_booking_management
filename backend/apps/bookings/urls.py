from rest_framework.routers import DefaultRouter

from .views import BookingPolicyViewSet, BookingViewSet

router = DefaultRouter()
router.register("policies", BookingPolicyViewSet, basename="booking-policy")
router.register("", BookingViewSet, basename="booking")

urlpatterns = router.urls
