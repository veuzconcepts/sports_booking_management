"""Cookie-based JWT authentication.

Reads the access token from an HttpOnly cookie so the SPA never handles raw
tokens (XSS cannot read HttpOnly cookies). For browser/cookie requests it also
enforces CSRF on unsafe methods. A standard `Authorization: Bearer` header is
still accepted (useful for mobile/native clients and server-to-server calls),
and header auth is exempt from the cookie CSRF check.
"""

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from rest_framework import exceptions
from rest_framework.authentication import CSRFCheck
from rest_framework_simplejwt.authentication import JWTAuthentication

from apps.auditlogs.services import log_event

# last_activity_at is updated at most once per user per this window — so an
# authenticated request costs at most one cheap UPDATE every 5 minutes, never
# a write per request.
_ACTIVITY_UPDATE_SECONDS = 300

# Audit dedupe window: at most one gate-block audit row per user per event in
# this window (the gate runs on every request, so we must not flood AuditLog).
# Shares the cache backend — per-process with LocMem; use Redis in prod for
# cross-worker dedupe.
_GATE_AUDIT_DEDUPE_SECONDS = 600


def _enforce_csrf(request):
    """Run Django's CSRF check the same way DRF's SessionAuthentication does."""
    def _dummy_get_response(req):  # pragma: no cover - never called
        return None

    check = CSRFCheck(_dummy_get_response)
    check.process_request(request)
    reason = check.process_view(request, None, (), {})
    if reason:
        raise exceptions.PermissionDenied(f"CSRF Failed: {reason}")


