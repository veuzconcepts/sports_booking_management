from django.contrib import admin

from .models import (
    AddOn,
    Facility,
    FacilityCategory,
    FacilityType,
    MaintenanceBlock,
    PricingRule,
)


@admin.register(PricingRule)
class PricingRuleAdmin(admin.ModelAdmin):
    list_display = ("name", "code", "rule_type", "adjustment_type",
                    "adjustment_value", "priority", "is_active")
    list_filter = ("is_active", "rule_type", "adjustment_type")
    search_fields = ("name", "code", "description")
    filter_horizontal = ("categories", "facility_types", "addons", "clubs", "membership_plans")


@admin.register(FacilityCategory)
class FacilityCategoryAdmin(admin.ModelAdmin):
    list_display = ("name", "kind", "base_price", "base_duration_minutes", "is_active")
    list_filter = ("kind", "is_active")
    search_fields = ("name", "slug", "description")
    prepopulated_fields = {"slug": ("name",)}
    filter_horizontal = ("available_clubs",)


@admin.register(FacilityType)
class FacilityTypeAdmin(admin.ModelAdmin):
    list_display = ("name", "price", "duration_minutes", "tax_percent",
                    "discount_percent", "online_booking_enabled", "is_active")
    list_filter = ("categories", "is_active", "online_booking_enabled",
                   "staff_required", "facility_required")
    search_fields = ("name", "description", "categories__name")
    filter_horizontal = ("categories", "add_ons", "available_clubs")


@admin.register(Facility)
class FacilityAdmin(admin.ModelAdmin):
    list_display = ("club", "name", "is_active")
    list_filter = ("is_active", "club", "facility_types")
    search_fields = ("name", "club__name", "club__code")
    filter_horizontal = ("facility_types",)


@admin.register(MaintenanceBlock)
class MaintenanceBlockAdmin(admin.ModelAdmin):
    list_display = ("facility", "start_date", "end_date", "start_time", "end_time", "reason")
    list_filter = ("facility__club", "start_date")
    search_fields = ("reason", "facility__name")
    raw_id_fields = ("facility",)


@admin.register(AddOn)
class AddOnAdmin(admin.ModelAdmin):
    list_display = ("name", "code", "price", "tax_percent",
                    "duration_minutes", "is_featured", "display_order", "is_active")
    list_filter = ("is_active", "is_featured", "categories")
    search_fields = ("name", "code", "description")
    filter_horizontal = ("categories", "available_clubs")
