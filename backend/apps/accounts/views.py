"""Account views: registration, profile, password, MFA, JWT, admin user mgmt."""

from django.conf import settings
from django.contrib.auth import get_user_model
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import generics, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import (
    AuthenticationFailed, NotFound, PermissionDenied, ValidationError,
)
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from apps.auditlogs.services import log_event

from . import mfa
from .cookies import clear_auth_cookies, set_auth_cookies
from .filters import UserFilter
from .models import Role, UserSession
from .permissions import CanManageRoles, UserAccessPermission
from .security import (
    client_ip,
    is_user_locked,
    mark_session_inactive,
    record_session,
    register_login_failure,
    register_login_success,
    revoke_user_tokens,
    rotate_session,
    unlock_user,
)

# One uniform credential error for wrong password / locked / unknown email so a
# caller cannot tell which case occurred (no account enumeration).
GENERIC_LOGIN_ERROR = "Invalid email or password."
from config.listing import GroupedListMixin

from .serializers import (
    AdminSetPasswordSerializer,
    AdminUserSerializer,
    LoginTokenSerializer,
    ChangePasswordSerializer,
    CookieTokenRefreshSerializer,
    MfaCodeSerializer,
    RegisterSerializer,
    SessionSerializer,
    UserSerializer,
)

User = get_user_model()


def _staff_subject(user):
    """Audit subject for a target user that is a staff member (else None) — so
    account/role changes appear on the employee's Activity Log."""
    from apps.staff.services import staff_subject
    return staff_subject(user)


@method_decorator(ensure_csrf_cookie, name="dispatch")
class LoginView(TokenObtainPairView):
    """POST email + password (+ `otp` when MFA is on).

    On success the JWTs are returned as **HttpOnly cookies** (never in the body,
    so JS/XSS cannot read them); only the user profile is returned in JSON.
    Brute-force hardened: per-IP rate throttling + per-account lockout, audited.
    Also sets the CSRF cookie the SPA needs for subsequent writes.
    """

    serializer_class = LoginTokenSerializer
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "login"

    def post(self, request, *args, **kwargs):
        email = (request.data.get("email") or "").strip().lower()
        user = User.objects.filter(email=email).first() if email else None

        # Locked account → identical generic error as any other failure, so the
        # response never reveals whether the email exists / is locked.
        if user and is_user_locked(user):
            log_event(request, "login_blocked_locked", {"email": email}, status_code=401)
            raise AuthenticationFailed(GENERIC_LOGIN_ERROR)

        try:
            response = super().post(request, *args, **kwargs)
        except AuthenticationFailed:
            # Wrong email/password — count toward lockout for real accounts.
            # Unknown emails are bounded by the per-IP throttle and produce the
            # same generic error.
            if user:
                count = register_login_failure(user)
                event = "login_locked" if is_user_locked(user) else "login_failed"
                log_event(request, event, {"email": email, "failures": count}, status_code=401)
            else:
                log_event(request, "login_failed", {"email": email}, status_code=401)
            raise AuthenticationFailed(GENERIC_LOGIN_ERROR)  # normalize the message
        except ValidationError as exc:
            # The MFA stage: the password was correct (else AuthenticationFailed
            # above) but the OTP failed. Only count a *supplied-but-wrong* code
            # toward the lockout — an absent OTP is the normal "prompt me" step
            # of a legitimate MFA login and must NOT be penalised. This bounds
            # OTP brute-force per ACCOUNT, not just per IP.
            otp_supplied = bool((request.data.get("otp") or "").strip())
            detail = getattr(exc, "detail", None)
            if (user and user.mfa_enabled and otp_supplied
                    and isinstance(detail, dict) and "otp" in detail):
                count = register_login_failure(user)
                if is_user_locked(user):
                    log_event(request, "login_locked",
                              {"email": email, "failures": count}, status_code=401)
                    raise AuthenticationFailed(GENERIC_LOGIN_ERROR)
                log_event(request, "login_otp_failed",
                          {"email": email, "failures": count}, status_code=400)
            raise  # re-raise the 400 so the client re-prompts for the code

        if response.status_code == 200:
            # Per-channel access gate: credentials (and MFA) are valid, but this
            # account may be barred from the Admin Web Portal. Block BEFORE issuing
            # any cookie/session so no web token is delivered. Role/permissions are
            # untouched - this is an additional login-level control.
            if user and not user.web_login_enabled:
                log_event(request, "login_blocked_web_disabled",
                          {"email": email}, status_code=403, actor=user)
                raise PermissionDenied(
                    "Admin portal access is disabled for this account. "
                    "Please contact your administrator."
                )
            if user:
                register_login_success(user)  # reset counter; clears expired lock
                # Telemetry capture (login auth logic itself is unchanged).
                user.last_login_ip = client_ip(request)
                user.last_activity_at = timezone.now()
                user.save(update_fields=["last_login_ip", "last_activity_at"])
                log_event(request, "login_success", {"user": user.email}, actor=user)
            access = response.data.get("access")
            refresh = response.data.get("refresh")
            if user and refresh:
                # Capture session metadata (IP/UA/device) for the Active Sessions
                # screen — best-effort; never affects the auth result.
                record_session(request, user, refresh, mfa_verified=bool(user.mfa_enabled))
                log_event(request, "session_created", {"user": user.email}, actor=user)
            response.data = {"user": response.data.get("user")}
            set_auth_cookies(response, access, refresh)
        return response


