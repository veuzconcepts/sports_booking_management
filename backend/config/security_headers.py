"""Response security headers: Content-Security-Policy, Permissions-Policy, COOP.

Division of responsibility:

- The customer-facing **admin SPA** and its CSP are served by the reverse proxy
  (see ``deploy/nginx.conf``). That is where the browser loads executable HTML,
  so that is where the SPA's (Google-Maps-tuned) CSP belongs.
- **Django** here serves only JSON APIs plus two internal HTML surfaces: the
  Django admin and the Super-Admin-only API docs (Swagger/Redoc). So the CSP
  applied here is a strict *API baseline* - a JSON API response should never be
  interpretable as an executable document, so it gets ``default-src 'none'``.
  HTML responses (admin, Swagger, DRF browsable API) are left untouched so their
  inline scripts/styles keep rendering; they are internal, staff-only surfaces
  already protected by ``X-Frame-Options`` and authentication.

``Permissions-Policy`` and ``Cross-Origin-Opener-Policy`` are cheap and safe, so
they are set on every response. All values are overridable via the environment,
and ``CSP_REPORT_ONLY=True`` switches the CSP to report-only for a safe rollout.
"""

from django.conf import settings
from django.utils.deprecation import MiddlewareMixin


class SecurityHeadersMiddleware(MiddlewareMixin):
    """Attach security headers without touching response bodies or app logic."""

    def process_response(self, request, response):
        # Cheap, safe on every response (including JSON and HTML).
        response.setdefault(
            "Permissions-Policy",
            getattr(settings, "PERMISSIONS_POLICY", ""),
        )
        response.setdefault("Cross-Origin-Opener-Policy", "same-origin")

        # Strict CSP only for NON-HTML responses (API/JSON), so the Django admin,
        # Swagger/Redoc and the DRF browsable API - which need inline assets - are
        # never broken by it.
        content_type = (response.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type and content_type != "text/html":
            policy = getattr(settings, "API_CONTENT_SECURITY_POLICY", "")
            if policy:
                header = (
                    "Content-Security-Policy-Report-Only"
                    if getattr(settings, "CSP_REPORT_ONLY", False)
                    else "Content-Security-Policy"
                )
                response.setdefault(header, policy)

        return response
