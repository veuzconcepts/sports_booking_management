from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.accounts import access
from apps.accounts.models import STAFF_ROLES


class OrganizationPermission(BasePermission):
    """`organization.view` to read, `organization.manage` to change."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        cap = "organization.view" if request.method in SAFE_METHODS else "organization.manage"
        if not user.has_perm_code(cap):
            self.message = access.denial_message(*cap.split(".", 1))
            return False
        return True


class SettingsPermission(BasePermission):
    """Effective-permission based: `settings.view` to read, `settings.manage`
    to change. Falls back to staff-read so managers keep read context."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if request.method in SAFE_METHODS:
            if not (user.has_perm_code("settings.view") or user.role in STAFF_ROLES):
                self.message = access.denial_message("settings", "view")
                return False
            return True
        if not user.has_perm_code("settings.manage"):
            self.message = access.denial_message("settings", "manage")
            return False
        return True


class BookingConfigPermission(BasePermission):
    """Any authenticated user may READ the booking contact rules (the admin booking
    and customer forms need them to render required/unique behaviour). Changing the
    config requires `settings.manage`."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if request.method in SAFE_METHODS:
            return True
        if not user.has_perm_code("settings.manage"):
            self.message = access.denial_message("settings", "manage")
            return False
        return True


class SchedulePermission(BasePermission):
    """Who may change operating hours, at which scope.

    Reading is open to signed-in staff: the booking form, the roster and the
    facility screens all need to know when a venue is open. Writing follows the
    scope of the row being changed, enforced HERE rather than in the UI:

      organization-wide  ->  `settings.manage`
      one club           ->  `clubs.edit`, and the club must be in the
                             user's own scope
      one facility       ->  `facilities.edit`, same scope rule

    A club-restricted manager therefore cannot reach across to another venue,
    and cannot promote a change to organization-wide by omitting the club.
    """

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if request.method in SAFE_METHODS:
            if not (user.has_perm_code("settings.view") or user.role in STAFF_ROLES):
                self.message = access.denial_message("settings", "view")
                return False
            return True
        return True                      # scope checked per object / on write

    def has_object_permission(self, request, view, obj):
        if request.method in SAFE_METHODS:
            return True
        return self._may_write(request.user, obj.club_id, obj.facility)

    def _may_write(self, user, club_id, facility=None):
        if facility is not None:
            club_id = facility.club_id
            cap = "facilities.edit"
        elif club_id:
            cap = "clubs.edit"
        else:
            cap = "settings.manage"       # organization-wide

        if not user.has_perm_code(cap):
            self.message = access.denial_message(*cap.split(".", 1))
            return False

        scoped = user.scoped_club_ids()
        if club_id and scoped is not None and club_id not in scoped:
            self.message = "You do not have access to that club."
            return False
        if not club_id and scoped is not None:
            # A club-restricted user must not set hours for the whole business.
            self.message = "Only organization administrators can change the "\
                           "organization-wide schedule."
            return False
        return True
