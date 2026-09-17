"""Staff serializers — profile (with nested user creation), shifts, performance."""

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.db import transaction
from rest_framework import serializers

from apps.accounts.models import Role, STAFF_ROLES

from .models import (
    PerformanceSnapshot, Shift, StaffClubTransfer, StaffProfile,
)

User = get_user_model()


class StaffClubTransferSerializer(serializers.ModelSerializer):
    staff_name = serializers.CharField(source="staff.full_name", read_only=True)
    employee_id = serializers.CharField(source="staff.employee_id", read_only=True)
    from_club_name = serializers.CharField(source="from_club.name", read_only=True, default=None)
    to_club_name = serializers.CharField(source="to_club.name", read_only=True, default=None)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    approved_by_name = serializers.CharField(source="approved_by.full_name", read_only=True, default=None)
    # Optional on input — immediate transfers default to today (set in the view).
    effective_date = serializers.DateField(required=False)

    class Meta:
        model = StaffClubTransfer
        fields = (
            "id", "staff", "staff_name", "employee_id",
            "from_club", "from_club_name", "to_club", "to_club_name",
            "effective_date", "transfer_type", "reason", "remarks",
            "status", "shift_option", "reassign_plan", "impact_snapshot",
            "created_by", "created_by_name", "approved_by", "approved_by_name",
            "cancelled_by", "cancel_reason", "approved_at", "completed_at", "created_at",
        )
        # Lifecycle / system fields are set by the workflow, not the payload.
        read_only_fields = (
            "id", "status", "from_club", "impact_snapshot",
            "created_by", "approved_by", "approved_at", "completed_at", "created_at",
            "cancelled_by", "cancel_reason",
        )


class ShiftSerializer(serializers.ModelSerializer):
    class Meta:
        model = Shift
        fields = (
            "id", "staff", "date", "start_time", "end_time",
            "is_active", "note",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "created_at", "updated_at")

    def validate(self, attrs):
        from .models import conflicting_shift
        inst = self.instance
        start = attrs.get("start_time", getattr(inst, "start_time", None))
        end = attrs.get("end_time", getattr(inst, "end_time", None))
        staff = attrs.get("staff", getattr(inst, "staff", None))
        date = attrs.get("date", getattr(inst, "date", None))
        is_active = attrs.get("is_active", getattr(inst, "is_active", True))

        if start and end and end <= start:
            raise serializers.ValidationError(
                {"end_time": "End time must be after start time."}
            )
        if staff and date and start and end and is_active:
            other = conflicting_shift(
                staff.id, date, start, end,
                exclude_pk=inst.pk if inst else None,
            )
            if other:
                raise serializers.ValidationError({"start_time": (
                    f"This shift overlaps an existing "
                    f"{other.start_time.strftime('%H:%M')}-{other.end_time.strftime('%H:%M')} "
                    f"shift on {date}."
                )})
        return attrs


class PerformanceSnapshotSerializer(serializers.ModelSerializer):
    class Meta:
        model = PerformanceSnapshot
        fields = (
            "id", "staff", "date", "jobs_completed",
            "avg_rating", "on_time_percent", "created_at",
        )
        read_only_fields = ("id", "created_at")


class StaffProfileSerializer(serializers.ModelSerializer):
    full_name = serializers.CharField(read_only=True)
    role = serializers.CharField(read_only=True)
    email = serializers.CharField(source="user.email", read_only=True)
    phone = serializers.CharField(source="user.phone", read_only=True)
    base_club_name = serializers.CharField(source="base_club.name", read_only=True, default=None)
    shifts = ShiftSerializer(many=True, read_only=True)
    # Weekly shift schedule (Employee → Club → Organization fallback).
    schedule_source = serializers.SerializerMethodField()
    effective_schedule = serializers.SerializerMethodField()
    club_schedule = serializers.SerializerMethodField()
    organization_schedule = serializers.SerializerMethodField()

    class Meta:
        model = StaffProfile
        fields = (
            "id", "user", "full_name", "role", "email", "phone",
            "employee_id", "employment_type", "skills", "base_club", "base_club_name",
            "hired_on", "is_available", "rating", "notes",
            "shifts", "shift_hours",
            "schedule_source", "effective_schedule", "club_schedule", "organization_schedule",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "rating", "shift_hours", "created_at", "updated_at")

    def get_schedule_source(self, obj) -> str:
        from .services import resolve_staff_schedule
        return resolve_staff_schedule(obj)[1]

    def get_effective_schedule(self, obj) -> dict:
        from .services import resolve_staff_schedule
        return resolve_staff_schedule(obj)[0]

    def get_club_schedule(self, obj) -> dict:
        from .services import club_week
        return club_week(obj)

    def get_organization_schedule(self, obj) -> dict:
        from .services import organization_week
        return organization_week()

    def validate_user(self, value):
        if value.role not in STAFF_ROLES:
            raise serializers.ValidationError(
                "Staff profiles can only be attached to internal (non-customer) users."
            )
        return value


class StaffProfileCreateSerializer(serializers.ModelSerializer):
    """Create a staff User + profile in one POST (mirrors CustomerCreateSerializer)."""

    email = serializers.EmailField(write_only=True)
    first_name = serializers.CharField(write_only=True)
    last_name = serializers.CharField(write_only=True)
    phone = serializers.CharField(write_only=True, required=False, allow_blank=True)
    role = serializers.ChoiceField(choices=Role.choices, write_only=True)
    password = serializers.CharField(
        write_only=True, validators=[validate_password], required=False,
    )

    class Meta:
        model = StaffProfile
        fields = (
            "id",
            "email", "first_name", "last_name", "phone", "role", "password",
            "employee_id", "employment_type", "skills", "base_club",
            "hired_on", "is_available", "notes",
        )
        read_only_fields = ("id",)

    def validate_email(self, value):
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("A user with this email already exists.")
        return value.lower()

    def validate_role(self, value):
        if value not in STAFF_ROLES:
            raise serializers.ValidationError("Role must be an internal staff role.")
        return value

    def validate_employee_id(self, value):
        if StaffProfile.objects.filter(employee_id=value).exists():
            raise serializers.ValidationError("This employee ID is already in use.")
        return value

    @transaction.atomic
    def create(self, validated_data):
        email = validated_data.pop("email")
        first_name = validated_data.pop("first_name")
        last_name = validated_data.pop("last_name")
        phone = validated_data.pop("phone", "")
        role = validated_data.pop("role")
        from apps.accounts.security import generate_password
        password = validated_data.pop("password", None) or generate_password()

        user = User.objects.create_user(
            email=email,
            password=password,
            first_name=first_name,
            last_name=last_name,
            phone=phone,
            role=role,
            is_staff=True,
        )
        return StaffProfile.objects.create(user=user, **validated_data)

    def to_representation(self, instance):
        return StaffProfileSerializer(instance, context=self.context).data
