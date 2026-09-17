"""Seed the four default loyalty tiers so existing `customer.loyalty_tier`
strings (bronze/silver/gold/platinum) map to real tier rows. Thresholds are
sensible defaults the admin can edit; auto-tiering only runs once earning is
enabled, so this changes nothing until configured."""

from decimal import Decimal

from django.db import migrations

_TIERS = [
    # slug, name, rank, min_points, min_spend
    ("bronze", "Bronze", 0, None, None),
    ("silver", "Silver", 1, 1000, None),
    ("gold", "Gold", 2, None, Decimal("3000")),
    ("platinum", "Platinum", 3, 5000, Decimal("10000")),
]


def seed(apps, schema_editor):
    LoyaltyTier = apps.get_model("loyalty", "LoyaltyTier")
    for slug, name, rank, min_points, min_spend in _TIERS:
        LoyaltyTier.objects.get_or_create(
            slug=slug,
            defaults={"name": name, "rank": rank, "min_points": min_points,
                      "min_spend": min_spend, "is_active": True},
        )


def unseed(apps, schema_editor):
    LoyaltyTier = apps.get_model("loyalty", "LoyaltyTier")
    LoyaltyTier.objects.filter(slug__in=[t[0] for t in _TIERS]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("loyalty", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
