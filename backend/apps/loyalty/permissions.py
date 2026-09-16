from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.accounts import access


def _gate(request, cap):
    user = request.user
    if not (user and user.is_authenticated):
        return False, "Please sign in to continue."
    if not user.has_perm_code(cap):
        return False, access.denial_message(*cap.split(".", 1))
    return True, ""


class LoyaltyConfigPermission(BasePermission):
    """`loyalty.view` to read the config; `loyalty.manage_rules` to change it."""

    def has_permission(self, request, view):
        cap = "loyalty.view" if request.method in SAFE_METHODS else "loyalty.manage_rules"
        ok, msg = _gate(request, cap)
        if not ok:
            self.message = msg
        return ok


class LoyaltyTierPermission(BasePermission):
    """`loyalty.view` to read tiers; `loyalty.manage_tiers` to change them."""

    def has_permission(self, request, view):
        cap = "loyalty.view" if request.method in SAFE_METHODS else "loyalty.manage_tiers"
        ok, msg = _gate(request, cap)
        if not ok:
            self.message = msg
        return ok


class LoyaltyLedgerPermission(BasePermission):
    """`loyalty.view_ledger` for reads/reports."""

    def has_permission(self, request, view):
        ok, msg = _gate(request, "loyalty.view_ledger")
        if not ok:
            self.message = msg
        return ok
