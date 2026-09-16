"""drf-spectacular extension: teach the schema generator about our auth class.

`CookieJWTAuthentication` is a custom class, so drf-spectacular cannot infer how
callers authenticate and emits "could not resolve authenticator" for every view -
leaving the docs with no security scheme and a non-functional Swagger "Authorize"
button. Registering the two real schemes fixes that API-wide:

  * ``jwtAuth``    - Authorization: Bearer <access>  (mobile / native / server-to-server)
  * ``cookieAuth`` - the HttpOnly access cookie      (the admin SPA)

Documentation only - it changes no runtime authentication behaviour.
"""

from django.conf import settings
from drf_spectacular.extensions import OpenApiAuthenticationExtension


class CookieJWTAuthenticationScheme(OpenApiAuthenticationExtension):
    target_class = "apps.accounts.authentication.CookieJWTAuthentication"
    name = ["jwtAuth", "cookieAuth"]

    def get_security_definition(self, auto_schema):
        return [
            {
                "type": "http",
                "scheme": "bearer",
                "bearerFormat": "JWT",
                "description": "Send the access token as `Authorization: Bearer <access>`. "
                               "Obtain one from the mobile auth endpoints.",
            },
            {
                "type": "apiKey",
                "in": "cookie",
                "name": settings.AUTH_COOKIE_ACCESS,
                "description": "HttpOnly access cookie used by the admin SPA (set at login; "
                               "not readable by JavaScript). Browser clients also send the "
                               "`X-CSRFToken` header on unsafe methods.",
            },
        ]
