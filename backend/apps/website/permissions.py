"""Website CMS permission gate.

Capability-driven, mirroring the rest of the app:
  read (list/retrieve)            -> website.view
  create/update/delete           -> website.edit
  publish action (set_published) -> website.publish
  media library writes           -> website.media

A viewset may override the per-action capability via `cap_overrides`
(e.g. the Media Library viewset maps create/update/delete to `media`).
"""

from rest_framework.permissions import BasePermission

from apps.accounts import access

_SIGN_IN = "Please sign in to continue."

_ACTION_CAP = {
    "list": "view",
    "retrieve": "view",
    "create": "edit",
    "update": "edit",
    "partial_update": "edit",
    "destroy": "edit",
    "set_published": "publish",
}


class WebsiteCMSPermission(BasePermission):
    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = _SIGN_IN
            return False
        action = getattr(view, "action", None)
        overrides = getattr(view, "cap_overrides", {})
        cap = overrides.get(action) or _ACTION_CAP.get(action, "edit")
        if not user.has_perm_code(f"website.{cap}"):
            self.message = access.denial_message("website", cap)
            return False
        return True
