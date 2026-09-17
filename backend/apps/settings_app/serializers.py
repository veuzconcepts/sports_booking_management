import re

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from . import schedule as sched
from . import theme as theme_cfg
from .uploads import validate_branding_image
from .models import (
    BookingConfiguration,
    Language,
    Organization,
    ScheduleException,
    SystemConfig,
    TaxRate,
    ThemePreset,
)


class OrganizationSerializer(serializers.ModelSerializer):
    # Image fields accept multipart uploads (write) and return absolute URLs (read,
    # via the request in context) so the separate-origin website can load them.
    class Meta:
        model = Organization
        fields = (
            "name", "legal_name", "trn", "website", "email", "phone",
            "address", "city", "country", "timezone", "time_format_24h",
            "slot_minutes", "booking_hours",
            "buffer_before_minutes", "buffer_after_minutes",
            "require_refund_approval",
            "allow_multiple_memberships",
            "summary", "description",
            "logo_light", "logo_dark", "logo_light_vertical", "logo_dark_vertical",
            "favicon", "og_image",
            "meta_title", "meta_description",
            "theme", "theme_preset_name",
            "facebook", "instagram", "twitter", "linkedin", "youtube", "tiktok", "whatsapp",
            "updated_at",
        )
        read_only_fields = ("updated_at",)

    # Branding images are public files served to every visitor, so each one is
    # checked for size, declared type and what the bytes actually decode to.
    BRANDING_IMAGE_FIELDS = (
        "logo_light", "logo_dark", "logo_light_vertical", "logo_dark_vertical",
        "favicon", "og_image",
    )

    def validate(self, attrs):
        errors = {}
        for field in self.BRANDING_IMAGE_FIELDS:
            uploaded = attrs.get(field)
            if uploaded in (None, ""):
                continue
            try:
                validate_branding_image(uploaded)
            except DjangoValidationError as exc:
                errors[field] = list(exc.messages)
        if errors:
            raise serializers.ValidationError(errors)
        return attrs

    def validate_theme(self, value):
        """Only known tokens, only valid colours. A theme reaches a stylesheet,
        so an unchecked value here is an injection point as well as a way to
        make the interface unreadable."""
        try:
            return theme_cfg.clean(value)
        except theme_cfg.ThemeError as exc:
            raise serializers.ValidationError(str(exc)) from exc

    def validate_booking_hours(self, value):
        """The organization is the base every other scope falls back to, so it
        must describe a COMPLETE week - a missing day here has nothing to
        inherit from."""
        return sched.drf_validate_week(value, partial=False)

    def validate_slot_minutes(self, value):
        return sched.validate_slot_minutes(value, allow_blank=False)

    # Allow clearing an image by sending an empty value (multipart can't send null,
    # and ImageField rejects "" — so strip those keys before validation, then null
    # them explicitly). Omitted fields are left untouched (partial update).
    def to_internal_value(self, data):
        img_fields = ("logo_light", "logo_dark", "logo_light_vertical",
                      "logo_dark_vertical", "favicon", "og_image")
        clear = []
        if hasattr(data, "copy"):
            data = data.copy()
        for f in img_fields:
            if f in data and data.get(f) in ("", "null", "undefined", None):
                clear.append(f)
                try:
                    del data[f]
                except Exception:  # pragma: no cover - dict vs QueryDict
                    data.pop(f, None)
        ret = super().to_internal_value(data)
        for f in clear:
            ret[f] = None
        return ret


class TaxRateSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaxRate
        fields = ("id", "name", "rate", "country", "is_default", "created_at", "updated_at")
        read_only_fields = ("id", "created_at", "updated_at")


class SystemConfigSerializer(serializers.ModelSerializer):
    class Meta:
        model = SystemConfig
        fields = ("id", "key", "value", "description", "updated_at")
        read_only_fields = ("id", "updated_at")


class BookingConfigurationSerializer(serializers.ModelSerializer):
    class Meta:
        model = BookingConfiguration
        fields = (
            "website_email_required", "website_phone_required",
            "website_email_unique", "website_phone_unique",
            "admin_email_required", "admin_phone_required",
            "admin_email_unique", "admin_phone_unique",
            "walkin_email_required", "walkin_phone_required",
            "walkin_email_unique", "walkin_phone_unique",
            "updated_at",
        )
        read_only_fields = ("updated_at",)


