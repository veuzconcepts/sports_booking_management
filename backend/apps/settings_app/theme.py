"""The organization theme: one token contract, shared by every consumer.

The admin SPA, the login screen and the customer website all read their colours
from the same set of names. That set is defined here, on the backend, because
it is the thing a stored theme is validated against: a token the catalogue does
not know is rejected rather than written through to a stylesheet.

A theme is stored as `{token: "#rrggbb"}` holding only what differs from
`DEFAULTS`. Resolving is therefore `DEFAULTS | stored`, which means a token
added here later gets a sensible value on every existing organization without a
data migration, and a stored theme can never leave the interface half-styled.
"""

from __future__ import annotations

import re

# --------------------------------------------------------------------------- #
# The catalogue                                                                #
# --------------------------------------------------------------------------- #
# (token, group, label) - the group and label drive the settings UI so the
# backend stays the single source of truth for what is configurable.
TOKENS: list[tuple[str, str, str]] = [
    # Brand
    ("primary", "brand", "Primary colour"),
    ("primaryHover", "brand", "Primary hover"),
    ("secondary", "brand", "Secondary colour"),
    ("accent", "brand", "Accent colour"),
    # Status. Semantic, but configurable because house styles differ.
    ("success", "status", "Success"),
    ("warning", "status", "Warning"),
    ("danger", "status", "Danger"),
    ("info", "status", "Info"),
    # Navigation
    ("sidebarBg", "navigation", "Sidebar background"),
    ("sidebarText", "navigation", "Sidebar text"),
    ("sidebarHoverBg", "navigation", "Sidebar hover background"),
    ("sidebarActiveBg", "navigation", "Sidebar active background"),
    ("sidebarActiveText", "navigation", "Sidebar active text"),
    ("submenuBg", "navigation", "Submenu background"),
    ("headerBg", "navigation", "Header background"),
    ("headerText", "navigation", "Header text"),
    # Content
    ("pageBg", "content", "Page background"),
    ("cardBg", "content", "Card background"),
    ("borderColor", "content", "Border"),
    ("textPrimary", "content", "Main text"),
    ("textSecondary", "content", "Secondary text"),
    # Components
    ("buttonPrimaryBg", "components", "Primary button background"),
    ("buttonPrimaryText", "components", "Primary button text"),
    ("buttonPrimaryHover", "components", "Primary button hover"),
    ("inputFocus", "components", "Input focus"),
    ("linkColor", "components", "Link"),
    ("linkHoverColor", "components", "Link hover"),
    ("tableHeaderBg", "components", "Table header background"),
    ("tableRowHover", "components", "Table row hover"),
    ("tableRowSelected", "components", "Selected row"),
]

TOKEN_NAMES = [name for name, _group, _label in TOKENS]

GROUP_LABELS = {
    "brand": "Brand",
    "status": "Status",
    "navigation": "Navigation",
    "content": "Content",
    "components": "Components",
}

# The system default: the palette the product ships with. Anything a theme does
# not override falls back to these, so the interface is never unusable.
DEFAULTS: dict[str, str] = {
    "primary": "#6f4a9e",
    "primaryHover": "#593c80",
    "secondary": "#201b50",
    "accent": "#e0b43a",

    "success": "#059669",
    "warning": "#d97706",
    "danger": "#dc2626",
    "info": "#4f46b5",

    "sidebarBg": "#ffffff",
    "sidebarText": "#1c1a36",
    "sidebarHoverBg": "#efeef6",
    "sidebarActiveBg": "#ece2f6",
    "sidebarActiveText": "#593c80",
    "submenuBg": "#eef1f8",
    "headerBg": "#201b50",
    "headerText": "#ffffff",

    "pageBg": "#f6f6fb",
    "cardBg": "#ffffff",
    "borderColor": "#e4e2ee",
    "textPrimary": "#1c1a36",
    "textSecondary": "#6b6a85",

    "buttonPrimaryBg": "#6f4a9e",
    "buttonPrimaryText": "#ffffff",
    "buttonPrimaryHover": "#593c80",
    "inputFocus": "#8460b4",
    "linkColor": "#6f4a9e",
    "linkHoverColor": "#593c80",
    "tableHeaderBg": "#fafbfd",
    "tableRowHover": "#f5f1fa",
    "tableRowSelected": "#ece2f6",
}

# Corner style is not a colour, so it is validated separately.
CORNER_STYLES = {
    "square": {"sm": "2px", "md": "3px", "lg": "4px", "xl": "6px"},
    "soft": {"sm": "6px", "md": "10px", "lg": "14px", "xl": "20px"},
    "rounded": {"sm": "10px", "md": "16px", "lg": "22px", "xl": "28px"},
}
DEFAULT_CORNER_STYLE = "soft"

HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


class ThemeError(ValueError):
    """A stored or submitted theme that cannot be trusted to render."""


