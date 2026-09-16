from rest_framework import serializers

from .models import Notification, NotificationTemplate


class NotificationTemplateSerializer(serializers.ModelSerializer):
    class Meta:
        model = NotificationTemplate
        fields = (
            "id", "code", "name", "channel", "subject", "body",
            "is_active", "created_at", "updated_at",
        )
        read_only_fields = ("id", "created_at", "updated_at")


class NotificationSerializer(serializers.ModelSerializer):
    recipient_name = serializers.CharField(source="recipient.full_name", read_only=True, default=None)
    template_code = serializers.CharField(source="template.code", read_only=True, default=None)

    class Meta:
        model = Notification
        fields = (
            "id", "recipient", "recipient_name", "to_address",
            "channel", "template", "template_code", "event",
            "subject", "body", "status", "error", "link", "read_at",
            "sent_at", "created_at",
        )
        read_only_fields = fields
