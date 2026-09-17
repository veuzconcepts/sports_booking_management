from rest_framework import serializers

from .models import LoyaltyConfiguration, LoyaltyTier


class LoyaltyConfigurationSerializer(serializers.ModelSerializer):
    class Meta:
        model = LoyaltyConfiguration
        fields = (
            "earning_enabled", "earn_trigger", "points_per_currency",
            "fixed_points_per_booking", "service_bonuses", "package_bonuses",
            "membership_bonuses",
            "redemption_enabled", "currency_per_point", "min_redeem_points",
            "max_redeem_points_per_booking", "max_redeem_percent",
            "stack_with_promo", "stack_with_membership",
            "expiry_months", "updated_at",
        )
        read_only_fields = ("updated_at",)


class LoyaltyTierSerializer(serializers.ModelSerializer):
    class Meta:
        model = LoyaltyTier
        fields = (
            "id", "name", "slug", "rank", "min_points", "min_spend",
            "discount_percent", "priority_booking", "benefits", "color", "is_active",
        )
        read_only_fields = ("id",)
