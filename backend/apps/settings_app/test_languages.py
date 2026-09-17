"""Language configuration: the catalogue, the default, and user preference.

Language SELECTION is a frontend concern, but which languages exist, which one
is the default and whether a user may choose one are decided here. A broken
configuration must never leave the application with no usable language.
"""

import pytest

from apps.settings_app.models import Language


@pytest.fixture
def languages(db):
    """The seeded pair, reset to a known state for each test."""
    Language.objects.all().delete()
    english = Language.objects.create(
        code="en", locale="en", name="English", native_name="English",
        direction="ltr", is_enabled=True, is_default=True, display_order=1)
    arabic = Language.objects.create(
        code="ar", locale="ar", name="Arabic", native_name="العربية",
        direction="rtl", is_enabled=False, is_default=False, display_order=2)
    return english, arabic


# --------------------------------------------------------------------------- #
# The model's own guarantees
# --------------------------------------------------------------------------- #
def test_a_fresh_install_has_a_usable_default(db):
    """Seeded by migration: the application can never start with no language."""
    assert Language.objects.filter(code="en", is_default=True, is_enabled=True).exists()


def test_only_one_language_can_be_the_default(languages):
    english, arabic = languages
    arabic.is_default = True
    with pytest.raises(Exception):          # partial unique constraint
        arabic.save()


def test_the_default_cannot_be_disabled(languages):
    from django.core.exceptions import ValidationError

    english, _ = languages
    english.is_enabled = False
    with pytest.raises(ValidationError):
        english.full_clean()


def test_resolve_prefers_an_enabled_language(languages):
    _, arabic = languages
    arabic.is_enabled = True
    arabic.save()
    assert Language.resolve("ar") == "ar"


def test_resolve_falls_back_when_a_language_is_disabled(languages):
    """Someone whose language was turned off gets the default, not a dead UI."""
    assert Language.resolve("ar") == "en"


def test_resolve_matches_the_base_of_a_regional_tag(languages):
    assert Language.resolve("en-GB") == "en"


def test_resolve_falls_back_for_an_unknown_language(languages):
    assert Language.resolve("fr") == "en"


def test_resolve_handles_nothing_requested(languages):
    assert Language.resolve(None) == "en"
    assert Language.resolve("") == "en"


def test_the_effective_locale_falls_back_to_the_code(db):
    language = Language.objects.create(
        code="fr", name="French", native_name="Français", locale="")
    assert language.effective_locale == "fr"


# --------------------------------------------------------------------------- #
# The public catalogue: readable before anyone signs in
# --------------------------------------------------------------------------- #
def test_the_public_list_needs_no_authentication(api, languages):
    """The sign-in page must render in the right language before there is a user."""
    resp = api.get("/api/v1/settings/languages/public/")
    assert resp.status_code == 200


def test_the_public_list_shows_only_enabled_languages(api, languages):
    body = api.get("/api/v1/settings/languages/public/").json()
    assert [l["code"] for l in body["languages"]] == ["en"]
    assert body["default"] == "en"


def test_enabling_a_language_makes_it_publicly_offered(api, languages):
    _, arabic = languages
    arabic.is_enabled = True
    arabic.save()

    body = api.get("/api/v1/settings/languages/public/").json()
    codes = [l["code"] for l in body["languages"]]
    assert codes == ["en", "ar"]                # display order respected
    assert next(l for l in body["languages"] if l["code"] == "ar")["direction"] == "rtl"


def test_the_public_list_does_not_leak_the_admin_record(api, languages):
    body = api.get("/api/v1/settings/languages/public/").json()
    entry = body["languages"][0]
    # Only what a selector needs.
    assert set(entry) == {"code", "locale", "name", "native_name",
                          "direction", "is_default"}


# --------------------------------------------------------------------------- #
# Admin management
# --------------------------------------------------------------------------- #
def test_managing_languages_requires_authentication(api, languages):
    assert api.get("/api/v1/settings/languages/").status_code == 401


def test_an_admin_sees_every_language_including_disabled(auth_api, languages):
    body = auth_api.get("/api/v1/settings/languages/").json()
    assert {l["code"] for l in body["results"]} == {"en", "ar"}


def test_a_language_can_be_added(auth_api, languages):
    resp = auth_api.post("/api/v1/settings/languages/", {
        "code": "fr", "name": "French", "native_name": "Français",
        "direction": "ltr", "is_enabled": True, "display_order": 3,
    }, format="json")
    assert resp.status_code == 201, resp.content
    assert resp.json()["code"] == "fr"
    assert resp.json()["is_rtl"] is False


