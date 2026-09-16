from rest_framework.routers import DefaultRouter

from .views import ClubViewSet

router = DefaultRouter()
router.register("", ClubViewSet, basename="club")

urlpatterns = router.urls
