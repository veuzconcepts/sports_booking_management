from rest_framework.permissions import BasePermission, SAFE_METHODS

from apps.accounts import access
from apps.accounts.models import STAFF_ROLES
from apps.accounts.permissions import CRUD_CAP


def _staff_cap_ok(perm, user, feature, action):
    """A staff user's CRUD write is allowed only with `<feature>.<add|edit|delete>`.
    Custom @actions (no CRUD mapping) self-gate inside the viewset. Sets a
    specific denial message on `perm` when blocked."""
    cap = CRUD_CAP.get(action)
    if not cap:
        return True
    if user.has_perm_code(f"{feature}.{cap}"):
        return True
    perm.message = access.denial_message(feature, cap)
    return False


class CustomerObjectPermission(BasePermission):
    """Reads: authenticated (scoped in get_queryset). Staff writes require the
    matching `customers.*` capability. Non-staff cannot mutate via the admin API."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if request.method in SAFE_METHODS:
            return True
        if user.role in STAFF_ROLES:
            return _staff_cap_ok(self, user, "customers", getattr(view, "action", None))
        self.message = "Only staff members can manage Customers."
        return False

    def has_object_permission(self, request, view, obj):
        if request.user.role in STAFF_ROLES:
            return True
        allowed = obj.linked_user_id == request.user.id
        if not allowed:
            self.message = "You can only access your own customer profile."
        return allowed


class AddressObjectPermission(BasePermission):
    """Staff writes require `customers.*`; a customer manages only their own
    addresses (ownership enforced in has_object_permission / queryset)."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if request.method in SAFE_METHODS:
            return True
        if user.role in STAFF_ROLES:
            return _staff_cap_ok(self, user, "customers", getattr(view, "action", None))
        return True   # customer manages own addresses (object/queryset scoped)

    def has_object_permission(self, request, view, obj):
        if request.user.role in STAFF_ROLES:
            return True
        allowed = obj.customer.linked_user_id == request.user.id
        if not allowed:
            self.message = "You can only manage your own addresses."
        return allowed
