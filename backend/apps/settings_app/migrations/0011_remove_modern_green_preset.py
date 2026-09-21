"""Withdraw the Modern Green preset.

Removed at the operator's request. Safe to delete because a preset is never
what renders: applying one copies its tokens onto `Organization.theme`, which
stays the single source of truth, so an organization that had already applied
this keeps exactly the colours it has. Only the name of the starting point
would be gone, and `theme_preset_name` is a label rather than a lookup.

`is_builtin=True` is part of the filter deliberately: an operator may have
duplicated this preset and renamed the copy, and their own saved theme is
theirs to keep.

Reversing re-seeds the original tokens, copied from `0006_seed_theme_presets`
so a rollback restores the preset exactly as it shipped rather than an
approximation of it.
"""

from django.db import migrations

NAME = "Modern Green"

# Verbatim from 0006, so `migrate settings_app 0010` puts back what was there.
TOKENS = {
    "primary": "#0f766e",
    "primaryHover": "#115e59",
    "secondary": "#134e4a",
    "accent": "#84cc16",
    "sidebarActiveBg": "#ccfbf1",
    "sidebarActiveText": "#115e59",
    "submenuBg": "#ecfdf5",
    "headerBg": "#134e4a",
    "buttonPrimaryBg": "#0f766e",
    "buttonPrimaryHover": "#115e59",
    "inputFocus": "#14b8a6",
    "linkColor": "#0f766e",
    "linkHoverColor": "#115e59",
    "tableRowHover": "#f0fdfa",
    "tableRowSelected": "#ccfbf1",
}


def remove(apps, schema_editor):
    ThemePreset = apps.get_model("settings_app", "ThemePreset")
    ThemePreset.objects.filter(name=NAME, is_builtin=True).delete()


def restore(apps, schema_editor):
    ThemePreset = apps.get_model("settings_app", "ThemePreset")
    ThemePreset.objects.update_or_create(
        name=NAME,
        defaults={"tokens": TOKENS, "is_builtin": True, "display_order": 30},
    )


class Migration(migrations.Migration):

    dependencies = [
        ("settings_app", "0010_seed_veuz_teal_preset"),
    ]

    operations = [
        migrations.RunPython(remove, restore),
    ]
