"""DRF permission classes.

Access is capability-driven: gates check the user's effective permission codes
(role template + per-user overrides) via `has_perm_code`, not hardcoded role
names. `ReadOnlyOrStaff` keeps the structural staff-vs-customer boundary for
read/write on catalogue-style endpoints.
"""

from rest_framework.permissions import BasePermission, SAFE_METHODS

from . import access
from .models import Role, STAFF_ROLES

_SIGN_IN = "Please sign in to continue."


class IsSuperAdmin(BasePermission):
    """Only a signed-in Super Admin (or a Django superuser). Used to gate the API
    documentation (schema / Swagger / Redoc) so the endpoint map is never public."""

    message = "Super Admin access is required."

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = _SIGN_IN
            return False
        return bool(getattr(user, "is_superuser", False) or getattr(user, "role", None) == Role.SUPER_ADMIN)


class ReadOnlyOrStaff(BasePermission):
    """Anyone authenticated can read; only staff can mutate."""

    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            self.message = _SIGN_IN
            return False
        if request.method in SAFE_METHODS:
            return True
        if request.user.role not in STAFF_ROLES:
            self.message = "Only staff members can perform this action."
            return False
        return True


# Maps a DRF CRUD action to the capability suffix it requires.
CRUD_CAP = {"create": "add", "update": "edit", "partial_update": "edit", "destroy": "delete"}


class FeatureCRUDPermission(BasePermission):
    """Reads: any authenticated user. CRUD writes: require `<feature>.<add|edit|
    delete>`. Custom @actions (no CRUD mapping) self-gate inside the viewset via
    `has_perm_code`. Subclasses set `feature`."""
    feature = None

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = _SIGN_IN
            return False
        if request.method in SAFE_METHODS:
            return True
        cap = CRUD_CAP.get(getattr(view, "action", None))
        if cap and not user.has_perm_code(f"{self.feature}.{cap}"):
            self.message = access.denial_message(self.feature, cap)
            return False
        return True


class FacilityCatalogPermission(FeatureCRUDPermission):
    """Facilities & catalogue: writes require `facilities.add/edit/delete`."""
    feature = "facilities"


class ClubPermission(FeatureCRUDPermission):
    """Clubs & venues: writes require `clubs.add/edit/delete`."""
    feature = "clubs"


class CanManageRoles(BasePermission):
    """Roles & Permissions by capability: read=`roles.view`, create=`roles.add`,
    edit=`roles.edit`, delete=`roles.delete`."""

    message = "You do not have permission for this role action."
    _CAP = {"POST": "add", "PUT": "edit", "PATCH": "edit", "DELETE": "delete"}

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = _SIGN_IN
            return False
        cap = "view" if request.method in SAFE_METHODS else self._CAP.get(request.method, "edit")
        if not user.has_perm_code(f"roles.{cap}"):
            self.message = access.denial_message("roles", cap)
            return False
        return True


class UserAccessPermission(BasePermission):
    """User management access by capability, not role name. Reads need
    `users.view`; create/delete need `users.add`/`users.delete`; updates and every
    management @action (activate, reset password, MFA, etc.) need `users.edit`.
    Object-level senior/club limits are still enforced by the viewset's guards."""

    message = "You do not have permission to manage users."

    _CAP = {
        "list": "users.view", "retrieve": "users.view",
        "create": "users.add", "destroy": "users.delete",
    }

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = _SIGN_IN
            return False
        cap = self._CAP.get(getattr(view, "action", None), "users.edit")
        if not user.has_perm_code(cap):
            self.message = access.denial_message(*cap.split(".", 1))
            return False
        return True
