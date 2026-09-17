"""Seed the shipped theme presets.

A preset stores only what differs from the system default, exactly like a saved
organization theme, so both go through the same resolver.
"""

from django.db import migrations

PRESETS = [
    ("Default", 10, {}),
    ("Professional Blue", 20, {
        "primary": "#2563eb",
        "primaryHover": "#1d4ed8",
        "secondary": "#1e293b",
        "accent": "#0ea5e9",
        "sidebarActiveBg": "#dbeafe",
        "sidebarActiveText": "#1d4ed8",
        "submenuBg": "#eef2ff",
        "headerBg": "#1e293b",
        "buttonPrimaryBg": "#2563eb",
        "buttonPrimaryHover": "#1d4ed8",
        "inputFocus": "#3b82f6",
        "linkColor": "#2563eb",
        "linkHoverColor": "#1d4ed8",
        "tableRowHover": "#eff6ff",
        "tableRowSelected": "#dbeafe",
    }),
    ("Modern Green", 30, {
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
    }),
    ("Midnight", 40, {
        "primary": "#818cf8",
        "primaryHover": "#a5b4fc",
        "secondary": "#0f172a",
        "accent": "#38bdf8",
        "sidebarBg": "#111827",
        "sidebarText": "#e5e7eb",
        "sidebarHoverBg": "#1f2937",
        "sidebarActiveBg": "#312e81",
        "sidebarActiveText": "#e0e7ff",
        "submenuBg": "#0b1220",
        "headerBg": "#0b1220",
        "headerText": "#f8fafc",
        "pageBg": "#0f172a",
        "cardBg": "#1e293b",
        "borderColor": "#334155",
        "textPrimary": "#f1f5f9",
        "textSecondary": "#94a3b8",
        "buttonPrimaryBg": "#4f46e5",
        "buttonPrimaryText": "#ffffff",
        "buttonPrimaryHover": "#4338ca",
        "inputFocus": "#818cf8",
        "linkColor": "#a5b4fc",
        "linkHoverColor": "#c7d2fe",
        "tableHeaderBg": "#182234",
        "tableRowHover": "#243247",
        "tableRowSelected": "#312e81",
    }),
    ("Minimal Light", 50, {
        "primary": "#111827",
        "primaryHover": "#000000",
        "secondary": "#374151",
        "accent": "#6b7280",
        "sidebarBg": "#ffffff",
        "sidebarHoverBg": "#f3f4f6",
        "sidebarActiveBg": "#f3f4f6",
        "sidebarActiveText": "#111827",
        "submenuBg": "#fafafa",
        "headerBg": "#111827",
        "pageBg": "#fafafa",
        "borderColor": "#e5e7eb",
        "buttonPrimaryBg": "#111827",
        "buttonPrimaryHover": "#000000",
        "inputFocus": "#6b7280",
        "linkColor": "#111827",
        "linkHoverColor": "#000000",
        "tableHeaderBg": "#f9fafb",
        "tableRowHover": "#f9fafb",
        "tableRowSelected": "#f3f4f6",
    }),
]


def seed(apps, schema_editor):
    ThemePreset = apps.get_model("settings_app", "ThemePreset")
    for name, order, tokens in PRESETS:
        ThemePreset.objects.update_or_create(
            name=name,
            defaults={"tokens": tokens, "is_builtin": True, "display_order": order},
        )


def unseed(apps, schema_editor):
    ThemePreset = apps.get_model("settings_app", "ThemePreset")
    ThemePreset.objects.filter(
        name__in=[name for name, _order, _tokens in PRESETS], is_builtin=True
    ).delete()


class Migration(migrations.Migration):

    dependencies = [("settings_app", "0005_theme_and_presets")]

    operations = [migrations.RunPython(seed, unseed)]
