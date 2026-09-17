"""DB-backed account lockout + session-revocation helpers.

Lockout state is persisted on the `User` (failed_login_attempts / locked_until /
lock_reason) so it is durable, auditable, and shared across workers. After
`LOGIN_MAX_FAILURES` consecutive credential failures the account is locked for
`LOGIN_LOCKOUT_SECONDS`; a successful login resets the counter and clears the
lock (which also covers auto-unlock once the window has passed). OTP / general
brute-forcing is separately bounded by the per-IP `login`/`mfa` throttles.
"""

import logging
import secrets
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)


def generate_password(nbytes: int = 16) -> str:
    """A strong random password for admin-created accounts (no temp default)."""
    return secrets.token_urlsafe(nbytes)


def revoke_user_tokens(user, reason: str = "revoked") -> None:
    """Invalidate all of a user's existing sessions.

    Stamps `tokens_revoked_at` (so already-issued access tokens are rejected by
    the auth layer) and blacklists outstanding refresh tokens. Called on
    password change/reset and on deactivation.
    """
    user.tokens_revoked_at = timezone.now()
    user.save(update_fields=["tokens_revoked_at"])
    try:
        from rest_framework_simplejwt.token_blacklist.models import (
            BlacklistedToken,
            OutstandingToken,
        )
        for token in OutstandingToken.objects.filter(user=user):
            BlacklistedToken.objects.get_or_create(token=token)
    except Exception:  # pragma: no cover - blacklisting must never hard-fail
        logger.exception("Failed to blacklist tokens for user %s", getattr(user, "id", "?"))
    mark_sessions_inactive(user=user, reason=reason)


# --------------------------------------------------------------------------- #
# Session metadata (UserSession) — all best-effort; never breaks auth.
# --------------------------------------------------------------------------- #
def parse_user_agent(ua_string: str) -> dict:
    """Browser / OS / device type from a User-Agent string (graceful fallback)."""
    try:
        from user_agents import parse
        ua = parse(ua_string or "")
        device = ("mobile" if ua.is_mobile else "tablet" if ua.is_tablet
                  else "bot" if ua.is_bot else "desktop")
        return {
            "browser": (ua.browser.family or "")[:80],
            "operating_system": (ua.os.family or "")[:80],
            "device_type": device,
        }
    except Exception:  # pragma: no cover - parsing must never break a request
        return {"browser": "", "operating_system": "", "device_type": "other"}


def record_session(request, user, refresh_str: str, *, mfa_verified: bool = False) -> None:
    """Create the UserSession row for a freshly issued refresh token (at login)."""
    try:
        from rest_framework_simplejwt.tokens import RefreshToken
        from rest_framework_simplejwt.utils import datetime_from_epoch
        from .models import UserSession

        rt = RefreshToken(refresh_str)
        jti = rt.payload.get("jti")
        if not jti:
            return
        ua_string = (request.META.get("HTTP_USER_AGENT", "") or "")[:512]
        meta = parse_user_agent(ua_string)
        exp = rt.payload.get("exp")
        UserSession.objects.update_or_create(
            jti=jti,
            defaults={
                "user": user,
                "sid": jti,                # stable session id == the original (login) jti
                "ip_address": client_ip(request),
                "user_agent": ua_string,
                "last_activity_at": timezone.now(),
                "expires_at": datetime_from_epoch(exp) if exp else None,
                "mfa_verified": bool(mfa_verified),
                "is_active": True,
                "logout_reason": "",
                **meta,
            },
        )
    except Exception:  # pragma: no cover
        logger.exception("record_session failed for user %s", getattr(user, "id", "?"))


def rotate_session(old_jti: str, new_jti: str, expires_at=None) -> None:
    """On refresh rotation the jti changes — carry the session row forward."""
    try:
        from .models import UserSession
        fields = {"jti": new_jti, "last_activity_at": timezone.now()}
        if expires_at is not None:
            fields["expires_at"] = expires_at
        UserSession.objects.filter(jti=old_jti).update(**fields)
    except Exception:  # pragma: no cover
        logger.exception("rotate_session failed")


def mark_session_inactive(jti: str, reason: str = "terminated") -> None:
    try:
        from .models import UserSession
        UserSession.objects.filter(jti=jti, is_active=True).update(
            is_active=False, logout_reason=reason)
    except Exception:  # pragma: no cover
        logger.exception("mark_session_inactive failed")


def mark_sessions_inactive(user=None, reason: str = "revoked") -> None:
    try:
        from .models import UserSession
        qs = UserSession.objects.filter(is_active=True)
        if user is not None:
            qs = qs.filter(user=user)
        qs.update(is_active=False, logout_reason=reason)
    except Exception:  # pragma: no cover
        logger.exception("mark_sessions_inactive failed")


def client_ip(request) -> str | None:
    xff = request.META.get("HTTP_X_FORWARDED_FOR")
    if xff:
        return xff.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


# --------------------------------------------------------------------------- #
# Per-account lockout (persisted on the User)
# --------------------------------------------------------------------------- #
def is_user_locked(user) -> bool:
    """True if the account is currently within its lockout window."""
    return bool(user and user.locked_until and user.locked_until > timezone.now())


def register_login_failure(user) -> int:
    """Record a credential failure; lock the account at the threshold.

    Returns the current failure count.
    """
    user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
    fields = ["failed_login_attempts"]
    if user.failed_login_attempts >= settings.LOGIN_MAX_FAILURES:
        user.locked_until = timezone.now() + timedelta(seconds=settings.LOGIN_LOCKOUT_SECONDS)
        user.lock_reason = "Too many failed login attempts."
        fields += ["locked_until", "lock_reason"]
    user.save(update_fields=fields)
    return user.failed_login_attempts


def register_login_success(user) -> None:
    """Reset the counter and clear any (expired/auto-unlocked) lock on success."""
    if user.failed_login_attempts or user.locked_until or user.lock_reason:
        user.failed_login_attempts = 0
        user.locked_until = None
        user.lock_reason = ""
        user.save(update_fields=["failed_login_attempts", "locked_until", "lock_reason"])


def unlock_user(user) -> None:
    """Manual admin unlock — clear the lock and the failure counter."""
    user.failed_login_attempts = 0
    user.locked_until = None
    user.lock_reason = ""
    user.save(update_fields=["failed_login_attempts", "locked_until", "lock_reason"])