@method_decorator(csrf_protect, name="dispatch")
class CookieTokenRefreshView(TokenRefreshView):
    """Rotate the session using the refresh cookie; sets fresh HttpOnly cookies.

    Uses CookieTokenRefreshSerializer: rejects refresh tokens issued before the
    user's tokens_revoked_at, and tracks the rotated token as an OutstandingToken.
    """

    permission_classes = [permissions.AllowAny]
    serializer_class = CookieTokenRefreshSerializer

    @extend_schema(request=None, responses=OpenApiTypes.OBJECT)
    def post(self, request, *args, **kwargs):
        from . import session_store
        refresh_cookie = request.COOKIES.get(settings.AUTH_COOKIE_REFRESH)
        access_cookie = request.COOKIES.get(settings.AUTH_COOKIE_ACCESS)
        # Opaque sessions: the cookie is a handle; resolve it to the stored JWT.
        refresh = (session_store.resolve("refresh", refresh_cookie)
                   if session_store.enabled() else refresh_cookie)
        if not refresh:
            return Response({"detail": "No active session."},
                            status=status.HTTP_401_UNAUTHORIZED)
        serializer = self.get_serializer(data={"refresh": refresh})
        try:
            serializer.is_valid(raise_exception=True)
        except (InvalidToken, TokenError):
            if session_store.enabled():   # the handle mapped to a dead token; kill it
                session_store.revoke("refresh", refresh_cookie)
                session_store.revoke("access", access_cookie)
            resp = Response({"detail": "Session expired. Please sign in again."},
                            status=status.HTTP_401_UNAUTHORIZED)
            return clear_auth_cookies(resp)
        data = serializer.validated_data
        resp = Response({"detail": "Session refreshed."})
        # Issues fresh handles (when opaque); then drop the rotated-away old ones.
        set_auth_cookies(resp, data["access"], data.get("refresh"))
        if session_store.enabled():
            session_store.revoke("refresh", refresh_cookie)
            session_store.revoke("access", access_cookie)
        return resp


class PermissionCatalogView(APIView):
    """Module×action catalogue + each role's *current* permission set.

    Powers both the user-form override checklist and the Roles master page.
    """

    permission_classes = [CanManageRoles]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        from . import access
        slugs = set(access.role_registry().keys()) | set(dict(Role.choices))
        grouped = access.permission_sections()
        return Response({
            "modules": access.module_structure(),       # legacy flat shape (kept)
            "sections": grouped["sections"],            # grouped + aligned matrix
            "basic_columns": grouped["basic_columns"],
            "permissions": [{"code": c, "label": label} for c, label in access.PERMISSIONS.items()],
            "role_defaults": {slug: sorted(access.get_role_permissions(slug)) for slug in slugs},
        })


def _role_payload(slug, request=None):
    from . import access
    from django.contrib.auth import get_user_model
    from .models import RoleAccess
    reg = access.role_registry().get(slug, {})
    base = reg.get("base_role", slug)
    is_system = reg.get("is_system", slug in access.SYSTEM_ROLES)
    user_count = get_user_model().objects.filter(
        Q(role_slug=slug) | Q(role_slug="", role=slug)
    ).count()
    # A role used as the base of a custom role can't be deleted until those go.
    used_as_base = RoleAccess.objects.filter(base_role=slug).exclude(role=slug).exists()
    return {
        "slug": slug,
        "name": reg.get("name") or dict(Role.choices).get(slug, slug),
        "base_role": base,
        "is_system": is_system,
        "editable": base != Role.SUPER_ADMIN,
        # Deletable when unassigned, not protected (super_admin/customer), and not
        # a base for any custom role.
        "deletable": slug not in access.PROTECTED_ROLES and user_count == 0 and not used_as_base,
        "permissions": sorted(access.get_role_permissions(slug)),
        "user_count": user_count,
    }


def _clean_codes(codes):
    from . import access
    return sorted(set(codes) & set(access.ALL_PERMISSIONS))


class RoleListView(APIView):
    """List all roles (system + custom) and create new custom roles."""

    permission_classes = [CanManageRoles]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        from . import access
        slugs = list(access.role_registry().keys())
        for r in access.PROTECTED_ROLES:        # always present; others only if defined
            if r not in slugs:
                slugs.append(r)
        roles = sorted((_role_payload(s, request) for s in set(slugs)),
                       key=lambda r: (not r["is_system"], r["name"]))
        return Response({"roles": roles})

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def post(self, request):
        from django.utils.text import slugify
        from . import access
        from .models import RoleAccess

        name = (request.data.get("name") or "").strip()
        if not name:
            return Response({"detail": "A role name is required."}, status=status.HTTP_400_BAD_REQUEST)
        base = request.data.get("base_role") or Role.MANAGER
        if base not in access.CUSTOM_BASE_ROLES:
            return Response(
                {"detail": f"base_role must be one of: {', '.join(access.CUSTOM_BASE_ROLES)}."},
                status=status.HTTP_400_BAD_REQUEST)
        # Only a super admin may mint a senior (admin-based, unrestricted) role.
        if base in access.SENIOR_ROLES and request.user.role != Role.SUPER_ADMIN:
            raise PermissionDenied("Only a super admin can create an admin-level role.")
        slug = slugify(request.data.get("slug") or name)[:40]
        if not slug:
            return Response({"detail": "Could not derive a slug from the name."},
                            status=status.HTTP_400_BAD_REQUEST)
        if RoleAccess.objects.filter(role=slug).exists() or slug in access.SYSTEM_ROLES:
            return Response({"detail": "A role with this name/slug already exists."},
                            status=status.HTTP_409_CONFLICT)

        perms = _clean_codes(request.data.get("permissions", []))
        RoleAccess.objects.create(
            role=slug, name=name, base_role=base, is_system=False, permissions=perms,
        )
        log_event(request, "role_created", {"role": slug, "base": base}, status_code=201)
        return Response(_role_payload(slug, request), status=status.HTTP_201_CREATED)


