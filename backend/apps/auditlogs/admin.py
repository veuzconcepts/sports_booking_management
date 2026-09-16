from django.contrib import admin

from .models import AuditLog


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ("created_at", "actor", "method", "path", "status_code", "ip")
    list_filter = ("method", "status_code")
    search_fields = ("path", "actor__email", "user_agent")
    readonly_fields = (
        "actor", "method", "path", "status_code", "ip",
        "user_agent", "payload_summary", "created_at",
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
