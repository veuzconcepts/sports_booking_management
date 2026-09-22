"""A preset taken from the Veuz brand palette.

Deep petrol teal, a bright leaf green and a clear mid blue over a very light
mint page: the combination the company's own print and social material uses.
An operator could reach it before only by setting thirty colours by hand.

Every value was checked against `theme.contrast_report` before being written
here rather than picked to look right on one screen. The obvious green for a
primary button (the bright leaf green of the artwork) fails AA against white
text at 3.3:1, so the button carries a deeper green and the bright one is the
accent, where it sits on light surfaces and has no text to carry.

Like every preset this stores only what differs from the shipped default, and
applying it copies the tokens onto `Organization.theme`, which remains the one
thing that decides how the application looks.
"""

from django.db import migrations

NAME = "Veuz Teal"

TOKENS = {
    # Brand: petrol teal, with the blue and green of the logo gradient behind
    # it as secondary and accent.
    "primary": "#0f4c4c",
    "primaryHover": "#0a3a3a",
    "secondary": "#1b8fbf",
    "accent": "#5cb335",

    # Status. Nudged towards the palette so a success message belongs to the
    # same design instead of arriving from a different one.
    "success": "#2f8f3f",
    "warning": "#c98a10",
    "danger": "#c2352b",
    "info": "#1b8fbf",

    # Chrome. The header takes the teal, the side navigation stays white: the
    # artwork is light with one deep band across it, not dark on both edges.
    "headerBg": "#0f4c4c",
    "headerText": "#eaf6f2",
    "sidebarBg": "#ffffff",
    "sidebarText": "#3d5450",
    "sidebarHoverBg": "#eef6f3",
    "sidebarActiveBg": "#e3f3ea",
    "sidebarActiveText": "#0f4c4c",
    "submenuBg": "#f6fbf9",

    # Surfaces. A mint-tinted page rather than a cold grey one, which is what
    # keeps the teal reading as deliberate instead of accidental.
    "pageBg": "#f3f8f5",
    "cardBg": "#ffffff",
    "borderColor": "#dce9e3",
    "textPrimary": "#0f3330",
    "textSecondary": "#5a706b",

    # Controls. The green button is the poster's call to action, darkened
    # until white text on it clears AA (5.10:1).
    "buttonPrimaryBg": "#2f7d3a",
    "buttonPrimaryText": "#ffffff",
    "buttonPrimaryHover": "#256630",
    "inputFocus": "#1b8fbf",
    "linkColor": "#0f6f6a",
    "linkHoverColor": "#0a3a3a",

    # Tables share the page tint, and a selected row uses the pale green so the
    # accent family appears somewhere other than a button.
    "tableHeaderBg": "#eef6f3",
    "tableRowHover": "#f3f8f5",
    "tableRowSelected": "#e3f3ea",
}


def seed(apps, schema_editor):
    ThemePreset = apps.get_model("settings_app", "ThemePreset")
    ThemePreset.objects.update_or_create(
        name=NAME,
        defaults={"tokens": TOKENS, "is_builtin": True, "display_order": 70},
    )


def unseed(apps, schema_editor):
    ThemePreset = apps.get_model("settings_app", "ThemePreset")
    ThemePreset.objects.filter(name=NAME, is_builtin=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("settings_app", "0009_organization_show_hold_countdown"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
