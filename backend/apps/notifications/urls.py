from rest_framework.routers import DefaultRouter

from .views import NotificationTemplateViewSet, NotificationViewSet

router = DefaultRouter()
router.register("templates", NotificationTemplateViewSet, basename="notification-template")
router.register("", NotificationViewSet, basename="notification")

urlpatterns = router.urls
