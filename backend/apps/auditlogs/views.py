"""Read-only audit log viewer (requires the `audit.view` capability)."""

from rest_framework import permissions, viewsets

from apps.accounts import access

from .filters import AuditLogFilter
from .models import AuditLog
from .permissions import IsAdminViewer
from .serializers import AuditLogSerializer


class AuditLogViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = AuditLog.objects.select_related("actor").all()
    serializer_class = AuditLogSerializer
    permission_classes = [permissions.IsAuthenticated, IsAdminViewer]
    filterset_class = AuditLogFilter
    search_fields = ["path", "actor__email", "user_agent"]
    ordering_fields = ["created_at", "status_code"]

    def get_queryset(self):
        qs = super().get_queryset()
        # Record ownership: without `audit.view` All a user sees only their own
        # activity (logs where they are the actor). Admins hold view_all.
        if not access.can_view_all(self.request.user, "audit"):
            qs = qs.filter(actor=self.request.user)
        return qs
