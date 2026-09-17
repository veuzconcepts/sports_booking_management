from rest_framework import serializers

from .models import AuditLog


class AuditLogSerializer(serializers.ModelSerializer):
    actor_email = serializers.CharField(source="actor.email", read_only=True, default=None)
    actor_name = serializers.CharField(source="actor.full_name", read_only=True, default=None)
    event = serializers.SerializerMethodField()
    payload_summary = serializers.SerializerMethodField()

    class Meta:
        model = AuditLog
        fields = (
            "id", "actor", "actor_email", "actor_name",
            "method", "path", "status_code", "ip", "user_agent",
            "event", "payload_summary", "created_at",
        )
        read_only_fields = fields

    def get_event(self, obj) -> str | None:
        return obj.payload_summary.get("event") if isinstance(obj.payload_summary, dict) else None

    def get_payload_summary(self, obj):
        """Mask the promo code in PROMO events for users without promotions.view.
        (Other events may carry an unrelated `code`, e.g. a membership plan code.)"""
        data = obj.payload_summary
        if not isinstance(data, dict) or "code" not in data:
            return data
        if "promo" not in (data.get("event") or ""):
            return data
        from apps.bookings.serializers import PROMO_MASK, can_view_promo
        if can_view_promo(self.context):
            return data
        return {**data, "code": PROMO_MASK}
