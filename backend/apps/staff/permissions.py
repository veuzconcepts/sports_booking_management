from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.accounts import access
from apps.accounts.models import Role

# Write action -> required `staff.<cap>`.
_CRUD_CAP = {"create": "add", "update": "edit", "partial_update": "edit", "destroy": "delete"}


class StaffManagePermission(BasePermission):
    """Capability-driven staff & shift management.

    Reads are open to any internal user (facility staff / operators are scoped to their
    own profile in the viewset's `get_queryset`); writes require the matching
    `staff.add` / `staff.edit` / `staff.delete` capability. Customers have no
    access.
    """

    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            self.message = "Please sign in to continue."
            return False
        if user.role == Role.CUSTOMER:
            self.message = "You do not have permission to access Staff & Shifts."
            return False
        if request.method in SAFE_METHODS:
            return True
        cap = _CRUD_CAP.get(getattr(view, "action", None), "edit")
        if not user.has_perm_code(f"staff.{cap}"):
            self.message = access.denial_message("staff", cap)
            return False
        return True

    def has_object_permission(self, request, view, obj):
        if request.method in SAFE_METHODS:
            return True
        cap = _CRUD_CAP.get(getattr(view, "action", None), "edit")
        if not request.user.has_perm_code(f"staff.{cap}"):
            self.message = access.denial_message("staff", cap)
            return False
        return True
