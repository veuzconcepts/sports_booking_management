from rest_framework.permissions import BasePermission

from apps.accounts import access
from apps.accounts.models import Role, STAFF_ROLES

# Standard CRUD action -> required `bookings.<cap>`. Custom @actions
# (transition/cancel/assign/…) are gated inside their own methods.
_CRUD_CAP = {
    "list": "view", "retrieve": "view",
    "create": "add", "update": "edit", "partial_update": "edit", "destroy": "delete",
}


class BookingObjectPermission(BasePermission):
    """Capability-driven for staff; customers reach only their own bookings.

    CRUD requires the matching `bookings.*` capability; lifecycle actions
    self-gate inside the viewset. Row-level "only my assigned jobs" scoping is
    applied in the viewset's `get_queryset`.
    """

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if user.role == Role.CUSTOMER:
            return True   # row-level via has_object_permission / get_queryset
        cap = _CRUD_CAP.get(getattr(view, "action", None))
        if cap and not user.has_perm_code(f"bookings.{cap}"):
            self.message = access.denial_message("bookings", cap)
            return False
        return True

    def has_object_permission(self, request, view, obj):
        if request.user.role in STAFF_ROLES:
            return True
        allowed = bool(obj.customer_id) and obj.customer.linked_user_id == request.user.id
        if not allowed:
            self.message = "You can only access your own bookings."
        return allowed


class BookingHoldPermission(BasePermission):
    """Reservations are an operations view: staff only.

    A customer reaches their own reservation through the bearer token the
    checkout gave them, which is a different door entirely. There is nothing
    here for them, and the list spans every customer in the club, so it is
    closed to them outright rather than filtered down to nothing.
    """

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            self.message = "Please sign in to continue."
            return False
        if user.role not in STAFF_ROLES:
            self.message = "Only staff can view reservations."
            return False
        if not user.has_perm_code("bookings.view"):
            self.message = access.denial_message("bookings", "view")
            return False
        return True
