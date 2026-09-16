from rest_framework import serializers

from apps.clubs.models import Club
from apps.settings_app.currency import validate_currency_precision

from .models import (
    AddOn,
    Facility,
    FacilityCategory,
    FacilityType,
    MaintenanceBlock,
    PricingAdjustmentType,
    PricingRule,
    PricingRuleType,
)
from .pricing import adjustment_label


def _validate_unit_price(value):
    """Unit prices may carry extended precision (high-precision); the line amount
    is rounded to the currency's precision when used."""
    validate_currency_precision(value, field_type="unit_price")
    return value


class FacilitySerializer(serializers.ModelSerializer):
    club_name = serializers.CharField(source="club.name", read_only=True)
    facility_types = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=FacilityType.objects.all(),
    )
    facility_type_names = serializers.SerializerMethodField()
    schedule_source = serializers.SerializerMethodField()
    effective_schedule = serializers.SerializerMethodField()

    class Meta:
        model = Facility
        fields = ("id", "club", "club_name", "name",
                  "facility_types", "facility_type_names",
                  "booking_hours", "slot_minutes",
                  "buffer_before_minutes", "buffer_after_minutes",
                  "schedule_source", "effective_schedule",
                  "is_active", "notes", "created_at")
        read_only_fields = ("id", "club_name", "facility_type_names",
                            "schedule_source", "effective_schedule", "created_at")

    def get_facility_type_names(self, obj) -> list[str]:
        return [t.name for t in obj.facility_types.all()]

    def get_schedule_source(self, obj) -> str:
        """"club" while this facility overrides nothing, else "facility"."""
        from apps.settings_app import schedule as sched
        return sched.SCOPE_FACILITY if (obj.booking_hours or {}) else sched.SCOPE_CLUB

    def get_effective_schedule(self, obj) -> dict:
        """The resolved week after Organization -> Club -> Facility, each day
        tagged with the scope it came from."""
        from apps.settings_app import schedule as sched
        return sched.effective_week(club=obj.club, facility=obj)

    def validate_booking_hours(self, value):
        """A facility override is PARTIAL: a unit that differs only on Friday
        stores only Friday and inherits the rest from its club. Sending {}
        returns it to fully inherited hours."""
        from apps.settings_app import schedule as sched
        return sched.drf_validate_week(value, partial=True)

    def validate_slot_minutes(self, value):
        from apps.settings_app import schedule as sched
        return sched.validate_slot_minutes(value)


class MaintenanceBlockSerializer(serializers.ModelSerializer):
    facility_name = serializers.CharField(source="facility.name", read_only=True)
    club = serializers.IntegerField(source="facility.club_id", read_only=True)
    club_name = serializers.CharField(source="facility.club.name", read_only=True)
    is_all_day = serializers.BooleanField(read_only=True)

    class Meta:
        model = MaintenanceBlock
        fields = ("id", "facility", "facility_name", "club", "club_name",
                  "start_date", "end_date", "start_time", "end_time",
                  "is_all_day", "reason", "created_at", "updated_at")
        read_only_fields = ("id", "facility_name", "club", "club_name",
                            "is_all_day", "created_at", "updated_at")

    def validate(self, attrs):
        def eff(field):
            return attrs.get(field, getattr(self.instance, field, None))

        start_date, end_date = eff("start_date"), eff("end_date")
        start_time, end_time = eff("start_time"), eff("end_time")

        if start_date and end_date and end_date < start_date:
            raise serializers.ValidationError(
                {"end_date": "End date cannot be before the start date."})
        if bool(start_time) != bool(end_time):
            raise serializers.ValidationError({"start_time": (
                "Give both a start and an end time, or leave both blank for all day.")})
        if start_time and end_time and end_time <= start_time:
            raise serializers.ValidationError(
                {"end_time": "End time must be after start time."})
        return attrs


