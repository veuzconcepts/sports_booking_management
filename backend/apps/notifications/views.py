"""Notification endpoints: delivery log (read-only) + template CRUD."""

from django.utils import timezone
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounts.models import STAFF_ROLES

from .models import Notification, NotificationChannel, NotificationTemplate
from .permissions import NotificationLogPermission, TemplatePermission
from .serializers import NotificationSerializer, NotificationTemplateSerializer
from .services import notify
from config.listing import GroupedListMixin


class NotificationViewSet(GroupedListMixin, viewsets.ReadOnlyModelViewSet):
    queryset = Notification.objects.select_related("recipient", "template").all()
    serializer_class = NotificationSerializer
    permission_classes = [permissions.IsAuthenticated, NotificationLogPermission]
    filterset_fields = ["status", "channel", "event", "recipient"]
    search_fields = ["to_address", "subject", "recipient__email"]
    ordering_fields = ["created_at", "status", "channel", "event", "to_address"]
    group_by_fields = {
        "status": {"field": "status"},
        "channel": {"field": "channel"},
        "event": {"field": "event", "empty_label": "No event"},
    }

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.user.role in STAFF_ROLES:
            return qs
        return qs.filter(recipient=self.request.user)

    # ---- In-app feed (the bell): every user sees their OWN in-app notifications ---
    def _my_in_app(self, request):
        return Notification.objects.filter(
            recipient=request.user, channel=NotificationChannel.IN_APP)

    @action(detail=False, methods=["get"])
    def mine(self, request):
        """The signed-in user's in-app notifications (newest first)."""
        qs = self._my_in_app(request).order_by("-created_at")[:50]
        return Response(NotificationSerializer(qs, many=True).data)

    @action(detail=False, methods=["get"], url_path="unread-count")
    def unread_count(self, request):
        return Response({"unread": self._my_in_app(request).filter(read_at__isnull=True).count()})

    @action(detail=False, methods=["post"], url_path="mark-all-read")
    def mark_all_read(self, request):
        self._my_in_app(request).filter(read_at__isnull=True).update(read_at=timezone.now())
        return Response({"unread": 0})

    @action(detail=True, methods=["post"])
    def read(self, request, pk=None):
        """Mark a single in-app notification read (own only)."""
        n = self.get_object()
        if n.recipient_id == request.user.id and n.read_at is None:
            n.read_at = timezone.now()
            n.save(update_fields=["read_at"])
        return Response(NotificationSerializer(n).data)

    @action(detail=True, methods=["post"])
    def resend(self, request, pk=None):
        """Re-dispatch a notification from its original template + context."""
        if not request.user.has_perm_code("notifications.manage"):
            return Response({"detail": "You don't have permission to manage notifications."},
                            status=status.HTTP_403_FORBIDDEN)
        original = self.get_object()
        if not original.template_id:
            return Response({"detail": "Original template no longer exists."},
                            status=status.HTTP_400_BAD_REQUEST)
        sent = notify(original.recipient, original.template.code,
                      original.context, event=original.event)
        if sent is None:
            return Response({"detail": "Could not resend."},
                            status=status.HTTP_400_BAD_REQUEST)
        return Response(NotificationSerializer(sent).data, status=status.HTTP_201_CREATED)


class NotificationTemplateViewSet(GroupedListMixin, viewsets.ModelViewSet):
    queryset = NotificationTemplate.objects.all()
    serializer_class = NotificationTemplateSerializer
    permission_classes = [permissions.IsAuthenticated, TemplatePermission]
    filterset_fields = ["channel", "is_active"]
    search_fields = ["code", "name", "subject"]
    ordering_fields = ["code", "name", "channel", "is_active"]
    group_by_fields = {
        "channel": {"field": "channel"},
        "is_active": {"field": "is_active", "true_label": "Active",
                      "empty_label": "Inactive"},
    }
    search_fields = ["code", "name", "subject"]
    ordering_fields = ["code", "created_at"]