def normalise_colour(value: str) -> str:
    """`#ABC` and `#aabbcc` both become the canonical lowercase six-digit form."""
    if not isinstance(value, str):
        raise ThemeError("A colour must be a hex string, for example #2563eb.")
    value = value.strip()
    if not HEX.match(value):
        raise ThemeError(f"{value!r} is not a valid hex colour, for example #2563eb.")
    value = value.lower()
    if len(value) == 4:                       # #abc -> #aabbcc
        value = "#" + "".join(c * 2 for c in value[1:])
    return value


def clean(raw: dict | None) -> dict:
    """Validate a submitted theme down to the tokens we actually publish.

    Unknown keys are rejected rather than ignored: silently dropping them would
    let an administrator believe a setting had been saved. Tokens equal to the
    default are dropped, so a stored theme only ever holds real differences.
    """
    if raw in (None, ""):
        return {}
    if not isinstance(raw, dict):
        raise ThemeError("The theme must be an object of token names to colours.")

    corner = raw.get("cornerStyle", DEFAULT_CORNER_STYLE)
    if corner not in CORNER_STYLES:
        raise ThemeError(
            "Corner style must be one of: " + ", ".join(sorted(CORNER_STYLES)) + ".")

    unknown = sorted(set(raw) - set(TOKEN_NAMES) - {"cornerStyle"})
    if unknown:
        raise ThemeError("Unknown theme setting: " + ", ".join(unknown) + ".")

    out: dict[str, str] = {}
    for name in TOKEN_NAMES:
        if name not in raw:
            continue
        value = normalise_colour(raw[name])
        if value != DEFAULTS[name]:
            out[name] = value
    if corner != DEFAULT_CORNER_STYLE:
        out["cornerStyle"] = corner
    return out


def resolve(stored: dict | None) -> dict:
    """The complete theme a client should render: defaults under the overrides.

    A stored value that no longer validates is discarded rather than raised:
    bad branding data must never take the application down.
    """
    resolved = dict(DEFAULTS)
    resolved["cornerStyle"] = DEFAULT_CORNER_STYLE
    if not isinstance(stored, dict):
        return resolved
    for name, value in stored.items():
        if name == "cornerStyle":
            if value in CORNER_STYLES:
                resolved["cornerStyle"] = value
            continue
        if name not in DEFAULTS:
            continue
        try:
            resolved[name] = normalise_colour(value)
        except ThemeError:
            continue                          # keep the default for that token
    return resolved


def catalogue() -> list[dict]:
    """What the settings screen renders: one entry per configurable token."""
    return [
        {"token": name, "group": group, "label": label, "default": DEFAULTS[name]}
        for name, group, label in TOKENS
    ]


# --------------------------------------------------------------------------- #
# Contrast                                                                     #
# --------------------------------------------------------------------------- #
def _channel(value: float) -> float:
    value /= 255
    return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4


def relative_luminance(hex_colour: str) -> float:
    c = normalise_colour(hex_colour)
    r, g, b = (int(c[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def contrast_ratio(a: str, b: str) -> float:
    """WCAG 2.1 contrast ratio, 1.0 (identical) to 21.0 (black on white)."""
    la, lb = relative_luminance(a), relative_luminance(b)
    lighter, darker = max(la, lb), min(la, lb)
    return round((lighter + 0.05) / (darker + 0.05), 2)


def readable_text_on(background: str) -> str:
    """Whichever of near-black or white is legible on this background."""
    return "#1c1a36" if contrast_ratio(background, "#1c1a36") >= contrast_ratio(
        background, "#ffffff") else "#ffffff"


# Pairs that decide whether the interface can actually be read. Each is
# (foreground token, background token, label, minimum ratio). 4.5 is the WCAG AA
# threshold for body text; 3.0 is the large-text and UI-component threshold.
CONTRAST_PAIRS = [
    ("sidebarText", "sidebarBg", "Sidebar text on sidebar background", 4.5),
    ("sidebarActiveText", "sidebarActiveBg", "Active navigation item", 4.5),
    ("headerText", "headerBg", "Header text on header background", 4.5),
    ("buttonPrimaryText", "buttonPrimaryBg", "Primary button label", 4.5),
    ("textPrimary", "cardBg", "Main text on a card", 4.5),
    ("textSecondary", "cardBg", "Secondary text on a card", 4.5),
    ("textPrimary", "pageBg", "Main text on the page background", 4.5),
    ("linkColor", "cardBg", "Link on a card", 4.5),
    ("primary", "cardBg", "Brand colour against a card", 3.0),
]


def contrast_report(theme: dict | None) -> list[dict]:
    """Every pair that matters, with the ratio and a safer suggestion.

    Reported rather than enforced: an administrator may have a reason, and the
    warning plus a one-click fix is more useful than a refusal they cannot
    argue with.
    """
    resolved = resolve(theme)
    out = []
    for fg, bg, label, minimum in CONTRAST_PAIRS:
        ratio = contrast_ratio(resolved[fg], resolved[bg])
        entry = {
            "foreground": fg,
            "background": bg,
            "label": label,
            "ratio": ratio,
            "minimum": minimum,
            "passes": ratio >= minimum,
        }
        if not entry["passes"]:
            entry["suggestion"] = readable_text_on(resolved[bg])
        out.append(entry)
    return out
