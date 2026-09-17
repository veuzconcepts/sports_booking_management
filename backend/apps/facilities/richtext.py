"""HTML sanitisation for rich-text catalogue fields (category Description,
facility type "What's Included"). Editors produce HTML; we store a safe allow-listed
subset so the website can render it without an XSS risk."""

import bleach

ALLOWED_TAGS = [
    "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s",
    "ul", "ol", "li", "blockquote",
    "h2", "h3", "h4", "a",
]
ALLOWED_ATTRS = {
    "a": ["href", "title", "target", "rel"],
}
ALLOWED_PROTOCOLS = ["http", "https", "mailto", "tel"]


def clean_html(value: str) -> str:
    """Return a sanitised copy of `value` (safe tags only; scripts/styles/event
    handlers stripped). Empty / falsy input returns ''."""
    if not value:
        return ""
    return bleach.clean(
        value,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        protocols=ALLOWED_PROTOCOLS,
        strip=True,
    )
