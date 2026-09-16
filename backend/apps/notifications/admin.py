from django.contrib import admin

from .models import Notification, NotificationTemplate


@admin.register(NotificationTemplate)
class NotificationTemplateAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "channel", "is_active", "updated_at")
    list_filter = ("channel", "is_active")
    search_fields = ("code", "name", "subject")


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ("created_at", "channel", "to_address", "event", "status")
    list_filter = ("status", "channel", "event")
    search_fields = ("to_address", "subject", "recipient__email")
    readonly_fields = ("created_at", "sent_at")
