"""Seed the Currency master from the bundled currency catalogue.

Idempotent: uses get_or_create so re-running (or running after a manual edit)
never clobbers admin-customised rows. Reverse is a no-op (keep the data).
"""

from decimal import Decimal

from django.db import migrations


def seed_currencies(apps, schema_editor):
    Currency = apps.get_model("settings_app", "Currency")
    from apps.settings_app.currency import CURRENCIES

    for c in CURRENCIES:
        Currency.objects.get_or_create(
            code=c["code"],
            defaults={
                "name": c["label"],
                "symbol": c["symbol"],
                "precision": c["decimals"],
                "extended_precision": c["extended_precision"],
                "minimum_accountable_unit": Decimal(str(c["min_accountable_unit"])),
                "rounding_method": c["rounding_method"],
                "is_active": True,
            },
        )


def unseed(apps, schema_editor):
    # No-op: keep currency configuration on reverse.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("settings_app", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_currencies, unseed),
    ]