class RoleDetailView(APIView):
    """Update a role's permissions/name, or delete a custom role."""

    permission_classes = [CanManageRoles]

    def _guard(self, request, slug):
        from . import access
        base = access.base_role_for(slug)
        # The super_admin role is the system owner — always full and never editable.
        # Every other role (including admin) is editable by anyone with roles.edit.
        if base == Role.SUPER_ADMIN:
            raise PermissionDenied("The super admin role is always full and not editable.")

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def put(self, request, role):
        from . import access
        from .models import RoleAccess

        if not access.valid_role(role):
            return Response({"detail": "Unknown role."}, status=status.HTTP_404_NOT_FOUND)
        self._guard(request, role)

        codes = request.data.get("permissions")
        if codes is not None and not isinstance(codes, list):
            return Response({"detail": "`permissions` must be a list."},
                            status=status.HTTP_400_BAD_REQUEST)
        defaults = {}
        if codes is not None:
            unknown = set(codes) - set(access.ALL_PERMISSIONS)
            if unknown:
                return Response({"detail": f"Unknown permission codes: {', '.join(sorted(unknown))}."},
                                status=status.HTTP_400_BAD_REQUEST)
            defaults["permissions"] = _clean_codes(codes)
        name = request.data.get("name")
        reg = access.role_registry().get(role, {})
        if name and not reg.get("is_system", role in access.SYSTEM_ROLES):
            defaults["name"] = name.strip()
        obj, _ = RoleAccess.objects.update_or_create(
            role=role,
            defaults={
                **defaults,
                "base_role": reg.get("base_role", role if role in access.SYSTEM_ROLES else Role.MANAGER),
                "is_system": reg.get("is_system", role in access.SYSTEM_ROLES),
            },
        )
        log_event(request, "role_updated", {"role": role})   # RoleAccess.save() clears the cache
        return Response(_role_payload(role, request))

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def delete(self, request, role):
        from django.contrib.auth import get_user_model
        from . import access
        from .models import RoleAccess

        reg = access.role_registry().get(role)
        if reg is None and role not in access.SYSTEM_ROLES:
            return Response(status=status.HTTP_404_NOT_FOUND)
        if role in access.PROTECTED_ROLES:
            return Response({"detail": "This role is protected and cannot be deleted."},
                            status=status.HTTP_400_BAD_REQUEST)
        # Blocked while any user is on the role (by custom slug or system role field).
        in_use = get_user_model().objects.filter(
            Q(role_slug=role) | Q(role_slug="", role=role)
        ).count()
        if in_use:
            return Response(
                {"detail": f"{in_use} user(s) still use this role. Reassign them first."},
                status=status.HTTP_409_CONFLICT)
        # Blocked while it's the base of a custom role.
        based = RoleAccess.objects.filter(base_role=role).exclude(role=role)
        if based.exists():
            names = ", ".join(based.values_list("name", flat=True)[:5])
            return Response(
                {"detail": f"This role is the base of custom role(s): {names}. Delete those first."},
                status=status.HTTP_409_CONFLICT)
        RoleAccess.objects.filter(role=role).delete()
        access.invalidate_role_cache()   # queryset .delete() bypasses the model override
        log_event(request, "role_deleted", {"role": role})
        return Response(status=status.HTTP_204_NO_CONTENT)


class RoleDuplicateView(APIView):
    """Clone a role's behaviour + permissions into a new custom role. Gated by the
    dedicated `roles.duplicate` capability (separate from create/edit)."""

    permission_classes = [permissions.IsAuthenticated]

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def post(self, request, role):
        from django.utils.text import slugify
        from . import access
        from .models import RoleAccess

        if not request.user.has_perm_code("roles.duplicate"):
            raise PermissionDenied("You don't have permission to duplicate roles.")
        if not access.valid_role(role):
            return Response({"detail": "Unknown role."}, status=status.HTTP_404_NOT_FOUND)

        # Any role can be duplicated except super_admin (the system owner). The
        # clone is inert until assigned — and assigning an admin-level role still
        # requires a super admin — so this doesn't grant escalation.
        base = access.base_role_for(role)
        if base == Role.SUPER_ADMIN:
            return Response({"detail": "The super admin role can't be duplicated."},
                            status=status.HTTP_400_BAD_REQUEST)

        name = (request.data.get("name") or "").strip()
        if not name:
            return Response({"detail": "A role name is required."}, status=status.HTTP_400_BAD_REQUEST)
        slug = slugify(request.data.get("slug") or name)[:40]
        if not slug:
            return Response({"detail": "Could not derive a slug from the name."},
                            status=status.HTTP_400_BAD_REQUEST)
        if RoleAccess.objects.filter(role=slug).exists() or slug in access.SYSTEM_ROLES:
            return Response({"detail": "A role with this name/slug already exists."},
                            status=status.HTTP_409_CONFLICT)

        perms = sorted(access.get_role_permissions(role))
        RoleAccess.objects.create(
            role=slug, name=name, base_role=base, is_system=False, permissions=perms,
        )
        log_event(request, "role_duplicated", {"from": role, "to": slug}, status_code=201)
        return Response(_role_payload(slug, request), status=status.HTTP_201_CREATED)


@method_decorator([ensure_csrf_cookie], name="dispatch")
class CsrfView(APIView):
    """Bootstrap endpoint — ensures the SPA has a CSRF cookie before writes."""

    permission_classes = [permissions.AllowAny]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        return Response({"detail": "CSRF cookie set."})


@method_decorator(csrf_protect, name="dispatch")
class LogoutView(APIView):
    """Revoke the refresh token (blacklist) and clear the auth cookies.

    AllowAny so a user can always sign out even if the access token expired;
    protected by CSRF.
    """

    permission_classes = [permissions.AllowAny]

    @extend_schema(request=None, responses=OpenApiTypes.OBJECT)
    def post(self, request):
        from . import session_store
        refresh_cookie = request.COOKIES.get(settings.AUTH_COOKIE_REFRESH)
        token = (session_store.resolve("refresh", refresh_cookie)
                 if session_store.enabled() else refresh_cookie)
        if token:
            try:
                rt = RefreshToken(token)
                mark_session_inactive(rt.payload.get("jti"), "logout")
                rt.blacklist()
            except TokenError:
                pass
        # Drop the server-side handles so the opaque cookies are dead immediately.
        if session_store.enabled():
            session_store.revoke("refresh", refresh_cookie)
            session_store.revoke("access", request.COOKIES.get(settings.AUTH_COOKIE_ACCESS))
        if getattr(request.user, "is_authenticated", False):
            log_event(request, "logout", {"user": request.user.email})
        resp = Response({"detail": "Signed out."}, status=status.HTTP_200_OK)
        return clear_auth_cookies(resp)


