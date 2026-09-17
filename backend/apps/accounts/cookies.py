"""Helpers to attach / clear the JWT auth cookies on a response."""

from django.conf import settings


def _access_max_age() -> int:
    return int(settings.SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"].total_seconds())


def _refresh_max_age() -> int:
    return int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds())


def set_auth_cookies(response, access: str, refresh: str | None = None):
    """Set the access cookie (and refresh cookie when provided) — HttpOnly.

    When USE_OPAQUE_SESSIONS is on, the JWTs are stored server-side and the cookie
    value is a random opaque handle instead of the token itself, so a JWT never
    reaches the browser.
    """
    from . import session_store
    if session_store.enabled():
        if access:
            access = session_store.issue("access", access)
        if refresh is not None:
            refresh = session_store.issue("refresh", refresh)
    common = {
        "secure": settings.AUTH_COOKIE_SECURE,
        "httponly": True,
        "samesite": settings.AUTH_COOKIE_SAMESITE,
        "domain": settings.AUTH_COOKIE_DOMAIN,
    }
    response.set_cookie(
        settings.AUTH_COOKIE_ACCESS, access,
        max_age=_access_max_age(), path="/", **common,
    )
    if refresh is not None:
        response.set_cookie(
            settings.AUTH_COOKIE_REFRESH, refresh,
            max_age=_refresh_max_age(), path=settings.AUTH_COOKIE_REFRESH_PATH, **common,
        )
    return response


def clear_auth_cookies(response):
    response.delete_cookie(
        settings.AUTH_COOKIE_ACCESS, path="/", domain=settings.AUTH_COOKIE_DOMAIN,
        samesite=settings.AUTH_COOKIE_SAMESITE,
    )
    response.delete_cookie(
        settings.AUTH_COOKIE_REFRESH, path=settings.AUTH_COOKIE_REFRESH_PATH,
        domain=settings.AUTH_COOKIE_DOMAIN, samesite=settings.AUTH_COOKIE_SAMESITE,
    )
    return response
