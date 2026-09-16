from rest_framework.routers import DefaultRouter

from .views import PromoCodeViewSet

router = DefaultRouter()
router.register("", PromoCodeViewSet, basename="promo-code")

urlpatterns = router.urls
