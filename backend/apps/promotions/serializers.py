from rest_framework import serializers

from apps.facilities.models import AddOn, FacilityCategory, FacilityType

from .models import PromoCode, PromoRedemption


class PromoCodeSerializer(serializers.ModelSerializer):
    status = serializers.CharField(read_only=True)
    remaining = serializers.IntegerField(read_only=True)
    categories = serializers.PrimaryKeyRelatedField(many=True, required=False, queryset=FacilityCategory.objects.all())
    services = serializers.PrimaryKeyRelatedField(many=True, required=False, queryset=FacilityType.objects.all())
    addons = serializers.PrimaryKeyRelatedField(many=True, required=False, queryset=AddOn.objects.all())
    category_names = serializers.SerializerMethodField()
    facility_category_names = serializers.SerializerMethodField()
    addon_names = serializers.SerializerMethodField()

    class Meta:
        model = PromoCode
        fields = (
            "id", "code", "description",
            "discount_type", "discount_value", "max_discount_amount", "min_order_amount", "currency",
            "valid_from", "valid_to",
            "usage_limit", "usage_limit_per_customer", "used_count", "remaining",
            "first_order_only", "is_active",
            "applies_to",
            "categories", "category_names",
            "services", "facility_category_names",
            "addons", "addon_names",
            "batch", "status", "created_at", "updated_at",
        )
        read_only_fields = ("id", "used_count", "remaining", "batch", "status", "created_at", "updated_at",
                            "category_names", "facility_category_names", "addon_names")

    def get_category_names(self, obj):
        return [c.name for c in obj.categories.all()]

    def get_facility_category_names(self, obj):
        return [s.name for s in obj.services.all()]

    def get_addon_names(self, obj):
        return [a.name for a in obj.addons.all()]

    def validate_code(self, value):
        return (value or "").strip().upper()

    def validate(self, attrs):
        def eff(field):
            return attrs[field] if field in attrs else getattr(self.instance, field, None)

        dtype = eff("discount_type")
        value = eff("discount_value")
        if value is not None and value <= 0:
            raise serializers.ValidationError({"discount_value": "Enter a value greater than 0."})
        if dtype == PromoCode.DiscountType.PERCENT and value is not None and value > 100:
            raise serializers.ValidationError({"discount_value": "Percentage cannot exceed 100%."})

        vf, vt = eff("valid_from"), eff("valid_to")
        if vf and vt and vf > vt:
            raise serializers.ValidationError({"valid_to": "Valid To must be after Valid From."})

        # A specific scope must select at least one item.
        scope_field = {"category": "categories", "package": "services", "addon": "addons"}.get(eff("applies_to"))
        if scope_field:
            provided = attrs.get(scope_field)
            if provided is not None:
                if len(provided) == 0:
                    raise serializers.ValidationError({scope_field: "Select at least one for the chosen scope."})
            elif self.instance is None or not getattr(self.instance, scope_field).exists():
                raise serializers.ValidationError({scope_field: "Select at least one for the chosen scope."})
        return attrs


class PromoRedemptionSerializer(serializers.ModelSerializer):
    customer_name = serializers.SerializerMethodField()
    booking_reference = serializers.CharField(source="booking.reference", read_only=True, default=None)

    class Meta:
        model = PromoRedemption
        fields = ("id", "customer", "customer_name", "user", "booking", "booking_reference",
                  "discount_amount", "created_at")

    def get_customer_name(self, obj):
        if obj.customer:
            return obj.customer.full_name or obj.customer.email or "-"
        if obj.user:
            return obj.user.get_full_name() or obj.user.email
        return "-"


class BulkPromoSerializer(serializers.Serializer):
    """Shared settings + generation params for a bulk run."""
    quantity = serializers.IntegerField(min_value=1, max_value=1000)
    prefix = serializers.CharField(max_length=20, required=False, allow_blank=True, default="")
    code_length = serializers.IntegerField(min_value=4, max_value=16, required=False, default=6)
