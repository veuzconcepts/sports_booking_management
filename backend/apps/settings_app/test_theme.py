"""The organization theme: validation, resolution, contrast and permissions.

A theme reaches a stylesheet, so the value of these tests is mostly negative:
what must NOT be storable, and what must never take the interface down.
"""

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Role, User
from apps.settings_app import theme as theme_cfg
from apps.settings_app.models import Organization, ThemePreset

pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------- #
# Fixtures                                                                     #
# --------------------------------------------------------------------------- #
@pytest.fixture
def admin_user():
    return User.objects.create_user(
        email="theme-admin@example.com", password="Sup3r!Secret",
        role=Role.ADMIN, first_name="Theme", last_name="Admin",
    )


@pytest.fixture
def viewer_user():
    """Signed in, may read the branding, may not change it."""
    return User.objects.create_user(
        email="theme-viewer@example.com", password="Sup3r!Secret",
        role=Role.MANAGER, first_name="Theme", last_name="Viewer",
        permission_overrides={
            "grant": ["organization.view"],
            "revoke": ["organization.manage"],
        },
    )


@pytest.fixture
def api(admin_user):
    client = APIClient()
    client.force_authenticate(admin_user)
    return client


# --------------------------------------------------------------------------- #
# The token contract                                                           #
# --------------------------------------------------------------------------- #
class TestCatalogue:
    def test_every_token_has_a_default(self):
        # A token without a default would resolve to undefined in a stylesheet,
        # which renders as "no colour at all".
        for name in theme_cfg.TOKEN_NAMES:
            assert name in theme_cfg.DEFAULTS, name
            theme_cfg.normalise_colour(theme_cfg.DEFAULTS[name])

    def test_no_orphan_defaults(self):
        assert set(theme_cfg.DEFAULTS) == set(theme_cfg.TOKEN_NAMES)

    def test_every_token_belongs_to_a_named_group(self):
        for _name, group, _label in theme_cfg.TOKENS:
            assert group in theme_cfg.GROUP_LABELS

    def test_catalogue_is_what_the_settings_screen_needs(self):
        entries = theme_cfg.catalogue()
        assert len(entries) == len(theme_cfg.TOKEN_NAMES)
        assert entries[0].keys() == {"token", "group", "label", "default"}


class TestClean:
    def test_keeps_only_real_differences(self):
        cleaned = theme_cfg.clean({
            "primary": "#2563eb",
            "danger": theme_cfg.DEFAULTS["danger"],     # same as default
        })
        assert cleaned == {"primary": "#2563eb"}

    def test_expands_and_lowercases_shorthand(self):
        assert theme_cfg.clean({"primary": "#ABC"})["primary"] == "#aabbcc"

    @pytest.mark.parametrize("value", [
        "red", "rgb(1,2,3)", "#12", "#1234567", "", "url(x)",
        "#fff; background:url(javascript:alert(1))",
    ])
    def test_rejects_anything_that_is_not_a_hex_colour(self, value):
        with pytest.raises(theme_cfg.ThemeError):
            theme_cfg.clean({"primary": value})

    def test_rejects_an_unknown_token(self):
        # Silently dropping it would let an administrator believe it saved.
        with pytest.raises(theme_cfg.ThemeError) as exc:
            theme_cfg.clean({"sidebarBackgroundColour": "#ffffff"})
        assert "sidebarBackgroundColour" in str(exc.value)

    def test_rejects_an_unknown_corner_style(self):
        with pytest.raises(theme_cfg.ThemeError):
            theme_cfg.clean({"cornerStyle": "spiky"})

    def test_accepts_a_known_corner_style(self):
        assert theme_cfg.clean({"cornerStyle": "rounded"}) == {"cornerStyle": "rounded"}

    def test_empty_theme_is_valid(self):
        assert theme_cfg.clean(None) == {}
        assert theme_cfg.clean({}) == {}


