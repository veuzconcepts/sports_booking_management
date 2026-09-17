"""Accounts: roles, the capability catalogue and authentication boundaries."""

import pytest

from apps.accounts import access
from apps.accounts.models import STAFF_ROLES, Role


# --------------------------------------------------------------------------- #
# Roles
# --------------------------------------------------------------------------- #
def test_role_values_are_domain_neutral():
    assert set(Role.values) == {
        "super_admin", "admin", "club_admin", "manager",
        "facility_operator", "facility_staff", "customer",
    }


def test_customer_is_not_a_staff_role():
    assert Role.CUSTOMER not in STAFF_ROLES
    assert Role.FACILITY_STAFF in STAFF_ROLES


def test_super_admin_and_admin_are_club_unrestricted():
    assert access.UNRESTRICTED_ROLES == {Role.SUPER_ADMIN, Role.ADMIN}
    assert Role.CLUB_ADMIN not in access.UNRESTRICTED_ROLES


# --------------------------------------------------------------------------- #
# Capability catalogue
# --------------------------------------------------------------------------- #
def test_catalogue_has_no_legacy_modules():
    modules = {key for key, _label, _actions in access.MODULES}
    assert not modules & {"jobcards", "vehicles", "services", "apidocs"}  # legacy-term-guard: allow
    assert {"clubs", "facilities", "bookings", "customers"} <= modules


def test_no_capability_code_mentions_a_legacy_concept():
    banned = ("jobcard", "vehicle", "wash", "bay", "crew", "view_mobile", "branch")  # legacy-term-guard: allow
    for code in access.PERMISSIONS:
        assert not any(b in code for b in banned), code


def test_every_section_feature_exists_in_the_catalogue():
    modules = {key for key, _label, _actions in access.MODULES}
    for _title, keys in access.SECTIONS:
        for key in keys:
            assert key in modules, key


def test_permission_sections_render_for_the_matrix_ui(db):
    payload = access.permission_sections()
    assert payload["sections"]
    features = {f["key"] for s in payload["sections"] for f in s["features"]}
    assert {"clubs", "facilities"} <= features


def test_super_admin_holds_every_capability(db):
    assert access.resolve_permissions(Role.SUPER_ADMIN, {}) == set(access.ALL_PERMISSIONS)


def test_opt_in_capabilities_are_withheld_from_admin(db):
    admin = access.resolve_permissions(Role.ADMIN, {})
    assert not (admin & access.OPT_IN_PERMISSIONS)


def test_facility_staff_cannot_delete_bookings(db):
    perms = access.resolve_permissions(Role.FACILITY_STAFF, {})
    assert "bookings.view" in perms
    assert "bookings.delete" not in perms


def test_per_user_overrides_grant_and_revoke(db):
    perms = access.resolve_permissions(
        Role.FACILITY_STAFF,
        {"grant": ["bookings.cancel"], "revoke": ["bookings.view"]},
    )
    assert "bookings.cancel" in perms
    assert "bookings.view" not in perms


def test_denial_message_names_the_module(db):
    msg = access.denial_message("facilities", "view")
    assert msg == "You do not have permission to view Facilities & Catalogue."


# --------------------------------------------------------------------------- #
# User model
# --------------------------------------------------------------------------- #
def test_club_scoping_returns_none_for_unrestricted_users(db, make_user, club):
    user = make_user("admin2@example.com", role=Role.ADMIN)
    assert user.scoped_club_ids() is None


def test_club_scoping_limits_a_club_admin(db, make_user, club):
    user = make_user("clubadmin2@example.com", role=Role.CLUB_ADMIN)
    user.assigned_clubs.set([club])
    assert user.scoped_club_ids() == [club.id]


def test_email_is_the_login_identifier(db, make_user):
    user = make_user("someone@example.com")
    assert user.USERNAME_FIELD == "email"
    assert user.username is None


def test_soft_delete_tombstones_the_email(db, make_user):
    user = make_user("gone@example.com")
    user.soft_delete()
    user.refresh_from_db()
    assert user.is_deleted and not user.is_active
    assert user.email.startswith("deleted+")


# --------------------------------------------------------------------------- #
# Authentication boundaries
# --------------------------------------------------------------------------- #
def test_anonymous_requests_are_rejected(api):
    for path in ("/api/v1/bookings/", "/api/v1/customers/", "/api/v1/clubs/",
                 "/api/v1/auth/me/"):
        assert api.get(path).status_code == 401, path


def test_login_returns_the_signed_in_user(api, make_user):
    make_user("login@example.com", password="TestPass!2024")
    resp = api.post("/api/v1/auth/login/",
                    {"email": "login@example.com", "password": "TestPass!2024"},
                    format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["user"]["email"] == "login@example.com"


def test_login_rejects_a_bad_password(api, make_user):
    make_user("login2@example.com", password="TestPass!2024")
    resp = api.post("/api/v1/auth/login/",
                    {"email": "login2@example.com", "password": "wrong"}, format="json")
    assert resp.status_code == 401


def test_me_returns_the_current_user(auth_api, admin_user):
    resp = auth_api.get("/api/v1/auth/me/")
    assert resp.status_code == 200
    assert resp.json()["email"] == admin_user.email


def test_api_docs_are_not_public(api):
    assert api.get("/api/schema/").status_code in (401, 403)


def test_mobile_only_doc_routes_are_gone(api):
    for path in ("/api/mobile/schema/", "/api/mobile/docs/", "/api/v1/mobile/"):
        assert api.get(path).status_code == 404, path


def test_removed_apps_have_no_routes(api):
    for path in ("/api/v1/vehicles/", "/api/v1/jobcards/", "/api/v1/services/"):  # legacy-term-guard: allow
        assert api.get(path).status_code == 404, path
