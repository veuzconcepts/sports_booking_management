"""Opaque server-side session handles for the browser cookie auth path.

With ``USE_OPAQUE_SESSIONS`` enabled, the browser's auth cookies carry a random
*opaque handle* instead of the JWT. The JWT is held server-side in the cache,
keyed by that handle, so a JWT never reaches the browser at all. Every existing
protection (signature/exp validation, ``tokens_revoked_at`` cutoff, per-session
``sid`` revocation, blacklist, MFA/password gates) is unchanged - the auth layer
simply resolves the handle to the stored JWT first, then runs exactly as before.

The ``Authorization: Bearer`` path (mobile / native / server-to-server) is NOT
affected: those clients still send a real JWT and are validated statelessly.

Operational requirement: enable this only with a shared, persistent cache
(Redis, ``USE_REDIS_CACHE=True``) so sessions survive restarts and are shared
across workers, and configure that store to NOT evict live keys (e.g. Redis
``maxmemory-policy noeviction`` or ``volatile-ttl``). With the default per-process
LocMem cache, sessions do not survive a restart - fine for dev, not for prod.
"""

import secrets

from django.conf import settings
from django.core.cache import cache

# Cache-key prefixes; the stored value is the raw JWT, the key embeds the handle.
_PREFIX = {"access": "opaque:sess:a:", "refresh": "opaque:sess:r:"}


def enabled() -> bool:
    return bool(getattr(settings, "USE_OPAQUE_SESSIONS", False))


def _ttl(kind: str) -> int:
    key = "ACCESS_TOKEN_LIFETIME" if kind == "access" else "REFRESH_TOKEN_LIFETIME"
    return int(settings.SIMPLE_JWT[key].total_seconds())


def issue(kind: str, jwt_str: str) -> str:
    """Store ``jwt_str`` under a fresh opaque handle (TTL = token lifetime).

    Returns the handle to place in the cookie.
    """
    handle = secrets.token_urlsafe(32)
    cache.set(_PREFIX[kind] + handle, jwt_str, timeout=_ttl(kind))
    return handle


def resolve(kind: str, handle: str | None) -> str | None:
    """Return the JWT stored for ``handle``, or None if unknown/expired."""
    if not handle:
        return None
    return cache.get(_PREFIX[kind] + handle)


def revoke(kind: str, handle: str | None) -> None:
    """Drop the stored JWT for ``handle`` (used on rotation and logout)."""
    if handle:
        cache.delete(_PREFIX[kind] + handle)
