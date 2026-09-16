from rest_framework.permissions import BasePermission

from apps.accounts import access


class IsAdminViewer(BasePermission):
    """Requires the `audit.view` capability (admins by default)."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if not user.has_perm_code("audit.view"):
            self.message = access.denial_message("audit", "view")
            return False
        return True
