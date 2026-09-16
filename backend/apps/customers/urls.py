from rest_framework.routers import DefaultRouter

from .views import AddressViewSet, CustomerViewSet, LoyaltyLedgerViewSet

router = DefaultRouter()
router.register("addresses", AddressViewSet, basename="address")
router.register("loyalty", LoyaltyLedgerViewSet, basename="loyalty")
router.register("", CustomerViewSet, basename="customer")

urlpatterns = router.urls