class FacilityCategorySerializer(serializers.ModelSerializer):
    slug = serializers.SlugField(max_length=140, required=False, allow_blank=True)
    available_clubs = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=Club.objects.all(),
    )
    available_club_names = serializers.SerializerMethodField()
    # Facility types assigned to this category (reverse M2M FacilityType.categories).
    facility_types = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=FacilityType.objects.all(),
    )
    facility_type_names = serializers.SerializerMethodField()

    class Meta:
        model = FacilityCategory
        fields = (
            "id",
            "name", "slug", "kind", "description",
            "base_duration_minutes",
            "base_price",
            # presentation / merchandising
            "banner_image", "icon",
            "badge_label", "badge_status",
            "is_featured", "available_clubs", "available_club_names",
            # facility types under this category
            "facility_types", "facility_type_names",
            # seo
            "meta_title", "meta_description",
            "is_active", "display_order",
            "created_at", "updated_at",
        )
        read_only_fields = (
            "id", "available_club_names", "facility_type_names", "created_at", "updated_at",
        )

    def get_available_club_names(self, obj) -> list[str]:
        return [c.name for c in obj.available_clubs.all()]

    def get_facility_type_names(self, obj) -> list[str]:
        return [t.name for t in obj.facility_types.all()]

    def create(self, validated_data):
        # Reverse M2M can't be passed to the constructor; assign after creation.
        facility_types = validated_data.pop("facility_types", None)
        instance = super().create(validated_data)
        self._assign_types(instance, facility_types)
        return instance

    def update(self, instance, validated_data):
        facility_types = validated_data.pop("facility_types", None)
        instance = super().update(instance, validated_data)
        self._assign_types(instance, facility_types)
        return instance

    @staticmethod
    def _assign_types(category, facility_types):
        """Add this category to each selected facility type (additive)."""
        if not facility_types:
            return
        for ft in facility_types:
            ft.categories.add(category)

    def validate_base_price(self, value):
        return _validate_unit_price(value)

    def validate_description(self, value):
        # Category description is rich text (HTML) - store a sanitised subset.
        from .richtext import clean_html
        return clean_html(value)

    def validate(self, attrs):
        # Auto-derive a slug from the name when omitted/blank.
        if not attrs.get("slug"):
            name = attrs.get("name") or getattr(self.instance, "name", "")
            if name:
                from django.utils.text import slugify
                attrs["slug"] = slugify(name)[:140]
        # Enforce slug uniqueness with a clean 400 (covers derived slugs too).
        slug = attrs.get("slug")
        if slug:
            qs = FacilityCategory.objects.filter(slug=slug)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise serializers.ValidationError(
                    {"slug": "A category with this slug already exists."}
                )
        return attrs


class FacilityTypeSerializer(serializers.ModelSerializer):
    categories = serializers.PrimaryKeyRelatedField(
        many=True, queryset=FacilityCategory.objects.all(),
    )
    category_names = serializers.SerializerMethodField()
    add_on_names = serializers.SerializerMethodField()
    available_clubs = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=Club.objects.all(),
    )
    available_club_names = serializers.SerializerMethodField()

    class Meta:
        model = FacilityType
        fields = (
            "id",
            "name", "tagline", "badge", "categories", "category_names", "description",
            "whats_included", "whats_not_included",
            "duration_minutes",
            "price", "tax_percent", "tax_inclusive", "discount_percent",
            "image", "video",
            "available_all_clubs", "available_clubs", "available_club_names",
            "add_ons", "add_on_names",
            "staff_required", "facility_required",
            "online_booking_enabled", "is_active",
            "created_at", "updated_at",
        )
        read_only_fields = (
            "id", "category_names", "add_on_names", "available_club_names",
            "created_at", "updated_at",
        )

    def get_category_names(self, obj) -> list[str]:
        return [c.name for c in obj.categories.all()]

    def get_add_on_names(self, obj) -> list[str]:
        return [a.name for a in obj.add_ons.all()]

    def get_available_club_names(self, obj) -> list[str]:
        return [c.name for c in obj.available_clubs.all()]

    def validate_categories(self, value):
        if not value:
            raise serializers.ValidationError("Select at least one category.")
        return value

    def validate_price(self, value):
        return _validate_unit_price(value)

    def validate_whats_included(self, value):
        # "What's Included" is rich text (HTML) - store a sanitised subset.
        from .richtext import clean_html
        return clean_html(value)

    def validate_whats_not_included(self, value):
        # Plain text (one caveat per line) - strip any markup, keep line breaks.
        import bleach
        return bleach.clean(value or "", tags=[], strip=True).strip()

    def create(self, validated_data):
        add_ons = validated_data.pop("add_ons", [])
        clubs = validated_data.pop("available_clubs", [])
        categories = validated_data.pop("categories", [])
        item = FacilityType.objects.create(**validated_data)
        item.categories.set(categories)
        item.add_ons.set(add_ons)
        item.available_clubs.set(clubs)
        return item

    def update(self, instance, validated_data):
        add_ons = validated_data.pop("add_ons", None)
        clubs = validated_data.pop("available_clubs", None)
        categories = validated_data.pop("categories", None)
        for attr, val in validated_data.items():
            setattr(instance, attr, val)
        instance.save()
        if categories is not None:
            instance.categories.set(categories)
        if add_ons is not None:
            instance.add_ons.set(add_ons)
        if clubs is not None:
            instance.available_clubs.set(clubs)
        return instance


