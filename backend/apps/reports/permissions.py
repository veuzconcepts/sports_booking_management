from rest_framework.permissions import BasePermission

from apps.accounts import access


class CanViewReports(BasePermission):
    """Requires the `reports.view` capability (role default or granted override)."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if not user.has_perm_code("reports.view"):
            self.message = access.denial_message("reports", "view")
            return False
        return True
