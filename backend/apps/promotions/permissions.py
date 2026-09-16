from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.accounts import access

_WRITE_CAP = {"POST": "promotions.add", "PUT": "promotions.edit",
              "PATCH": "promotions.edit", "DELETE": "promotions.delete"}


class PromoPermission(BasePermission):
    """`promotions.view` to read; add/edit/delete capability to write."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        cap = "promotions.view" if request.method in SAFE_METHODS \
            else _WRITE_CAP.get(request.method, "promotions.edit")
        if not user.has_perm_code(cap):
            self.message = access.denial_message(*cap.split(".", 1))
            return False
        return True