class ScheduleExceptionSerializer(serializers.ModelSerializer):
    """A special date: holiday, Ramadan hours, tournament, temporary closure."""

    club_name = serializers.CharField(source="club.name", read_only=True, default=None)
    facility_name = serializers.CharField(
        source="facility.name", read_only=True, default=None)
    # A facility-scoped row stores no club, but the edit form needs one to list
    # that club's facilities. Derived, never written.
    facility_club = serializers.IntegerField(
        source="facility.club_id", read_only=True, default=None)
    scope = serializers.CharField(read_only=True)
    scope_label = serializers.SerializerMethodField()

    class Meta:
        model = ScheduleException
        fields = (
            "id", "name", "club", "club_name", "facility", "facility_name",
            "facility_club", "scope", "scope_label",
            "start_date", "end_date", "closed", "shifts", "breaks",
            "slot_minutes", "is_active", "notes",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "club_name", "facility_name", "facility_club",
                            "scope", "scope_label", "created_at", "updated_at")

    def get_scope_label(self, obj) -> str:
        if obj.facility_id:
            return obj.facility.name
        return obj.club.name if obj.club_id else "Whole organization"

    def validate_slot_minutes(self, value):
        return sched.validate_slot_minutes(value)

    def validate(self, attrs):
        def eff(name):
            return attrs.get(name, getattr(self.instance, name, None))

        start, end = eff("start_date"), eff("end_date")
        if end and start and end < start:
            raise serializers.ValidationError(
                {"end_date": "The end date cannot precede the start date."})
        if eff("facility") and eff("club"):
            raise serializers.ValidationError(
                {"facility": "Choose a club or a facility, not both - a facility "
                             "already belongs to one club."})

        if not eff("closed"):
            # Custom hours reuse the weekday validator, so a special date is held
            # to exactly the same rules as an ordinary day. Its complaints are
            # re-keyed onto `shifts`, which is the field the form actually shows.
            try:
                cleaned = sched.validate_week(
                    {"mon": {"closed": False,
                             "shifts": eff("shifts") or [],
                             "breaks": eff("breaks") or []}})
            except sched.ScheduleValidationError as exc:
                messages = exc.message_dict.get("mon") or ["Check the hours."]
                raise serializers.ValidationError({"shifts": messages[0]}) from exc

            day = cleaned.get("mon") or {}
            if not day.get("shifts"):
                raise serializers.ValidationError(
                    {"shifts": "Add the operating hours, or mark the date closed."})
            attrs["shifts"] = day["shifts"]
            attrs["breaks"] = day.get("breaks", [])
        return attrs


class LanguageSerializer(serializers.ModelSerializer):
    """A language an administrator has made available."""

    effective_locale = serializers.CharField(read_only=True)
    is_rtl = serializers.BooleanField(read_only=True)

    class Meta:
        model = Language
        fields = (
            "id", "code", "locale", "effective_locale", "name", "native_name",
            "direction", "is_rtl", "is_enabled", "is_default", "display_order",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "effective_locale", "is_rtl",
                            "created_at", "updated_at")

    def validate_code(self, value):
        """A language tag, not free text: letters, optionally region-suffixed."""
        code = (value or "").strip()
        if not re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?", code):
            raise serializers.ValidationError(
                "Use a standard language tag such as 'en', 'ar' or 'en-GB'.")
        return code.lower()

    def validate(self, attrs):
        def eff(name):
            return attrs.get(name, getattr(self.instance, name, None))

        # The default is what everything falls back to, so it cannot be off.
        if eff("is_default") and not eff("is_enabled"):
            raise serializers.ValidationError(
                {"is_enabled": "The default language must stay enabled."})
        return attrs


class ThemePresetSerializer(serializers.ModelSerializer):
    """A saved starting point. `tokens` is validated against the catalogue so a
    preset can never carry a value the renderer would have to guess about."""

    resolved = serializers.SerializerMethodField()

    class Meta:
        model = ThemePreset
        fields = ("id", "name", "tokens", "resolved", "is_builtin", "is_archived",
                  "display_order", "created_at", "updated_at")
        read_only_fields = ("id", "is_builtin", "created_at", "updated_at")

    def get_resolved(self, obj):
        """The full palette, so the settings screen can draw a swatch without
        reimplementing the fallback rules."""
        return theme_cfg.resolve(obj.tokens)

    def validate_tokens(self, value):
        try:
            return theme_cfg.clean(value)
        except theme_cfg.ThemeError as exc:
            raise serializers.ValidationError(str(exc)) from exc

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("A theme name is required.")
        return value

    def update(self, instance, validated_data):
        # A shipped preset is the fallback other people rely on; it can be
        # duplicated but not rewritten.
        if instance.is_builtin:
            raise serializers.ValidationError(
                "A built-in theme cannot be edited. Duplicate it first.")
        return super().update(instance, validated_data)
