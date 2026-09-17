from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.accounts import access
from apps.accounts.models import Role, STAFF_ROLES


class _FinanceReadPermission(BasePermission):
    """Capability-driven for staff; customers read only their own records.

    Every staff read (list / retrieve / download) requires `read_perm`; write
    actions self-gate via `has_perm_code` in the viewset.
    """
    read_perm = "payments.view"

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if user.role == Role.CUSTOMER:
            return True   # row-level (own records) via get_queryset / object perm
        if request.method in SAFE_METHODS:
            if not user.has_perm_code(self.read_perm):
                self.message = access.denial_message(*self.read_perm.split(".", 1))
                return False
            return True
        return True

    def has_object_permission(self, request, view, obj):
        user = request.user
        if user.role in STAFF_ROLES:
            return True
        # Customer: read-only access to their own records.
        if request.method not in SAFE_METHODS:
            self.message = "You do not have permission to change this record."
            return False
        customer = getattr(obj, "customer", None)
        allowed = bool(customer and customer.linked_user_id == user.id)
        if not allowed:
            self.message = "You can only view your own financial records."
        return allowed


class PaymentPermission(_FinanceReadPermission):
    """Payments / wallets — reads require `payments.view`."""
    read_perm = "payments.view"


class SubscriptionReadPermission(_FinanceReadPermission):
    """Customer memberships — staff reads require `subscriptions.view`; a customer
    sees only their own records (row-level via get_queryset)."""
    read_perm = "subscriptions.view"


class InvoicePermission(_FinanceReadPermission):
    """Invoices / receipts / credit notes — reads require `invoicing.view`."""
    read_perm = "invoicing.view"


class MembershipPlanPermission(BasePermission):
    """Membership plans (the Subscriptions catalogue). Any authenticated user may
    READ — the plan list also feeds the pricing-rule picker and the customer app —
    but writes require the matching Subscriptions capability (add / edit / delete)."""

    _WRITE_CAP = {"POST": "add", "PUT": "edit", "PATCH": "edit", "DELETE": "delete"}

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if request.method in SAFE_METHODS:
            return True
        cap = self._WRITE_CAP.get(request.method)
        if cap and not user.has_perm_code(f"subscriptions.{cap}"):
            self.message = access.denial_message("subscriptions", cap)
            return False
        return True
