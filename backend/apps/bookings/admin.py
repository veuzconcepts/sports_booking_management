from django.contrib import admin

from .models import Booking, BookingPolicy, BookingStatusHistory


class BookingStatusHistoryInline(admin.TabularInline):
    model = BookingStatusHistory
    extra = 0
    readonly_fields = ("from_status", "to_status", "changed_by", "note", "created_at")
    can_delete = False


@admin.register(Booking)
class BookingAdmin(admin.ModelAdmin):
    list_display = ("reference", "customer", "club", "facility", "status",
                    "scheduled_date", "scheduled_time", "total_amount", "assigned_to")
    list_filter = ("status", "club", "recurrence", "scheduled_date")
    search_fields = ("reference", "customer__email", "customer__full_name")
    raw_id_fields = ("customer", "facility_category", "facility_type", "club", "facility",
                     "assigned_to", "parent_booking", "created_by")
    readonly_fields = ("reference", "base_amount", "addons_amount", "discount_amount",
                       "tax_amount", "total_amount", "created_at", "updated_at",
                       "completed_at", "cancelled_at")
    filter_horizontal = ("add_ons",)
    inlines = [BookingStatusHistoryInline]
    date_hierarchy = "scheduled_date"


@admin.register(BookingStatusHistory)
class BookingStatusHistoryAdmin(admin.ModelAdmin):
    list_display = ("booking", "from_status", "to_status", "changed_by", "created_at")
    list_filter = ("to_status",)
    search_fields = ("booking__reference",)
    readonly_fields = ("created_at",)


@admin.register(BookingPolicy)
class BookingPolicyAdmin(admin.ModelAdmin):
    list_display = ("__str__", "min_lead_minutes", "max_advance_days",
                    "cancellation_cutoff_hours", "enforce_for_staff")
    list_filter = ("is_default", "enforce_for_staff")
