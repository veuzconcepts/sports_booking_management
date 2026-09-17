from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.accounts.models import STAFF_ROLES


class NotificationLogPermission(BasePermission):
    """Staff read the delivery log; customers read only their own notifications."""

    def has_permission(self, request, view):
        return request.user.is_authenticated

    def has_object_permission(self, request, view, obj):
        if request.user.role in STAFF_ROLES:
            return True
        return obj.recipient_id == request.user.id


class TemplatePermission(BasePermission):
    """Templates: staff read; editing requires the `notifications.manage`
    capability (capability-driven, not gated by an admin role name)."""

    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        if request.method in SAFE_METHODS:
            return request.user.role in STAFF_ROLES
        return request.user.has_perm_code("notifications.manage")
