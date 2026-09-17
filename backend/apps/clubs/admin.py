from django.contrib import admin

from .models import Club


@admin.register(Club)
class ClubAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "city", "is_active")
    list_filter = ("is_active", "city")
    search_fields = ("code", "name", "city")