class TestResolve:
    def test_defaults_fill_every_gap(self):
        resolved = theme_cfg.resolve({"primary": "#2563eb"})
        assert resolved["primary"] == "#2563eb"
        assert resolved["danger"] == theme_cfg.DEFAULTS["danger"]
        assert set(resolved) == set(theme_cfg.TOKEN_NAMES) | {"cornerStyle"}

    @pytest.mark.parametrize("stored", [None, "nonsense", 42, []])
    def test_a_corrupt_theme_falls_back_instead_of_raising(self, stored):
        # Bad branding data must never make the application unusable.
        assert theme_cfg.resolve(stored)["primary"] == theme_cfg.DEFAULTS["primary"]

    def test_a_single_bad_token_does_not_poison_the_rest(self):
        resolved = theme_cfg.resolve({"primary": "not-a-colour", "danger": "#000000"})
        assert resolved["primary"] == theme_cfg.DEFAULTS["primary"]
        assert resolved["danger"] == "#000000"


class TestContrast:
    def test_known_ratios(self):
        assert theme_cfg.contrast_ratio("#000000", "#ffffff") == 21.0
        assert theme_cfg.contrast_ratio("#ffffff", "#ffffff") == 1.0

    def test_order_does_not_matter(self):
        assert (theme_cfg.contrast_ratio("#123456", "#abcdef")
                == theme_cfg.contrast_ratio("#abcdef", "#123456"))

    def test_the_shipped_theme_is_readable(self):
        # If the default palette fails its own check, every warning below it is
        # noise that administrators will learn to ignore.
        failures = [c["label"] for c in theme_cfg.contrast_report({}) if not c["passes"]]
        assert failures == []

    def test_unreadable_pair_is_reported_with_a_suggestion(self):
        report = theme_cfg.contrast_report({"headerText": "#eeeeee", "headerBg": "#ffffff"})
        entry = next(c for c in report if c["foreground"] == "headerText")
        assert entry["passes"] is False
        assert entry["suggestion"] == "#1c1a36"

    def test_suggestion_is_white_on_a_dark_background(self):
        report = theme_cfg.contrast_report({"headerText": "#333333", "headerBg": "#111111"})
        entry = next(c for c in report if c["foreground"] == "headerText")
        assert entry["suggestion"] == "#ffffff"

    def test_every_shipped_preset_is_readable(self):
        for preset in ThemePreset.objects.all():
            failures = [c["label"] for c in theme_cfg.contrast_report(preset.tokens)
                        if not c["passes"]]
            assert failures == [], f"{preset.name}: {failures}"


# --------------------------------------------------------------------------- #
# The API                                                                      #
# --------------------------------------------------------------------------- #
class TestThemeEndpoint:
    def test_get_returns_everything_the_screen_needs(self, api):
        res = api.get("/api/v1/settings/theme/")
        assert res.status_code == 200
        body = res.json()
        assert body["theme"] == {}
        assert body["resolved"]["primary"] == theme_cfg.DEFAULTS["primary"]
        assert len(body["catalogue"]) == len(theme_cfg.TOKEN_NAMES)
        assert body["contrast"]

    def test_save_and_read_back(self, api):
        res = api.put("/api/v1/settings/theme/",
                      {"theme": {"primary": "#2563eb"}, "preset_name": "Professional Blue"},
                      format="json")
        assert res.status_code == 200
        assert res.json()["resolved"]["primary"] == "#2563eb"

        org = Organization.get_solo()
        assert org.theme == {"primary": "#2563eb"}
        assert org.theme_preset_name == "Professional Blue"

    def test_invalid_colour_is_rejected(self, api):
        res = api.put("/api/v1/settings/theme/",
                      {"theme": {"primary": "javascript:alert(1)"}}, format="json")
        assert res.status_code == 400
        assert Organization.get_solo().theme == {}

    def test_unknown_token_is_rejected(self, api):
        res = api.put("/api/v1/settings/theme/",
                      {"theme": {"notAToken": "#ffffff"}}, format="json")
        assert res.status_code == 400

    def test_reset_clears_every_override(self, api):
        api.put("/api/v1/settings/theme/",
                {"theme": {"primary": "#2563eb"}, "preset_name": "Blue"}, format="json")
        res = api.delete("/api/v1/settings/theme/")
        assert res.status_code == 200
        org = Organization.get_solo()
        assert org.theme == {}
        assert org.theme_preset_name == ""

    def test_contrast_endpoint_scores_an_unsaved_theme(self, api):
        res = api.post("/api/v1/settings/theme/contrast/",
                       {"theme": {"headerText": "#eeeeee", "headerBg": "#ffffff"}},
                       format="json")
        assert res.status_code == 200
        failing = [c for c in res.json()["contrast"] if not c["passes"]]
        assert failing
        # Scoring must not save anything.
        assert Organization.get_solo().theme == {}


