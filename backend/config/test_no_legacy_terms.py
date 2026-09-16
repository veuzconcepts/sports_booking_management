"""Guard: the CarWash domain must never reappear in the active codebase.

This scans the project's own source (backend apps + config, the admin SPA and
the customer website) for the terminology of the product this codebase was
converted from. It is deliberately a test, not a lint rule, so a regression
fails CI rather than being noticed in review.
"""

import re
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
PROJECT = BACKEND.parent

SCAN_ROOTS = [
    BACKEND / "apps",
    BACKEND / "config",
    PROJECT / "frontend" / "src",
    PROJECT / "web" / "src",
]

SCAN_SUFFIXES = {".py", ".js", ".jsx", ".ts", ".tsx", ".astro", ".css", ".html", ".md"}

SKIP_DIRS = {"__pycache__", "node_modules", "dist", ".astro", "migrations"}

# Whole-word patterns. `bay` and `site` are excluded from the word list because
# "website"/"admin site" are legitimate; those are checked separately below.
BANNED = [
    r"car\s?wash",
    r"carwash",
    # "car care" slipped through the wash patterns and shipped in a UI placeholder.
    r"car\s?care",
    r"\bwash(es|ing|er)?\b",
    r"\bvehicles?\b",
    r"\bjob\s?cards?\b",
    r"\bjobcards?\b",
    r"\bdrive[-_\s]?in\b",
    r"\bdetailing\b",
    r"\bdeep\s?clean\b",
    r"\bcrews?\b",
    r"\bplate[_\s]?numbers?\b",
    r"\bbay[_\s]?(label|operator)\b",
    r"\bapp[_\s]?(ios|android|store_url)\b",
    r"\bplay[_\s]?store[_\s]?url\b",
]
BANNED_RX = re.compile("|".join(BANNED), re.IGNORECASE)

# This guard file necessarily contains the words it bans.
SELF = Path(__file__).resolve()

# A line may opt out when it asserts the ABSENCE of a legacy term (other guard
# tests do exactly that). Nothing else should ever carry this marker.
ALLOW_MARKER = "legacy-term-guard: allow"


def _source_files():
    for root in SCAN_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in SCAN_SUFFIXES:
                continue
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            if path.resolve() == SELF:
                continue
            yield path


def test_scan_actually_covers_the_project():
    """Guard the guard: if the globbing breaks, the test must not pass silently."""
    files = list(_source_files())
    assert len(files) > 100, f"only found {len(files)} source files to scan"


def test_no_carwash_terminology_in_source():
    offenders = []
    for path in _source_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if ALLOW_MARKER in line:
                continue
            match = BANNED_RX.search(line)
            if match:
                rel = path.relative_to(PROJECT)
                offenders.append(f"{rel}:{lineno}: {match.group(0)!r} in {line.strip()[:90]}")

    assert not offenders, "Legacy CarWash terminology found:\n" + "\n".join(offenders[:40])


def test_removed_apps_are_not_installed():
    from django.conf import settings
    for app in ("apps.vehicles", "apps.jobcards", "apps.mobile_app", "apps.services"):
        assert app not in settings.INSTALLED_APPS, app


def test_new_domain_apps_are_installed():
    from django.conf import settings
    for app in ("apps.clubs", "apps.facilities"):
        assert app in settings.INSTALLED_APPS, app


def test_project_metadata_is_rebranded():
    from django.conf import settings
    assert "Club" in settings.SPECTACULAR_SETTINGS["TITLE"]
    assert not settings.AUTH_COOKIE_ACCESS.startswith("cw_")


@pytest.mark.django_db
def test_every_url_name_is_domain_neutral():
    from django.urls import get_resolver
    names = [n for n in get_resolver().reverse_dict.keys() if isinstance(n, str)]
    assert names, "no named URLs resolved"
    for name in names:
        assert not BANNED_RX.search(name.replace("-", " ")), name