class CookieJWTAuthentication(JWTAuthentication):
    def authenticate(self, request):
        header = self.get_header(request)
        if header is not None:
            raw_token = self.get_raw_token(header)
            via_cookie = False
        else:
            cookie_val = request.COOKIES.get(settings.AUTH_COOKIE_ACCESS)
            # With opaque sessions the cookie holds a handle, not the JWT: resolve
            # it to the server-stored access token (a cache miss -> unauthenticated,
            # which triggers the normal cookie refresh flow). The Bearer-header path
            # above is untouched.
            from . import session_store
            raw_token = (session_store.resolve("access", cookie_val)
                         if session_store.enabled() else cookie_val)
            via_cookie = True

        if not raw_token:
            return None

        validated_token = self.get_validated_token(raw_token)
        user = self.get_user(validated_token)

        # Reject tokens minted before the user's sessions were revoked
        # (password change/reset, deactivation) — closes the post-reset window.
        revoked_at = getattr(user, "tokens_revoked_at", None)
        if revoked_at is not None:
            issued_at = validated_token.get("iat")
            if issued_at is not None and issued_at < int(revoked_at.timestamp()):
                raise exceptions.AuthenticationFailed(
                    "Session has been revoked. Please sign in again.",
                    code="token_revoked",
                )

        # Per-session revocation: if this access token's session (stable `sid`)
        # has been terminated, reject it immediately — so revoking ONE session
        # cuts that device off on its next request. Fail-open when there is no
        # sid / no matching session row (legacy tokens), to never block valid auth.
        sid = validated_token.get("sid")
        if sid:
            from .models import UserSession
            session = UserSession.objects.filter(sid=sid).only("is_active").first()
            if session is not None and not session.is_active:
                raise exceptions.AuthenticationFailed(
                    "Session has been revoked. Please sign in again.",
                    code="session_revoked",
                )

        # Per-channel login access (an ADDITIONAL gate on top of role/permissions).
        # The auth METHOD maps to the channel: a cookie is the Admin Web Portal SPA,
        # a Bearer header is an API client (customer web app / integrations).
        # Enforcing here (the one hook on every authenticated request) means an
        # admin disabling access cuts a live session on its next request, and
        # covers refreshed tokens too.
        if via_cookie and not getattr(user, "web_login_enabled", True):
            raise exceptions.AuthenticationFailed(
                "Admin portal access is disabled for this account. Please contact your administrator.",
                code="web_login_disabled",
            )
        if not via_cookie and not getattr(user, "api_login_enabled", True):
            raise exceptions.AuthenticationFailed(
                "API access is disabled for this account. Please contact support.",
                code="api_login_disabled",
            )

        # Account-state gates — enforced HERE (the one hook that runs for EVERY
        # authenticated request) because per-view permission_classes overrides
        # mean DEFAULT_PERMISSION_CLASSES is not global. Both gates share one
        # allowlist so a user under either/both can always reach the recovery +
        # session-mechanics endpoints (no deadlock). Password-change runs first.
        if getattr(user, "must_change_password", False):
            self._enforce_password_change(request, user)

        # MFA enrolment gate: a user for whom MFA is mandatory — by role policy
        # OR an admin enforcement lock (see User.mfa_locked) — who has not
        # enrolled is forced to enrol. The bar is enrolment only (mfa_enabled);
        # per-login OTP verification stays in LoginTokenSerializer, untouched.
        if user.mfa_locked and not user.mfa_enabled:
            self._enforce_mfa_enrolment(request, user)

        # Cookie-authenticated writes must carry a valid CSRF token.
        if via_cookie:
            _enforce_csrf(request)

        # Telemetry: record activity (throttled — see _touch_activity).
        self._touch_activity(user)

        return user, validated_token

    def _touch_activity(self, user):
        """Update last_activity_at at most once per _ACTIVITY_UPDATE_SECONDS.

        Uses a targeted .update() (no full save / no signals) on the unfiltered
        base manager, and only when stale — so it adds no per-request write cost.
        """
        try:
            now = timezone.now()
            last = getattr(user, "last_activity_at", None)
            if last is None or (now - last).total_seconds() >= _ACTIVITY_UPDATE_SECONDS:
                type(user)._base_manager.filter(pk=user.pk).update(last_activity_at=now)
        except Exception:  # telemetry must never break authentication
            pass

    # Exact URL names reachable while EITHER gate is active. Shared by the
    # password-change and MFA-enrolment gates so neither can deadlock the other.
    # Matched by exact equality (NOT a path/prefix match) so it can never
    # accidentally unlock admin/user-management endpoints ("user-list", etc.).
    _GATE_ALLOWLIST = {
        "change_password",            # password-change recovery
        "mfa_setup", "mfa_confirm",   # MFA-enrolment recovery
        "me", "logout", "csrf", "refresh", "login",   # session mechanics
    }

    def _gate_allowlisted(self, request) -> bool:
        """Shared allowlist check; fail OPEN on an unresolved request so a
        resolution edge case can never permanently lock a user out of recovery."""
        match = getattr(request, "resolver_match", None)
        if match is None:
            return True
        return match.url_name in self._GATE_ALLOWLIST   # exact match only

    def _audit_gate_block(self, request, user, event):
        """Audit a gate block, deduped to at most one row per user/event/window.

        `actor=user` is passed so log_event never reads `request.user` — doing
        so here (inside authentication) would re-trigger authentication.
        """
        try:
            key = f"gateaudit:{event}:{getattr(user, 'pk', '?')}"
            if cache.add(key, True, timeout=_GATE_AUDIT_DEDUPE_SECONDS):
                log_event(request, event, {"user": user.email}, status_code=403, actor=user)
        except Exception:  # auditing/cache must never break authentication
            pass

    def _enforce_password_change(self, request, user):
        if self._gate_allowlisted(request):
            return
        self._audit_gate_block(request, user, "password_change_required_blocked")
        raise exceptions.PermissionDenied(
            detail={"detail": "Password change required.",
                    "code": "password_change_required"},
        )

    def _enforce_mfa_enrolment(self, request, user):
        if self._gate_allowlisted(request):
            return
        self._audit_gate_block(request, user, "mfa_enrolment_required_blocked")
        raise exceptions.PermissionDenied(
            detail={"detail": "MFA enrolment required.",
                    "code": "mfa_enrolment_required"},
        )