class IdleEventView(APIView):
    """Audit the frontend idle-session-timeout events (warning shown, stayed,
    manual / automatic logout). Audit-only — touches no auth state or tokens.
    The logout itself is recorded separately by LogoutView."""

    permission_classes = [permissions.IsAuthenticated]
    _ALLOWED = {
        "idle_warning_shown", "idle_stay_logged_in",
        "idle_logout_manual", "idle_logout_auto",
    }

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def post(self, request):
        event = request.data.get("event")
        if event not in self._ALLOWED:
            return Response({"detail": "Unknown event."}, status=status.HTTP_400_BAD_REQUEST)
        log_event(request, event, {"user": request.user.email})
        return Response({"detail": "ok"})


class RegisterView(generics.CreateAPIView):
    """Public registration — always lands as a `customer`."""

    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "register"
    queryset = User.objects.all()


class MeView(generics.RetrieveUpdateAPIView):
    """The authenticated user's own profile."""

    serializer_class = UserSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        return self.request.user


class ChangePasswordView(generics.GenericAPIView):
    serializer_class = ChangePasswordSerializer
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "password"

    def post(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        # Clear the force-change flag now that the user has set a new password.
        if request.user.must_change_password:
            request.user.must_change_password = False
            request.user.save(update_fields=["must_change_password"])
        # Invalidate all existing sessions (incl. this one) — user re-authenticates.
        revoke_user_tokens(request.user)
        log_event(request, "password_changed", {"user": request.user.email})
        return Response(
            {"detail": "Password updated. Please sign in again."},
            status=status.HTTP_200_OK,
        )


# --------------------------------------------------------------------------- #
# MFA self-service (operates on the authenticated user)
# --------------------------------------------------------------------------- #
@extend_schema(request=None, responses=OpenApiTypes.OBJECT)
class MfaSetupView(APIView):
    """Begin enrolment: generate a secret + QR. Not active until confirmed."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "mfa"

    def post(self, request):
        user = request.user
        # Disabled blocks self-enrol — unless MFA is mandated (role/enforced),
        # in which case the user must be able to enrol (no deadlock).
        if user.mfa_disabled and not user.mfa_locked:
            return Response(
                {"detail": "MFA has been disabled for your account by an administrator."},
                status=status.HTTP_403_FORBIDDEN)
        if user.mfa_enabled:
            return Response({"detail": "MFA is already enabled."},
                            status=status.HTTP_400_BAD_REQUEST)
        secret = mfa.new_secret()
        user.mfa_secret = secret
        user.save(update_fields=["mfa_secret", "updated_at"])
        uri = mfa.provisioning_uri(secret, user.email)
        return Response({
            "secret": secret,
            "otpauth_uri": uri,
            "qr": mfa.qr_data_uri(uri),
        })


@extend_schema(request=MfaCodeSerializer, responses=OpenApiTypes.OBJECT)
class MfaConfirmView(APIView):
    """Confirm enrolment with a code from the authenticator app."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "mfa"

    def post(self, request):
        user = request.user
        ser = MfaCodeSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        if user.mfa_disabled and not user.mfa_locked:
            return Response(
                {"detail": "MFA has been disabled for your account by an administrator."},
                status=status.HTTP_403_FORBIDDEN)
        if not user.mfa_secret:
            return Response({"detail": "Start setup first."},
                            status=status.HTTP_400_BAD_REQUEST)
        if not mfa.verify(user.mfa_secret, ser.validated_data["code"]):
            return Response({"detail": "Invalid code. Try again."},
                            status=status.HTTP_400_BAD_REQUEST)
        user.mfa_enabled = True
        user.save(update_fields=["mfa_enabled", "updated_at"])
        log_event(request, "mfa_enabled", {"user": user.email})
        return Response({"detail": "MFA enabled.", "mfa_enabled": True})


@extend_schema(request=MfaCodeSerializer, responses=OpenApiTypes.OBJECT)
class MfaDisableView(APIView):
    """Disable own MFA — requires a current TOTP code (the second factor).

    A valid code proves possession of the device, so a stolen password alone
    cannot strip MFA. If the device is lost, an admin resets MFA instead.
    """

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "mfa"

    def post(self, request):
        user = request.user
        ser = MfaCodeSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        if not user.mfa_enabled:
            return Response({"detail": "MFA is not enabled."},
                            status=status.HTTP_400_BAD_REQUEST)
        # Lock-only enforcement: a user mandated MFA (by role policy or an admin
        # enforcement lock) may not self-disable. The message is deliberately
        # generic — it never reveals which of the two reasons applies.
        if user.mfa_locked:
            log_event(request, "mfa_self_disable_blocked", {"user": user.email},
                      status_code=403)
            return Response(
                {"detail": "MFA is enforced for your account; contact an administrator."},
                status=status.HTTP_403_FORBIDDEN)
        if not mfa.verify(user.mfa_secret, ser.validated_data["code"]):
            return Response({"detail": "A valid authenticator code is required."},
                            status=status.HTTP_400_BAD_REQUEST)
        user.mfa_enabled = False
        user.mfa_secret = ""
        user.save(update_fields=["mfa_enabled", "mfa_secret", "updated_at"])
        log_event(request, "mfa_disabled", {"user": user.email})
        return Response({"detail": "MFA disabled.", "mfa_enabled": False})


# --------------------------------------------------------------------------- #
# Admin user management
# --------------------------------------------------------------------------- #
SENIOR_ROLES = {Role.SUPER_ADMIN, Role.ADMIN}


class UserViewSet(GroupedListMixin, viewsets.ModelViewSet):
    """Admin-only user management — create staff/customers, edit, reset password.

    Privilege rules (defence against escalation / lockout):
      * Only a super admin (role tier) may create/become/manage an admin/super_admin.
      * Nobody may deactivate or delete their own account.
      * The single owner account (`is_super_admin`) can never be deactivated/deleted.
      * DELETE soft-deletes a non-owner (the row is kept for history).

    Note: `is_super_admin` is the canonical *ownership* anchor (used for owner
    protection below). The `_is_super` actor check remains a role/privilege-tier
    check per the approved Phase-0 inventory — switching it would re-scope role
    management and is out of this phase.
    """

    queryset = User.all_objects.all()   # include soft-deleted so admins can see/filter them
    permission_classes = [UserAccessPermission]
    filterset_class = UserFilter   # adds `locked` (matches is_locked) + the base fields
    search_fields = ["email", "first_name", "last_name", "phone"]
    ordering_fields = ["created_at", "email", "role", "last_login",
                       "last_activity_at", "first_name", "is_active", "date_joined"]
    group_by_fields = {
        "role": {"field": "role"},
        "is_active": {"field": "is_active", "true_label": "Active",
                      "empty_label": "Inactive"},
    }

    def get_queryset(self):
        # Annotate active-session count as ONE aggregate over the whole list
        # (no per-row subquery / N+1). A session = a live, non-blacklisted,
        # non-expired refresh token.
        now = timezone.now()
        qs = User.all_objects.annotate(
            _active_sessions=Count(
                "outstandingtoken",
                filter=Q(outstandingtoken__expires_at__gt=now,
                         outstandingtoken__blacklistedtoken__isnull=True),
                distinct=True,
            )
        ).order_by("-created_at")   # explicit: stable pagination over the aggregate
        # A Club Admin only sees manageable staff in their assigned clubs —
        # never senior accounts (admin/super) or other club admins.
        u = self.request.user
        if u.role == Role.CLUB_ADMIN:
            qs = (qs.filter(assigned_clubs__in=(u.scoped_club_ids() or []))
                  .exclude(role__in=[Role.SUPER_ADMIN, Role.ADMIN, Role.CLUB_ADMIN])
                  .distinct())
        return qs

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return AdminUserSerializer
        return UserSerializer

    # ----------------------------- guards ----------------------------------
    @property
    def _is_super(self):
        return self.request.user.role == Role.SUPER_ADMIN

    @property
    def _is_club_admin(self):
        return self.request.user.role == Role.CLUB_ADMIN

    def _my_club_ids(self):
        return set(self.request.user.scoped_club_ids() or [])

    def _guard_manage_target(self, target):
        """Only a super admin may act on an admin / super admin account.

        A Club Admin may manage only non-senior staff whose club assignment
        is fully inside their own clubs (never admins or other club admins).
        """
        if target.role in SENIOR_ROLES and not self._is_super:
            raise PermissionDenied("Only a super admin can manage admin accounts.")
        if self._is_club_admin:
            if target.role in (Role.SUPER_ADMIN, Role.ADMIN, Role.CLUB_ADMIN):
                raise PermissionDenied("Club admins can't manage admin or club-admin accounts.")
            target_clubs = set(target.assigned_clubs.values_list("id", flat=True))
            if not target_clubs or not target_clubs.issubset(self._my_club_ids()):
                raise PermissionDenied("You can only manage users within your assigned clubs.")

    def _guard_assign_role(self, slug):
        """Only a super admin may grant a senior (admin-based) role; a Club Admin
        may only grant non-admin staff roles. The single super admin is never
        assigned through create/edit — it is moved only via `transfer-super-admin`."""
        from . import access
        if access.base_role_for(slug) == Role.SUPER_ADMIN:
            raise PermissionDenied(
                "There is only one super admin. Use 'Transfer super admin' to move it; "
                "for another full-access user, create a role with full permissions.")
        if access.is_senior_role(slug) and not self._is_super:
            raise PermissionDenied("Only a super admin can assign the admin role.")
        # Club Admin is an admin-tier role — only super/admin may grant it (a
        # manager or a custom user-manager role must not be able to mint one).
        if access.base_role_for(slug) == Role.CLUB_ADMIN and \
                self.request.user.role not in (Role.SUPER_ADMIN, Role.ADMIN):
            raise PermissionDenied("Only an admin can assign the club admin role.")
        if self._is_club_admin and slug in (Role.CLUB_ADMIN, Role.ADMIN, Role.SUPER_ADMIN):
            raise PermissionDenied("Club admins can't assign admin or club-admin roles.")

    def _guard_overrides(self, overrides):
        """Only super/admin may set per-user permission overrides. A non-senior
        actor (e.g. a Club Admin, or a custom role with users.edit) must not be
        able to grant capabilities by proxy. Empty overrides are always fine."""
        if self.request.user.role in SENIOR_ROLES:
            return
        ov = overrides or {}
        if ov.get("grant") or ov.get("revoke"):
            raise PermissionDenied(
                "You can't set per-user permissions - assign a role instead.")

    def _guard_club_assignment(self, assigned_clubs):
        """A Club Admin can only assign users to its own clubs (and must)."""
        if not self._is_club_admin:
            return
        ids = {getattr(s, "id", s) for s in (assigned_clubs or [])}
        if not ids or not ids.issubset(self._my_club_ids()):
            raise PermissionDenied("Assign the user to one or more of your own clubs.")

    def _guard_not_self(self, target, action_label):
        if target.id == self.request.user.id:
            raise PermissionDenied(f"You cannot {action_label} your own account.")

    # ----------------------------- create/update ---------------------------
    def perform_create(self, serializer):
        self._guard_assign_role(serializer.validated_data.get("role", Role.CUSTOMER))
        self._guard_club_assignment(serializer.validated_data.get("assigned_clubs"))
        self._guard_overrides(serializer.validated_data.get("permission_overrides"))
        user = serializer.save()
        log_event(self.request, "user_created",
                  {"user": user.email, "role": user.role_identity}, status_code=201,
                  subject=_staff_subject(user))

    def perform_update(self, serializer):
        target = self.get_object()
        self._guard_manage_target(target)

        data = serializer.validated_data
        old_role = target.role_identity
        new_role = data.get("role", old_role)
        old_enforced = target.mfa_enforced
        old_web = target.web_login_enabled
        old_mobile = target.api_login_enabled
        if new_role != old_role:
            self._guard_assign_role(new_role)
            self._guard_not_self(target, "change the role of")
        if "assigned_clubs" in data:
            self._guard_club_assignment(data.get("assigned_clubs"))
        if "permission_overrides" in data:
            self._guard_overrides(data.get("permission_overrides"))
        if data.get("is_active") is False:
            self._guard_not_self(target, "deactivate")
        # Disabling admin-portal access can lock someone out: never allow it on
        # your own account or on the single owner account.
        if data.get("web_login_enabled") is False and old_web:
            self._guard_not_self(target, "disable admin portal access for")
            if target.is_super_admin:
                raise PermissionDenied(
                    "The owner account's admin portal access cannot be disabled."
                )

        user = serializer.save()
        # If the admin set a new password through the edit form, force the user
        # to change it on next login and cut existing sessions.
        if data.get("password"):
            user.must_change_password = True
            user.save(update_fields=["must_change_password"])
            revoke_user_tokens(user)
            log_event(self.request, "admin_set_password", {"user": user.email},
                      subject=_staff_subject(user))

        # Audit the edit, flagging role / club-assignment changes.
        changes = {"user": user.email}
        if new_role != old_role:
            changes["role"] = {"from": old_role, "to": new_role}
        if "assigned_clubs" in data:
            changes["sites_changed"] = True
        if "mfa_enforced" in data and data["mfa_enforced"] != old_enforced:
            changes["mfa_enforced"] = user.mfa_enforced
        # Per-channel login-access toggles get their own explicit audit events so
        # enabling/disabling a channel is clearly traceable (who, when, which user).
        if "web_login_enabled" in data and user.web_login_enabled != old_web:
            changes["web_login_enabled"] = user.web_login_enabled
            log_event(self.request,
                      "user_web_access_enabled" if user.web_login_enabled
                      else "user_web_access_disabled",
                      {"user": user.email}, subject=_staff_subject(user))
        if "api_login_enabled" in data and user.api_login_enabled != old_mobile:
            changes["api_login_enabled"] = user.api_login_enabled
            log_event(self.request,
                      "user_mobile_access_enabled" if user.api_login_enabled
                      else "user_mobile_access_disabled",
                      {"user": user.email}, subject=_staff_subject(user))
        log_event(self.request, "user_updated", changes, subject=_staff_subject(user))

    def perform_destroy(self, instance):
        # Authority: admins act only on non-senior accounts; only a super admin
        # (role tier) may act on admin/super-admin accounts.
        self._guard_manage_target(instance)
        self._guard_not_self(instance, "delete")
        # The single owner account can never be deleted (soft or hard).
        if instance.is_super_admin:
            raise PermissionDenied("The owner account cannot be deleted.")
        # A user who has signed in is kept for history — deactivate, don't delete.
        # Delete is only for accounts created but never used.
        if instance.last_login is not None:
            raise PermissionDenied(
                "This user has already signed in. Deactivate the account instead of deleting it.")
        # Soft delete — keep the row (and its history); flag + sign out.
        # Capture the original email before soft_delete tombstones it.
        email = instance.email
        subject = _staff_subject(instance)
        instance.soft_delete()
        revoke_user_tokens(instance)
        log_event(self.request, "user_soft_deleted", {"user": email}, subject=subject)

    # ----------------------------- actions ---------------------------------
    @action(detail=True, methods=["post"], url_path="transfer-super-admin")
    def transfer_super_admin(self, request, pk=None):
        """Move the single super-admin to another user. Only the current super
        admin (owner) may do this; the current owner is demoted to Admin so there
        is always exactly one super admin. For more full-access users, create a
        role with full permissions instead."""
        actor = request.user
        if not actor.is_super_admin:
            raise PermissionDenied("Only the super admin can transfer super admin.")
        target = self.get_object()
        if target.id == actor.id:
            return Response({"detail": "You are already the super admin."},
                            status=status.HTTP_400_BAD_REQUEST)
        if not target.is_active or target.is_deleted:
            return Response({"detail": "Choose an active user to become super admin."},
                            status=status.HTTP_400_BAD_REQUEST)
        if target.role == Role.CUSTOMER:
            return Response({"detail": "A customer cannot become super admin."},
                            status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            # Demote the current owner (and any stray super-admin-role accounts)
            # to Admin first, so the single-owner unique constraint always holds.
            User.all_objects.filter(role=Role.SUPER_ADMIN).update(
                is_super_admin=False, role=Role.ADMIN, role_slug="")
            target.is_super_admin = True
            target.role = Role.SUPER_ADMIN
            target.role_slug = ""
            target.save(update_fields=["is_super_admin", "role", "role_slug", "updated_at"])
        log_event(request, "super_admin_transferred",
                  {"from": actor.email, "to": target.email})
        return Response(UserSerializer(target, context={"request": request}).data)

    @action(detail=True, methods=["post"])
    def deactivate(self, request, pk=None):
        user = self.get_object()
        self._guard_manage_target(user)
        self._guard_not_self(user, "deactivate")
        if user.is_super_admin:
            raise PermissionDenied("The owner account cannot be deactivated.")
        user.is_active = False
        user.save(update_fields=["is_active"])
        revoke_user_tokens(user)  # sign the user out everywhere immediately
        log_event(request, "user_deactivated", {"user": user.email}, subject=_staff_subject(user))
        return Response({"detail": "User deactivated."})

    @action(detail=True, methods=["post"])
    def activate(self, request, pk=None):
        user = self.get_object()
        self._guard_manage_target(user)
        user.is_active = True
        user.save(update_fields=["is_active"])
        log_event(request, "user_activated", {"user": user.email}, subject=_staff_subject(user))
        return Response({"detail": "User activated."})

    @action(detail=True, methods=["post"], url_path="set-password")
    def set_password(self, request, pk=None):
        """Admin sets a new password for the user (no old-password required)."""
        user = self.get_object()
        self._guard_manage_target(user)
        ser = AdminSetPasswordSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user.set_password(ser.validated_data["new_password"])
        # (set_password stamps last_password_change_at; persist it below)
        # Force the user to change this admin-set password on next login.
        user.must_change_password = True
        user.save(update_fields=["password", "must_change_password", "last_password_change_at"])
        revoke_user_tokens(user)  # invalidate the user's existing sessions
        log_event(request, "admin_set_password", {"user": user.email}, subject=_staff_subject(user))
        return Response({"detail": "Password updated."})

    @action(detail=True, methods=["patch"])
    def unlock(self, request, pk=None):
        """Admin manual unlock — clears the lockout window + failure counter."""
        user = self.get_object()
        self._guard_manage_target(user)
        unlock_user(user)
        log_event(request, "user_unlocked", {"user": user.email}, subject=_staff_subject(user))
        return Response({"detail": "Account unlocked."})

    @action(detail=True, methods=["post"], url_path="force-password-change")
    def force_password_change(self, request, pk=None):
        """Require the user to rotate their EXISTING password at next login.

        Unlike set-password, this sets no password — the user's current password
        still authenticates the login itself; the per-request password-change
        gate (CookieJWTAuthentication) then forces a change before anything else,
        so no token revoke is needed. Self-target is not blocked, matching the
        other password/lock actions (set-password, unlock).
        """
        user = self.get_object()
        self._guard_manage_target(user)
        user.must_change_password = True
        user.save(update_fields=["must_change_password"])
        log_event(request, "force_password_change", {"user": user.email}, subject=_staff_subject(user))
        return Response({"detail": "User must change their password at next login."})

    @action(detail=True, methods=["post"], url_path="disable-mfa")
    def disable_mfa(self, request, pk=None):
        """Admin clears a user's MFA enrolment (e.g. lost device → re-enrol)."""
        user = self.get_object()
        self._guard_manage_target(user)
        user.mfa_enabled = False
        user.mfa_secret = ""
        user.save(update_fields=["mfa_enabled", "mfa_secret"])
        log_event(request, "admin_disabled_mfa", {"user": user.email}, subject=_staff_subject(user))
        return Response({"detail": "MFA disabled for user.", "mfa_enabled": False})

    @action(detail=True, methods=["post"], url_path="reset-mfa")
    def reset_mfa(self, request, pk=None):
        """Force re-enrolment with a FRESH secret.

        Unlike `disable-mfa` (which turns MFA off), this wipes the current
        enrolment + secret and keeps MFA mandatory (enforced), so the user must
        set up a brand-new authenticator on next sign-in. Existing sessions are
        revoked so the enrolment gate kicks in immediately.
        """
        user = self.get_object()
        self._guard_manage_target(user)
        self._guard_not_self(user, "reset the MFA of")
        user.mfa_enabled = False
        user.mfa_secret = ""
        user.mfa_disabled = False
        user.mfa_enforced = True
        user.save(update_fields=["mfa_enabled", "mfa_secret", "mfa_disabled", "mfa_enforced"])
        revoke_user_tokens(user)
        log_event(request, "admin_reset_mfa", {"user": user.email}, subject=_staff_subject(user))
        return Response({"detail": "MFA reset - the user must re-enrol with a fresh secret on next sign-in.",
                         "mfa_policy": user.mfa_policy})

    @action(detail=True, methods=["post"], url_path="mfa-policy")
    def set_mfa_policy(self, request, pk=None):
        """Set the per-user MFA policy (M365-style): disabled / optional / enforced.

        Single source of truth for the state machine — applies the right flags +
        side-effects atomically, so the UI can't land in a contradictory state.
          * disabled : MFA off & unavailable; clears enrolment + enforcement.
          * optional : MFA available; the user may self-enrol (clears enforcement).
          * enforced : MFA mandatory (clears the disabled flag).
        """
        user = self.get_object()
        self._guard_manage_target(user)
        self._guard_not_self(user, "change the MFA policy of")
        policy = request.data.get("policy")
        if policy not in ("disabled", "optional", "enforced"):
            raise ValidationError({"policy": "Must be 'disabled', 'optional', or 'enforced'."})
        # A role-mandated user can never be relaxed below 'enforced'.
        if policy in ("disabled", "optional") and user.mfa_role_required:
            raise ValidationError(
                {"policy": "MFA is required by this user's role and cannot be relaxed."})
        # The owner can never have MFA turned off.
        if policy == "disabled" and user.is_super_admin:
            raise ValidationError({"policy": "The owner account cannot have MFA disabled."})

        if policy == "disabled":
            user.mfa_disabled = True
            user.mfa_enforced = False
            user.mfa_enabled = False
            user.mfa_secret = ""
            fields = ["mfa_disabled", "mfa_enforced", "mfa_enabled", "mfa_secret"]
        elif policy == "optional":
            user.mfa_disabled = False
            user.mfa_enforced = False
            fields = ["mfa_disabled", "mfa_enforced"]
        else:  # enforced
            user.mfa_disabled = False
            user.mfa_enforced = True
            fields = ["mfa_disabled", "mfa_enforced"]
        user.save(update_fields=fields)
        log_event(request, "mfa_policy_changed", {"user": user.email, "policy": policy})
        return Response({"detail": f"MFA policy set to {policy}.",
                         "mfa_policy": user.mfa_policy})


# --------------------------------------------------------------------------- #
# JWT session inventory (reuses simplejwt token_blacklist; no parallel model)
# --------------------------------------------------------------------------- #
def _can_manage_sessions(actor, target) -> bool:
    """Own always; owner (is_super_admin) anyone; admin only non-senior users."""
    if actor.pk == target.pk:
        return True
    if actor.is_super_admin:
        return True
    if actor.role == Role.ADMIN and target.role not in SENIOR_ROLES:
        return True
    return False


SESSION_IDLE_SECONDS = 15 * 60   # no per-session activity for this long -> "idle"


class SessionViewSet(viewsets.ViewSet):
    """Active JWT sessions for a user / the whole system.

    A session = an OutstandingToken that is not blacklisted and not expired,
    enriched (where available) with UserSession metadata (IP, UA, device, ...).
    `?scope=all` returns every active session (admins only — the dedicated
    Active Sessions screen). Without it, the caller's own (or `?user=<id>`)
    sessions are returned — used by the profile + user-detail panels. Terminate
    actions stay guarded by `_can_manage_sessions`.
    """

    permission_classes = [permissions.IsAuthenticated]

    def _target_user(self, request):
        """Whose sessions: own, or ?user=<id> for an authorized admin/super.

        Unauthorized OR non-existent ?user both raise 403 (no enumeration —
        never an empty list, never 404-vs-403 leak)."""
        uid = request.query_params.get("user")
        if not uid or str(uid) == str(request.user.id):
            return request.user
        target = User.all_objects.filter(pk=uid).first()
        if target is None or not _can_manage_sessions(request.user, target):
            raise PermissionDenied("You cannot manage this user's sessions.")
        return target

    @staticmethod
    def _active_qs(user=None):
        now = timezone.now()
        qs = (OutstandingToken.objects
              .filter(expires_at__gt=now, blacklistedtoken__isnull=True)
              .select_related("user").prefetch_related("user__assigned_clubs")
              .order_by("-created_at"))
        return qs.filter(user=user) if user is not None else qs.filter(user__isnull=False)

    @staticmethod
    def _serialize(token, meta, actor):
        now = timezone.now()
        u = token.user
        exp = token.expires_at
        login_at = (meta.login_at if meta else None) or token.created_at
        # Freshest activity wins: the session's own (login/refresh) OR the user's
        # per-request last_activity_at (updated on every authed request). Using
        # only the session timestamp made an actively-used session look "idle"
        # between token refreshes.
        candidates = [d for d in ((meta.last_activity_at if meta else None),
                                  u.last_activity_at) if d]
        last = max(candidates) if candidates else None
        if exp and exp <= now:
            row_status = "expired"
        elif last and (now - last).total_seconds() > SESSION_IDLE_SECONDS:
            row_status = "idle"
        else:
            row_status = "active"
        return {
            "id": token.id,
            "session_id": token.id,
            "jti": (token.jti or "")[:12],
            "user_id": u.id,
            "full_name": u.full_name,
            "email": u.email,
            "role": u.role_identity,
            "role_name": u.role_name,
            "club_names": [s.name for s in u.assigned_clubs.all()],
            "login_at": login_at,
            "created_at": login_at,      # back-compat for the per-user panel
            "last_activity_at": last,
            "expires_at": exp,
            "ip_address": (meta.ip_address if meta else None) or u.last_login_ip,
            "browser": meta.browser if meta else "",
            "operating_system": meta.operating_system if meta else "",
            "device_type": meta.device_type if meta else "",
            "mfa_verified": bool(meta.mfa_verified) if meta else False,
            "status": row_status,
            "is_active": True,
            "can_manage": _can_manage_sessions(actor, u),
        }

    def _rows(self, tokens, actor):
        metas = {m.jti: m for m in UserSession.objects.filter(jti__in=[t.jti for t in tokens])}
        return [self._serialize(t, metas.get(t.jti), actor) for t in tokens]

    def list(self, request):
        actor = request.user
        if request.query_params.get("scope") == "all":
            if not (getattr(actor, "is_super_admin", False) or actor.role in SENIOR_ROLES):
                raise PermissionDenied("You cannot view all sessions.")
            self._audit_viewed(request)
            return Response(self._rows(list(self._active_qs()), actor))
        target = self._target_user(request)
        return Response(self._rows(list(self._active_qs(target)), actor))

    @staticmethod
    def _audit_viewed(request):
        # Dedupe so polling/refresh doesn't flood the audit log.
        try:
            from django.core.cache import cache
            if cache.add(f"session_viewed:{request.user.id}", 1, 300):
                log_event(request, "session_viewed", {"actor": request.user.email})
        except Exception:  # pragma: no cover
            pass

    def destroy(self, request, pk=None):
        # IDOR-safe: resolve the token, then authorize for ITS owner. Missing OR
        # unauthorized both return 404 (never reveal another user's token ids).
        token = OutstandingToken.objects.filter(pk=pk).first()
        if (token is None or token.user_id is None
                or not _can_manage_sessions(request.user, token.user)):
            raise NotFound("Session not found.")
        BlacklistedToken.objects.get_or_create(token=token)
        mark_session_inactive(token.jti, "terminated")
        log_event(request, "session_revoked",
                  {"user": token.user.email, "token_id": token.id})
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["post"], url_path="terminate-all")
    def terminate_all(self, request):
        target = self._target_user(request)
        revoke_user_tokens(target, reason="force_logout_all")
        log_event(request, "sessions_terminated_all", {"user": target.email})
        return Response({"detail": "All sessions terminated."})
