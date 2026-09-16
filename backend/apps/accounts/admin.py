from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ("email", "first_name", "last_name", "role", "is_super_admin",
                    "is_active", "created_at")
    list_filter = ("role", "is_super_admin", "is_active", "is_staff")
    search_fields = ("email", "first_name", "last_name", "phone")
    ordering = ("-created_at",)
    # Ownership changes only via election / `promote_super_admin` / a future
    # transfer action — never by a casual edit in the Django admin.
    readonly_fields = ("is_super_admin",)

    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Profile", {"fields": ("first_name", "last_name", "phone", "avatar")}),
        ("Role & status", {"fields": ("role", "is_super_admin", "is_active",
                                       "is_staff", "is_superuser")}),
        ("Permissions", {"fields": ("groups", "user_permissions")}),
        ("Important dates", {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = (
        (None, {
            "classes": ("wide",),
            "fields": ("email", "first_name", "last_name", "role",
                       "password1", "password2"),
        }),
    )
