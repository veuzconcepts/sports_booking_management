from rest_framework import serializers

from apps.facilities.serializers import FacilitySerializer
from apps.settings_app import schedule as sched

from .models import Club


class ClubSerializer(serializers.ModelSerializer):
    facilities = FacilitySerializer(many=True, read_only=True)
    facility_count = serializers.SerializerMethodField()
    schedule_source = serializers.SerializerMethodField()
    effective_schedule = serializers.SerializerMethodField()
    effective_booking_policy = serializers.SerializerMethodField()

    class Meta:
        model = Club
        fields = (
            "id", "code", "name", "address", "city", "phone", "email",
            "latitude", "longitude", "is_active",
            "booking_hours", "slot_minutes",
            "buffer_before_minutes", "buffer_after_minutes",
            # Null in any of these means "inherit the organization", so they are
            # deliberately nullable rather than defaulted here.
            "hold_unpaid_minutes", "hold_partly_paid_minutes", "hold_max_minutes",
            "split_enabled", "split_hold_minutes", "split_max_shares",
            "cash_enabled", "show_hold_countdown",
            "effective_booking_policy",
            "schedule_source", "effective_schedule",
            "facilities", "facility_count",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "created_at", "updated_at")

    def get_facility_count(self, obj) -> int:
        return obj.facilities.count()

    def get_effective_booking_policy(self, obj) -> dict:
        """What this club's reservations and payments actually resolve to.

        The admin screen shows the inherited value in the empty override field,
        so somebody can see what a blank box means without opening the
        organization settings in another tab.
        """
        return sched.resolve_booking_policy(obj)

    def get_schedule_source(self, obj) -> str:
        """"organization" while this club overrides nothing, else "club"."""
        return sched.SCOPE_CLUB if (obj.booking_hours or {}) else sched.SCOPE_ORGANIZATION

    def get_effective_schedule(self, obj) -> dict:
        """The resolved week with a per-day source, so the admin screen shows
        the same pattern the booking engine will actually use."""
        return sched.effective_week(club=obj)

    def validate_booking_hours(self, value):
        """A club override is PARTIAL: only the weekdays present are stored, and
        the rest keep following the organization. Sending {} clears the
        override and returns the club to fully inherited hours."""
        return sched.drf_validate_week(value, partial=True)

    def validate_slot_minutes(self, value):
        return sched.validate_slot_minutes(value)
