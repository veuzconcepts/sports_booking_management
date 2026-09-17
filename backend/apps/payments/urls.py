from rest_framework.routers import DefaultRouter

from .views import (
    CreditNoteViewSet,
    InvoiceViewSet,
    MembershipPlanViewSet,
    MembershipViewSet,
    PaymentViewSet,
    ReceiptViewSet,
    WalletViewSet,
)

router = DefaultRouter()
router.register("wallets", WalletViewSet, basename="wallet")
router.register("membership-plans", MembershipPlanViewSet, basename="membership-plan")
router.register("memberships", MembershipViewSet, basename="membership")
router.register("invoices", InvoiceViewSet, basename="invoice")
router.register("receipts", ReceiptViewSet, basename="receipt")
router.register("credit-notes", CreditNoteViewSet, basename="credit-note")
router.register("", PaymentViewSet, basename="payment")

urlpatterns = router.urls
