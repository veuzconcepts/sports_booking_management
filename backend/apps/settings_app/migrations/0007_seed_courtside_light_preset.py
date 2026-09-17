"""A light theme taken from the customer website's own palette.

The public site is a warm off-white page with a deep, near-black green and a
lime accent. Until now an operator could match their website's branding only by
picking each colour by hand. This ships that combination as a preset so the
admin panel can be put in step with the site in one click.

Like every preset it stores only what differs from the shipped default, and
applying it copies the tokens onto `Organization.theme`, which remains the one
thing that decides how the application looks.
"""

from django.db import migrations

NAME = "Courtside Light"

TOKENS = {
    # Brand: deep green through near-black, exactly as the website reads it.
    "primary": "#15402c",
    "primaryHover": "#0b1f17",
    "secondary": "#1f5a3d",
    "accent": "#cff56a",

    # Chrome. The header carries the near-black green; the side navigation stays
    # white so the page feels light rather than heavy on both edges.
    "headerBg": "#0b1f17",
    "headerText": "#f4f7f2",
    "sidebarBg": "#ffffff",
    "sidebarText": "#3a473f",
    "sidebarHoverBg": "#f2efe6",
    "sidebarActiveBg": "#eaf6d8",
    "sidebarActiveText": "#15402c",
    "submenuBg": "#faf9f4",

    # Surfaces: a warm off-white page, white cards, warm borders. A cold grey
    # here is what makes an off-white design look like a mistake.
    "pageBg": "#f7f5ef",
    "cardBg": "#ffffff",
    "borderColor": "#e3dfd2",
    "textPrimary": "#0b1f17",
    "textSecondary": "#5f6d64",

    # Controls.
    "buttonPrimaryBg": "#15402c",
    "buttonPrimaryText": "#ffffff",
    "buttonPrimaryHover": "#0b1f17",
    "inputFocus": "#1f5a3d",
    "linkColor": "#15402c",
    "linkHoverColor": "#0b1f17",

    # Tables pick up the same warm tint, and a selected row uses the lime so the
    # accent appears somewhere other than a button.
    "tableHeaderBg": "#f2efe6",
    "tableRowHover": "#f7f5ef",
    "tableRowSelected": "#eaf6d8",
}


def seed(apps, schema_editor):
    ThemePreset = apps.get_model("settings_app", "ThemePreset")
    ThemePreset.objects.update_or_create(
        name=NAME,
        defaults={"tokens": TOKENS, "is_builtin": True, "display_order": 60},
    )


def unseed(apps, schema_editor):
    ThemePreset = apps.get_model("settings_app", "ThemePreset")
    ThemePreset.objects.filter(name=NAME, is_builtin=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("settings_app", "0006_seed_theme_presets"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
