from django.contrib import admin

from .models import LoyaltyConfiguration, LoyaltyTier


@admin.register(LoyaltyTier)
class LoyaltyTierAdmin(admin.ModelAdmin):
    list_display = ("rank", "name", "slug", "min_points", "min_spend",
                    "discount_percent", "priority_booking", "is_active")
    list_filter = ("is_active", "priority_booking")
    ordering = ("rank",)


@admin.register(LoyaltyConfiguration)
class LoyaltyConfigurationAdmin(admin.ModelAdmin):
    list_display = ("__str__", "earning_enabled", "redemption_enabled", "expiry_months", "updated_at")