class TestThemePermissions:
    def test_anonymous_cannot_read_the_theme(self):
        assert APIClient().get("/api/v1/settings/theme/").status_code in (401, 403)

    def test_viewer_may_read(self, viewer_user):
        client = APIClient()
        client.force_authenticate(viewer_user)
        assert client.get("/api/v1/settings/theme/").status_code == 200

    def test_viewer_may_not_save(self, viewer_user):
        client = APIClient()
        client.force_authenticate(viewer_user)
        res = client.put("/api/v1/settings/theme/",
                         {"theme": {"primary": "#2563eb"}}, format="json")
        assert res.status_code == 403
        assert Organization.get_solo().theme == {}

    def test_viewer_may_not_reset(self, viewer_user):
        client = APIClient()
        client.force_authenticate(viewer_user)
        assert client.delete("/api/v1/settings/theme/").status_code == 403

    def test_viewer_may_not_manage_presets(self, viewer_user):
        client = APIClient()
        client.force_authenticate(viewer_user)
        res = client.post("/api/v1/settings/theme-presets/",
                          {"name": "Sneaky", "tokens": {}}, format="json")
        assert res.status_code == 403


class TestPublicTheme:
    def test_readable_without_a_session(self):
        # The login screen needs the palette before anyone has signed in.
        res = APIClient().get("/api/v1/settings/theme/public/")
        assert res.status_code == 200
        assert res.json()["theme"]["primary"] == theme_cfg.DEFAULTS["primary"]

    def test_exposes_only_branding(self):
        org = Organization.get_solo()
        org.name = "Riverside"
        org.trn = "100000000000003"
        org.email = "private@example.com"
        org.theme = {"primary": "#2563eb"}
        org.save()

        body = APIClient().get("/api/v1/settings/theme/public/").json()
        assert body["name"] == "Riverside"
        assert body["theme"]["primary"] == "#2563eb"
        # Nothing else from the organization profile may leak to a visitor.
        assert set(body) == {"name", "theme", "logo_light", "logo_dark", "favicon"}

    def test_serves_the_resolved_palette_not_the_override_map(self):
        org = Organization.get_solo()
        org.theme = {"primary": "#2563eb"}
        org.save()
        theme = APIClient().get("/api/v1/settings/theme/public/").json()["theme"]
        assert set(theme) == set(theme_cfg.TOKEN_NAMES) | {"cornerStyle"}

    def test_a_corrupt_stored_theme_still_serves_a_usable_palette(self):
        # Written directly, bypassing the serializer, as a bad migration might.
        Organization.objects.update(theme={"primary": "not-a-colour"})
        theme = APIClient().get("/api/v1/settings/theme/public/").json()["theme"]
        assert theme["primary"] == theme_cfg.DEFAULTS["primary"]


