"""Account serializers for registration, profile, password and JWT."""

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers
from rest_framework_simplejwt.exceptions import InvalidToken
from rest_framework_simplejwt.serializers import (
    TokenObtainPairSerializer,
    TokenRefreshSerializer,
)
from rest_framework_simplejwt.settings import api_settings as jwt_settings
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
from rest_framework_simplejwt.utils import datetime_from_epoch

from apps.clubs.models import Club
from apps.facilities.models import Facility

from .models import Role

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    """Read serializer — what the frontend gets after login or on `/me`."""

    full_name = serializers.CharField(read_only=True)
    role_slug = serializers.CharField(source="role_identity", read_only=True)
    role_name = serializers.CharField(read_only=True)
    effective_permissions = serializers.SerializerMethodField()
    assigned_clubs = serializers.PrimaryKeyRelatedField(many=True, read_only=True)
    assigned_facilities = serializers.PrimaryKeyRelatedField(many=True, read_only=True)
    assigned_club_names = serializers.SerializerMethodField()
    is_locked = serializers.BooleanField(read_only=True)
    mfa_required = serializers.SerializerMethodField()
    mfa_policy = serializers.ReadOnlyField()
    active_sessions_count = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = (
            "id",
            "email",
            "first_name",
            "last_name",
            "full_name",
            "phone",
            "role",
            "role_slug",
            "role_name",
            "avatar",
            "is_active",
            "web_login_enabled",
            "api_login_enabled",
            "is_super_admin",
            "is_deleted",
            "mfa_enabled",
            "mfa_required",
            "mfa_enforced",
            "mfa_disabled",
            "mfa_policy",
            "must_change_password",
            "failed_login_attempts",
            "locked_until",
            "is_locked",
            "last_login_ip",
            "last_activity_at",
            "active_sessions_count",
            "permission_overrides",
            "effective_permissions",
            "assigned_clubs",
            "assigned_club_names",
            "assigned_facilities",
            "last_login",
            "last_password_change_at",
            "created_at",
        )
        read_only_fields = (
            "id", "role", "role_slug", "role_name", "is_active", "is_super_admin",
            "is_deleted", "mfa_enabled", "mfa_required", "mfa_enforced",
            "mfa_disabled", "mfa_policy",
            "must_change_password",
            "failed_login_attempts", "locked_until", "is_locked",
            "last_login_ip", "last_activity_at", "active_sessions_count",
            "permission_overrides", "effective_permissions", "assigned_clubs",
            "assigned_club_names", "assigned_facilities", "last_login",
            "last_password_change_at", "created_at",
        )

    def get_effective_permissions(self, obj) -> list[str]:
        return sorted(obj.get_effective_permissions())

    def get_assigned_club_names(self, obj) -> list[str]:
        return [s.name for s in obj.assigned_clubs.all()]

    def get_mfa_required(self, obj) -> bool:
        # Role-derived requirement only; `mfa_enforced` is surfaced separately so
        # the UI can tell a role mandate apart from an admin lock.
        return obj.mfa_role_required

    def get_active_sessions_count(self, obj) -> int:
        # Populated by the UserViewSet list/detail annotation; None elsewhere
        # (e.g. /me) so this never triggers a per-row query (no N+1).
        return getattr(obj, "_active_sessions", None)