class AddOnSerializer(serializers.ModelSerializer):
    code = serializers.CharField(
        max_length=40, required=False, allow_blank=True, allow_null=True,
    )
    categories = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=FacilityCategory.objects.all(),
    )
    category_names = serializers.SerializerMethodField()
    # Facility types that offer this add-on (reverse of FacilityType.add_ons).
    facility_types = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=FacilityType.objects.all(),
    )
    facility_type_names = serializers.SerializerMethodField()
    available_clubs = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=Club.objects.all(),
    )
    available_club_names = serializers.SerializerMethodField()

    class Meta:
        model = AddOn
        fields = (
            "id", "name", "code", "description",
            "categories", "category_names",
            "facility_types", "facility_type_names",
            "price", "tax_percent", "tax_inclusive", "duration_minutes",
            "available_all_clubs", "available_clubs", "available_club_names",
            "image", "is_featured", "display_order", "is_active",
        )
        read_only_fields = (
            "id", "category_names", "facility_type_names", "available_club_names",
        )

    def get_category_names(self, obj) -> list[str]:
        return [c.name for c in obj.categories.all()]

    def get_facility_type_names(self, obj) -> list[str]:
        return [t.name for t in obj.facility_types.all()]

    def get_available_club_names(self, obj) -> list[str]:
        return [c.name for c in obj.available_clubs.all()]

    def validate_price(self, value):
        return _validate_unit_price(value)

    def validate(self, attrs):
        # Normalise blank code to NULL so the unique constraint allows many blanks.
        code = attrs.get("code")
        if code is not None and not code.strip():
            attrs["code"] = None
            code = None
        if code:
            qs = AddOn.objects.filter(code=code)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise serializers.ValidationError(
                    {"code": "An add-on with this code already exists."}
                )
        return attrs

    def create(self, validated_data):
        categories = validated_data.pop("categories", [])
        clubs = validated_data.pop("available_clubs", [])
        facility_types = validated_data.pop("facility_types", [])
        addon = AddOn.objects.create(**validated_data)
        addon.categories.set(categories)
        addon.available_clubs.set(clubs)
        addon.facility_types.set(facility_types)
        return addon

    def update(self, instance, validated_data):
        categories = validated_data.pop("categories", None)
        clubs = validated_data.pop("available_clubs", None)
        facility_types = validated_data.pop("facility_types", None)
        for attr, val in validated_data.items():
            setattr(instance, attr, val)
        instance.save()
        if categories is not None:
            instance.categories.set(categories)
        if clubs is not None:
            instance.available_clubs.set(clubs)
        if facility_types is not None:
            instance.facility_types.set(facility_types)
        return instance