class TestPresets:
    def test_shipped_presets_are_available(self, api):
        names = [p["name"] for p in api.get("/api/v1/settings/theme-presets/").json()]
        assert "Default" in names
        assert "Midnight" in names

    def test_preset_carries_a_resolved_palette(self, api):
        preset = next(p for p in api.get("/api/v1/settings/theme-presets/").json()
                      if p["name"] == "Midnight")
        assert preset["resolved"]["sidebarBg"] == "#111827"
        assert preset["resolved"]["danger"] == theme_cfg.DEFAULTS["danger"]

    def test_applying_a_preset_sets_the_active_theme(self, api):
        preset = next(p for p in api.get("/api/v1/settings/theme-presets/").json()
                      if p["name"] == "Modern Green")
        res = api.post(f"/api/v1/settings/theme-presets/{preset['id']}/apply/")
        assert res.status_code == 200

        org = Organization.get_solo()
        assert org.theme["primary"] == "#0f766e"
        assert org.theme_preset_name == "Modern Green"

    def test_applying_a_preset_does_not_change_the_preset(self, api):
        preset = next(p for p in api.get("/api/v1/settings/theme-presets/").json()
                      if p["name"] == "Modern Green")
        api.post(f"/api/v1/settings/theme-presets/{preset['id']}/apply/")
        api.put("/api/v1/settings/theme/", {"theme": {"primary": "#ff0000"}}, format="json")
        assert ThemePreset.objects.get(pk=preset["id"]).tokens["primary"] == "#0f766e"

    def test_a_built_in_preset_cannot_be_edited(self, api):
        preset = ThemePreset.objects.get(name="Midnight")
        res = api.patch(f"/api/v1/settings/theme-presets/{preset.pk}/",
                        {"name": "Renamed"}, format="json")
        assert res.status_code == 400
        assert ThemePreset.objects.get(pk=preset.pk).name == "Midnight"

    def test_a_built_in_preset_cannot_be_deleted(self, api):
        preset = ThemePreset.objects.get(name="Midnight")
        res = api.delete(f"/api/v1/settings/theme-presets/{preset.pk}/")
        assert res.status_code == 409
        assert ThemePreset.objects.filter(pk=preset.pk).exists()

    def test_duplicate_makes_an_editable_copy(self, api):
        preset = ThemePreset.objects.get(name="Midnight")
        res = api.post(f"/api/v1/settings/theme-presets/{preset.pk}/duplicate/")
        assert res.status_code == 201
        clone = ThemePreset.objects.get(pk=res.json()["id"])
        assert clone.is_builtin is False
        assert clone.tokens == preset.tokens
        assert clone.name == "Midnight copy"

    def test_duplicating_twice_does_not_collide(self, api):
        preset = ThemePreset.objects.get(name="Midnight")
        api.post(f"/api/v1/settings/theme-presets/{preset.pk}/duplicate/")
        res = api.post(f"/api/v1/settings/theme-presets/{preset.pk}/duplicate/")
        assert res.status_code == 201
        assert res.json()["name"] == "Midnight copy 2"

    def test_a_custom_preset_is_archived_rather_than_deleted(self, api):
        created = api.post("/api/v1/settings/theme-presets/",
                           {"name": "House Style", "tokens": {"primary": "#123456"}},
                           format="json").json()
        assert api.delete(f"/api/v1/settings/theme-presets/{created['id']}/").status_code == 204

        preset = ThemePreset.objects.get(pk=created["id"])
        assert preset.is_archived is True
        # Archived presets are out of the way, not gone.
        names = [p["name"] for p in api.get("/api/v1/settings/theme-presets/").json()]
        assert "House Style" not in names
        names = [p["name"] for p in api.get(
            "/api/v1/settings/theme-presets/?include_archived=true").json()]
        assert "House Style" in names

    def test_a_preset_with_an_invalid_colour_is_rejected(self, api):
        res = api.post("/api/v1/settings/theme-presets/",
                       {"name": "Broken", "tokens": {"primary": "chartreuse"}},
                       format="json")
        assert res.status_code == 400
        assert not ThemePreset.objects.filter(name="Broken").exists()

    def test_a_preset_needs_a_name(self, api):
        res = api.post("/api/v1/settings/theme-presets/",
                       {"name": "   ", "tokens": {}}, format="json")
        assert res.status_code == 400


class TestOrganizationEndpoint:
    def test_theme_round_trips_through_the_organization_profile(self, api):
        res = api.patch("/api/v1/settings/organization/",
                        {"theme": {"primary": "#2563eb"}}, format="json")
        assert res.status_code == 200
        assert res.json()["theme"] == {"primary": "#2563eb"}

    def test_the_profile_rejects_an_invalid_theme_too(self, api):
        res = api.patch("/api/v1/settings/organization/",
                        {"theme": {"primary": "green"}}, format="json")
        assert res.status_code == 400