class AdminUserSerializer(serializers.ModelSerializer):
    """Admin create/update of any user — role, access overrides, clubs & facilities."""

    full_name = serializers.CharField(read_only=True)
    # `role` on input is the role *slug* (system or custom); on output it's the
    # assigned identity. The behaviour/base role is derived server-side.
    role = serializers.CharField()
    role_name = serializers.CharField(read_only=True)
    password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, validators=[validate_password],
    )
    assigned_clubs = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=Club.objects.all(),
    )
    assigned_facilities = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=Facility.objects.all(),
    )
    assigned_club_names = serializers.SerializerMethodField()
    effective_permissions = serializers.SerializerMethodField()
    is_locked = serializers.BooleanField(read_only=True)
    mfa_required = serializers.SerializerMethodField()
    mfa_policy = serializers.ReadOnlyField()
    active_sessions_count = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = (
            "id", "email", "first_name", "last_name", "full_name",
            "phone", "role", "role_name", "is_active",
            "web_login_enabled", "api_login_enabled", "is_super_admin",
            "is_deleted", "mfa_enabled", "mfa_required", "mfa_enforced",
            "mfa_disabled", "mfa_policy",
            "must_change_password",
            "failed_login_attempts", "locked_until", "is_locked",
            "last_login_ip", "last_activity_at", "active_sessions_count", "password",
            "permission_overrides", "effective_permissions",
            "assigned_clubs", "assigned_club_names", "assigned_facilities",
            "last_login", "created_at",
        )
        # is_super_admin + lockout/mfa/must_change/telemetry fields are read-only
        # (changed via election / promote_super_admin / set-password / unlock / enrol / login).
        read_only_fields = ("id", "full_name", "role_name", "is_super_admin",
                            "is_deleted", "mfa_enabled", "mfa_required",
                            "mfa_disabled", "mfa_policy",
                            "must_change_password", "failed_login_attempts",
                            "locked_until", "is_locked", "last_login_ip",
                            "last_activity_at", "active_sessions_count",
                            "effective_permissions", "assigned_club_names",
                            "last_login", "created_at")

    def get_effective_permissions(self, obj) -> list[str]:
        return sorted(obj.get_effective_permissions())

    def get_assigned_club_names(self, obj) -> list[str]:
        return [s.name for s in obj.assigned_clubs.all()]

    def get_mfa_required(self, obj) -> bool:
        return obj.mfa_role_required

    def get_active_sessions_count(self, obj) -> int:
        return getattr(obj, "_active_sessions", None)

    def validate(self, attrs):
        """Block a user from editing their OWN privilege/status via this API.

        A self-edit may not change role or active status. (is_super_admin and
        mfa_enabled are already read-only, so they cannot be set here at all.)
        """
        request = self.context.get("request")
        if self.instance and request and getattr(request, "user", None) \
                and self.instance.pk == request.user.pk:
            new_role = attrs.get("role")
            if new_role is not None and new_role != self.instance.role_identity:
                raise serializers.ValidationError(
                    {"role": "You cannot change your own role."}
                )
            if "is_active" in attrs and attrs["is_active"] != self.instance.is_active:
                raise serializers.ValidationError(
                    {"is_active": "You cannot change your own active status."}
                )
            if "mfa_enforced" in attrs \
                    and attrs["mfa_enforced"] != self.instance.mfa_enforced:
                raise serializers.ValidationError(
                    {"mfa_enforced": "You cannot change your own MFA enforcement."}
                )
        return attrs

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data["role"] = instance.role_identity   # the assigned slug, for the dropdown
        return data

    def validate_email(self, value):
        value = value.lower()
        qs = User.objects.filter(email__iexact=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A user with this email already exists.")
        return value

    def validate_role(self, value):
        from .access import valid_role
        if not valid_role(value):
            raise serializers.ValidationError("Unknown role.")
        return value

    @staticmethod
    def _apply_role(target_attrs, slug):
        """Translate a role slug into the stored base role + identity slug."""
        from .access import base_role_for
        target_attrs["role"] = base_role_for(slug)
        target_attrs["role_slug"] = slug

    def validate_permission_overrides(self, value):
        from .access import ALL_PERMISSIONS, clean_overrides
        if value in (None, ""):
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError("Must be an object with 'grant'/'revoke' lists.")
        unknown = (set(value.get("grant", [])) | set(value.get("revoke", []))) - set(ALL_PERMISSIONS)
        if unknown:
            raise serializers.ValidationError(f"Unknown permission codes: {', '.join(sorted(unknown))}.")
        return clean_overrides(value)

    def create(self, validated_data):
        from .security import generate_password
        clubs = validated_data.pop("assigned_clubs", [])
        facilities = validated_data.pop("assigned_facilities", [])
        password = validated_data.pop("password", "") or generate_password()
        slug = validated_data.pop("role", None)
        if slug:
            self._apply_role(validated_data, slug)
        user = User.objects.create_user(
            email=validated_data.pop("email"),
            password=password,
            **validated_data,
        )
        # New users default to Disabled (MFA off). If created already enforced,
        # that wins — clear the disabled flag so the state isn't contradictory.
        if user.mfa_enforced and user.mfa_disabled:
            user.mfa_disabled = False
            user.save(update_fields=["mfa_disabled"])
        if clubs:
            user.assigned_clubs.set(clubs)
        if facilities:
            user.assigned_facilities.set(facilities)
        return user

    def update(self, instance, validated_data):
        password = validated_data.pop("password", "")
        clubs = validated_data.pop("assigned_clubs", None)
        facilities = validated_data.pop("assigned_facilities", None)
        slug = validated_data.pop("role", None)
        if slug:
            self._apply_role(validated_data, slug)
        for field, value in validated_data.items():
            setattr(instance, field, value)
        if password:
            instance.set_password(password)
        instance.save()
        if clubs is not None:
            instance.assigned_clubs.set(clubs)
        if facilities is not None:
            instance.assigned_facilities.set(facilities)
        return instance


class AdminSetPasswordSerializer(serializers.Serializer):
    """Admin sets a new password for a user (no old-password check)."""

    new_password = serializers.CharField(write_only=True, validators=[validate_password])


class SessionSerializer(serializers.Serializer):
    """A read-only view of one active JWT session (OutstandingToken row)."""

    id = serializers.IntegerField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)
    expires_at = serializers.DateTimeField(read_only=True)


class MfaCodeSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=10)