def test_an_invented_language_code_is_refused(auth_api, languages):
    resp = auth_api.post("/api/v1/settings/languages/", {
        "code": "not a code!", "name": "Nonsense", "native_name": "Nonsense",
    }, format="json")
    assert resp.status_code == 400
    assert "code" in resp.json()


def test_a_language_code_is_normalised(auth_api, languages):
    resp = auth_api.post("/api/v1/settings/languages/", {
        "code": "FR", "name": "French", "native_name": "Français",
    }, format="json")
    assert resp.status_code == 201
    assert resp.json()["code"] == "fr"


def test_a_duplicate_code_is_refused(auth_api, languages):
    resp = auth_api.post("/api/v1/settings/languages/", {
        "code": "en", "name": "English again", "native_name": "English",
    }, format="json")
    assert resp.status_code == 400


def test_the_default_cannot_be_disabled_through_the_api(auth_api, languages):
    english, _ = languages
    resp = auth_api.patch(f"/api/v1/settings/languages/{english.id}/",
                          {"is_enabled": False}, format="json")
    assert resp.status_code == 400
    assert "is_enabled" in resp.json()


def test_promoting_a_default_demotes_the_previous_one(auth_api, languages):
    english, arabic = languages
    resp = auth_api.post(f"/api/v1/settings/languages/{arabic.id}/make-default/")
    assert resp.status_code == 200

    english.refresh_from_db()
    arabic.refresh_from_db()
    assert arabic.is_default is True
    assert english.is_default is False
    # Promoting also enables, so the default is always usable.
    assert arabic.is_enabled is True


def test_the_default_language_cannot_be_deleted(auth_api, languages):
    english, _ = languages
    resp = auth_api.delete(f"/api/v1/settings/languages/{english.id}/")
    assert resp.status_code == 409
    assert Language.objects.filter(pk=english.pk).exists()


def test_a_non_default_language_can_be_deleted(auth_api, languages):
    _, arabic = languages
    assert auth_api.delete(
        f"/api/v1/settings/languages/{arabic.id}/").status_code == 204


def test_changing_a_language_is_audited(auth_api, languages, db):
    from apps.auditlogs.models import AuditLog

    _, arabic = languages
    auth_api.patch(f"/api/v1/settings/languages/{arabic.id}/",
                   {"is_enabled": True}, format="json")
    entry = AuditLog.objects.filter(
        payload_summary__event="language_changed").first()
    assert entry is not None
    assert entry.payload_summary["code"] == "ar"


# --------------------------------------------------------------------------- #
# The user's own preference
# --------------------------------------------------------------------------- #
def test_a_user_starts_with_no_preference(auth_api, languages):
    """Blank means "follow the organization default", so changing that default
    moves everyone who has not chosen for themselves."""
    assert auth_api.get("/api/v1/auth/me/").json()["language"] == ""


def test_a_user_can_choose_an_enabled_language(auth_api, languages):
    _, arabic = languages
    arabic.is_enabled = True
    arabic.save()

    resp = auth_api.patch("/api/v1/auth/me/", {"language": "ar"}, format="json")
    assert resp.status_code == 200
    assert resp.json()["language"] == "ar"


def test_a_user_cannot_choose_a_disabled_language(auth_api, languages):
    resp = auth_api.patch("/api/v1/auth/me/", {"language": "ar"}, format="json")
    assert resp.status_code == 400
    assert "language" in resp.json()


def test_a_user_cannot_choose_a_language_that_does_not_exist(auth_api, languages):
    resp = auth_api.patch("/api/v1/auth/me/", {"language": "fr"}, format="json")
    assert resp.status_code == 400


def test_a_user_can_clear_their_preference(auth_api, languages):
    _, arabic = languages
    arabic.is_enabled = True
    arabic.save()
    auth_api.patch("/api/v1/auth/me/", {"language": "ar"}, format="json")

    resp = auth_api.patch("/api/v1/auth/me/", {"language": ""}, format="json")
    assert resp.status_code == 200
    assert resp.json()["language"] == ""


def test_removing_a_language_leaves_the_user_row_intact(auth_api, languages, db):
    """No cascade: deleting a language must not delete or corrupt user records.
    The stale code simply resolves back to the default."""
    from apps.accounts.models import User

    _, arabic = languages
    arabic.is_enabled = True
    arabic.save()
    auth_api.patch("/api/v1/auth/me/", {"language": "ar"}, format="json")

    arabic.delete()
    user = User.objects.get(email="admin@example.com")
    assert user.language == "ar"                 # the row survives
    assert Language.resolve(user.language) == "en"   # and resolves safely