class PricingRuleSerializer(serializers.ModelSerializer):
    rule_type_display = serializers.CharField(source="get_rule_type_display", read_only=True)
    adjustment_type_display = serializers.CharField(source="get_adjustment_type_display", read_only=True)
    adjustment_display = serializers.SerializerMethodField()
    applies_to_summary = serializers.SerializerMethodField()
    condition_summary = serializers.SerializerMethodField()
    validity_summary = serializers.SerializerMethodField()

    class Meta:
        model = PricingRule
        fields = (
            "id", "name", "code", "description",
            "is_active", "priority", "display_order",
            "rule_type", "rule_type_display",
            "adjustment_type", "adjustment_type_display", "adjustment_value",
            "currency", "tax_applicable", "allow_stacking",
            "categories", "facility_types", "addons",
            "clubs", "membership_plans",
            "customer_types", "days_of_week",
            "valid_from", "valid_to", "start_time", "end_time",
            "min_amount", "min_quantity",
            # read-only display helpers
            "adjustment_display", "applies_to_summary", "condition_summary", "validity_summary",
            "created_at", "updated_at",
        )
        read_only_fields = (
            "id", "rule_type_display", "adjustment_type_display", "adjustment_display",
            "applies_to_summary", "condition_summary", "validity_summary",
            "created_at", "updated_at",
        )

    def get_adjustment_display(self, obj):
        return adjustment_label(obj.adjustment_type, obj.adjustment_value, obj.currency)

    def get_applies_to_summary(self, obj):
        parts = []
        c = obj.categories.count()
        t = obj.facility_types.count()
        a = obj.addons.count()
        if c:
            parts.append(f"{c} categor{'y' if c == 1 else 'ies'}")
        if t:
            parts.append(f"{t} facility type{'' if t == 1 else 's'}")
        if a:
            parts.append(f"{a} add-on{'' if a == 1 else 's'}")
        return ", ".join(parts) if parts else "All facility types"

    def get_condition_summary(self, obj):
        parts = []
        if obj.clubs.exists():
            parts.append(f"{obj.clubs.count()} club(s)")
        if obj.customer_types:
            parts.append("Customer: " + ", ".join(obj.customer_types))
        if obj.membership_plans.exists():
            parts.append(f"{obj.membership_plans.count()} plan(s)")
        if obj.days_of_week:
            days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            parts.append(", ".join(days[d] for d in obj.days_of_week if 0 <= d < 7))
        if obj.start_time and obj.end_time:
            parts.append(f"{obj.start_time.strftime('%H:%M')}-{obj.end_time.strftime('%H:%M')}")
        return " / ".join(parts) if parts else "-"

    def get_validity_summary(self, obj):
        if obj.valid_from or obj.valid_to:
            return f"{obj.valid_from or '...'} to {obj.valid_to or '...'}"
        return "Always"

    def validate(self, attrs):
        def eff(field):
            if field in attrs:
                return attrs[field]
            return getattr(self.instance, field, None)

        rule_type = eff("rule_type")
        adj_type = eff("adjustment_type")
        adj_value = eff("adjustment_value")
        valid_from = eff("valid_from")
        valid_to = eff("valid_to")
        start_time = eff("start_time")
        end_time = eff("end_time")

        # Validity (Valid From / Valid To) is mandatory for every pricing rule.
        if not valid_from:
            raise serializers.ValidationError({"valid_from": "Valid From is required."})
        if not valid_to:
            raise serializers.ValidationError({"valid_to": "Valid To is required."})
        if valid_from and valid_to and valid_from > valid_to:
            raise serializers.ValidationError({"valid_to": "Valid To must be after Valid From."})

        percent_types = (PricingAdjustmentType.PERCENT_INCREASE, PricingAdjustmentType.PERCENT_DISCOUNT)
        fixed_types = (PricingAdjustmentType.FIXED_INCREASE, PricingAdjustmentType.FIXED_DISCOUNT)
        if adj_type in percent_types and adj_value is not None and adj_value > 100:
            raise serializers.ValidationError({"adjustment_value": "A percentage cannot exceed 100%."})
        # Amount / percentage adjustments must be greater than 0.
        if adj_type in (percent_types + fixed_types) and (adj_value is None or adj_value <= 0):
            raise serializers.ValidationError({"adjustment_value": "Enter a value greater than 0."})

        if adj_type == PricingAdjustmentType.OVERRIDE and adj_value is not None and adj_value < 0:
            raise serializers.ValidationError({"adjustment_value": "Override price cannot be negative."})

        if rule_type == PricingRuleType.PEAK_HOUR and not (start_time and end_time):
            raise serializers.ValidationError(
                {"start_time": "Peak hour pricing requires a start and end time."}
            )

        if rule_type in (PricingRuleType.DATE_RANGE, PricingRuleType.PROMO) and not (valid_from and valid_to):
            raise serializers.ValidationError(
                {"valid_from": "Date range / promo pricing requires Valid From and Valid To."}
            )

        # At least one target or condition must be present (no blanket rules).
        # Validity (valid_from/valid_to) is mandatory on every rule, so it does not
        # count as the distinguishing scope - a real target or day/time condition
        # is still required.
        targets = [
            attrs.get("categories"), attrs.get("facility_types"), attrs.get("addons"),
            attrs.get("clubs"), attrs.get("membership_plans"),
            attrs.get("customer_types"),
            attrs.get("days_of_week"), start_time, end_time,
            attrs.get("min_amount"), attrs.get("min_quantity"),
        ]
        if self.instance is None and not any(targets):
            raise serializers.ValidationError(
                "Select at least one target or condition (category, facility type, "
                "add-on, club, customer type, membership, days, date range, time "
                "range or a minimum threshold)."
            )
        return attrs