class MfaDisableSerializer(serializers.Serializer):
    """Disable own MFA with either a current TOTP code or the account password."""

    code = serializers.CharField(max_length=10, required=False, allow_blank=True)
    password = serializers.CharField(required=False, allow_blank=True, write_only=True)


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(
        write_only=True,
        required=True,
        validators=[validate_password],
    )
    password_confirm = serializers.CharField(write_only=True, required=True)
    role = serializers.ChoiceField(
        choices=Role.choices,
        required=False,
        default=Role.CUSTOMER,
    )

    class Meta:
        model = User
        fields = (
            "email",
            "first_name",
            "last_name",
            "phone",
            "password",
            "password_confirm",
            "role",
        )

    def validate(self, attrs):
        if attrs["password"] != attrs.pop("password_confirm"):
            raise serializers.ValidationError(
                {"password_confirm": "Passwords do not match."}
            )
        return attrs

    def validate_role(self, value):
        """Public registration may only ever create customers.

        Privileged accounts are created exclusively through the admin
        user-management API (`/auth/users/`), which enforces role-assignment
        rules. Ignoring the requested role here closes a privilege-escalation
        hole where any authenticated caller could self-register a staff account.
        """
        return Role.CUSTOMER

    def create(self, validated_data):
        validated_data["role"] = Role.CUSTOMER
        return User.objects.create_user(**validated_data)


class ChangePasswordSerializer(serializers.Serializer):
    old_password = serializers.CharField(required=True, write_only=True)
    new_password = serializers.CharField(
        required=True, write_only=True, validators=[validate_password]
    )

    def validate_old_password(self, value):
        user = self.context["request"].user
        if not user.check_password(value):
            raise serializers.ValidationError("Old password is incorrect.")
        return value

    def save(self, **kwargs):
        user = self.context["request"].user
        user.set_password(self.validated_data["new_password"])
        user.save(update_fields=["password", "last_password_change_at"])
        return user


class LoginTokenSerializer(TokenObtainPairSerializer):
    """JWT response with user profile embedded — saves an extra round trip."""

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["role"] = user.role
        token["email"] = user.email
        # Stable per-session id, copied onto the derived access token (simplejwt
        # copies non-reserved claims). It survives refresh rotation (set_jti only
        # changes jti), so the auth gate can revoke a single session immediately.
        token["sid"] = token[jwt_settings.JTI_CLAIM]
        return token

    def validate(self, attrs):
        data = super().validate(attrs)
        # Enforce MFA: an enrolled user must supply a valid TOTP `otp`.
        if self.user.mfa_enabled:
            from .mfa import verify as verify_totp

            otp = (self.initial_data or {}).get("otp", "")
            # The presence of an `otp` error key tells the client to prompt for
            # the authenticator code.
            if not otp:
                raise serializers.ValidationError(
                    {"otp": "MFA is enabled - an authenticator code is required."}
                )
            if not verify_totp(self.user.mfa_secret, otp):
                raise serializers.ValidationError({"otp": "Invalid MFA code."})
        data["user"] = UserSerializer(self.user).data
        return data


class CookieTokenRefreshSerializer(TokenRefreshSerializer):
    """Refresh-token rotation with two hardening additions.

    This touches rotation BOOKKEEPING only — no credential or OTP verification:

    1. Reject the refresh if its issued-at (`iat`) predates the user's
       `tokens_revoked_at`, so "terminate all" / deactivation are truly terminal.
       The comparison is against the TOKEN's iat (not wall-clock), so a token
       legitimately issued AFTER a revocation still works.
    2. Track the rotated (new) refresh token as a user-attributed
       `OutstandingToken`, so the session inventory stays accurate (~1 per live
       chain) — simplejwt's rotation otherwise leaves the new jti untracked.
    """

    def validate(self, attrs):
        incoming = self.token_class(attrs["refresh"])  # validates sig/exp/blacklist
        user_id = incoming.payload.get(jwt_settings.USER_ID_CLAIM)
        iat = incoming.payload.get("iat")
        user = User.all_objects.filter(pk=user_id).first() if user_id is not None else None

        # (1) iat-vs-tokens_revoked_at gate — compare token iat, NOT "now".
        if (user is not None and user.tokens_revoked_at is not None and iat is not None
                and iat < int(user.tokens_revoked_at.timestamp())):
            raise InvalidToken("Session has been revoked. Please sign in again.")

        data = super().validate(attrs)  # standard rotation: blacklist old, mint new

        # (2) Track the new refresh token under the user.
        if user is not None and data.get("refresh"):
            new = self.token_class(data["refresh"])
            new_exp = datetime_from_epoch(new.payload["exp"])
            OutstandingToken.objects.get_or_create(
                jti=new.payload[jwt_settings.JTI_CLAIM],
                defaults={
                    "user": user,
                    "token": str(new),
                    "created_at": new.current_time,
                    "expires_at": new_exp,
                },
            )
            # (3) Carry the session metadata row forward to the rotated jti.
            from .security import rotate_session
            rotate_session(
                incoming.payload.get(jwt_settings.JTI_CLAIM),
                new.payload[jwt_settings.JTI_CLAIM],
                new_exp,
            )
        return data
