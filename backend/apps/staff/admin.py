from django.contrib import admin

from .models import PerformanceSnapshot, Shift, StaffProfile


class ShiftInline(admin.TabularInline):
    model = Shift
    extra = 0


@admin.register(StaffProfile)
class StaffProfileAdmin(admin.ModelAdmin):
    list_display = ("employee_id", "user", "employment_type", "is_available", "rating")
    list_filter = ("employment_type", "is_available", "user__role")
    search_fields = ("employee_id", "user__email", "user__first_name", "user__last_name")
    raw_id_fields = ("user",)
    inlines = [ShiftInline]


@admin.register(Shift)
class ShiftAdmin(admin.ModelAdmin):
    list_display = ("staff", "date", "start_time", "end_time", "is_active")
    list_filter = ("is_active", "date")
    search_fields = ("staff__employee_id", "staff__user__email")
    date_hierarchy = "date"


@admin.register(PerformanceSnapshot)
class PerformanceSnapshotAdmin(admin.ModelAdmin):
    list_display = ("staff", "date", "jobs_completed", "avg_rating", "on_time_percent")
    list_filter = ("date",)
    search_fields = ("staff__employee_id",)
