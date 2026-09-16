"""Tests for SecurityHeadersMiddleware (config/security_headers.py).

The middleware must attach Permissions-Policy + COOP to every response and a
strict CSP to NON-HTML (API/JSON) responses, without touching HTML surfaces
(Django admin / Swagger) so their inline assets keep working.
"""

import pytest
from rest_framework.test import APIClient


@pytest.mark.django_db
def test_api_json_response_carries_strict_csp_and_headers():
    # An unauthenticated API call returns a JSON 401 - still passes through the
    # middleware, so the headers must be present.
    resp = APIClient().get("/api/v1/customers/")
    assert resp.status_code == 401
    assert resp["Content-Type"].split(";")[0] == "application/json"

    assert resp["Content-Security-Policy"] == (
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    )
    assert resp["Cross-Origin-Opener-Policy"] == "same-origin"
    assert "camera=()" in resp["Permissions-Policy"]


@pytest.mark.django_db
def test_html_response_is_not_given_the_strict_api_csp():
    # The Swagger docs render HTML with inline assets; the strict API CSP must NOT
    # be applied to it (only the universal Permissions-Policy / COOP).
    resp = APIClient().get("/api/docs/")
    ctype = resp["Content-Type"].split(";")[0]
    if ctype == "text/html":
        assert "Content-Security-Policy" not in resp
        assert resp["Cross-Origin-Opener-Policy"] == "same-origin"


@pytest.mark.django_db
def test_report_only_toggle(settings):
    settings.CSP_REPORT_ONLY = True
    resp = APIClient().get("/api/v1/customers/")
    assert "Content-Security-Policy-Report-Only" in resp
    assert "Content-Security-Policy" not in resp  # the enforcing header is absent
