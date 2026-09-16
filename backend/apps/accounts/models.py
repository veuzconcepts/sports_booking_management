"""User model and role enum.

A single `User` model serves every actor in the platform - customers, staff,
operators, managers, admins. The `role` column drives RBAC throughout the API.
"""

from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.core.exceptions import ValidationError
from django.db import models, transaction
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class Role(models.TextChoices):
    SUPER_ADMIN = "super_admin", _("Super Admin")
    ADMIN = "admin", _("Admin")
    CLUB_ADMIN = "club_admin", _("Club Admin")
    MANAGER = "manager", _("Manager")
    FACILITY_OPERATOR = "facility_operator", _("Facility Operator")
    FACILITY_STAFF = "facility_staff", _("Facility Staff")
    CUSTOMER = "customer", _("Customer")


STAFF_ROLES = {
    Role.SUPER_ADMIN,
    Role.ADMIN,
    Role.CLUB_ADMIN,
    Role.MANAGER,
    Role.FACILITY_OPERATOR,
    Role.FACILITY_STAFF,
}


class UserManager(BaseUserManager):
    """Email-first user manager."""

    use_in_migrations = True

    def _create_user(self, email, password, **extra_fields):
        if not email:
            raise ValueError("Email is required")
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        extra_fields.setdefault("role", Role.CUSTOMER)
        return self._create_user(email, password, **extra_fields)

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("role", Role.SUPER_ADMIN)
        if extra_fields.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra_fields.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")
        return self._create_user(email, password, **extra_fields)


class ActiveUserManager(UserManager):
    """Default manager — hides soft-deleted users so they disappear from the
    app and cannot authenticate (`get_by_natural_key` won't find them). Use
    `User.all_objects` to reach every row, including soft-deleted ones.

    `use_in_migrations = False` so historical models in data migrations use a
    plain (unfiltered) manager and never reference `is_deleted` before it exists.
    """

    use_in_migrations = False

    def get_queryset(self):
        return super().get_queryset().filter(is_deleted=False)


class RoleAccess(models.Model):
    """A role in the registry — system or custom (Roles & Permissions master page).

    `role` is the slug (identity). `base_role` is the system role whose behaviour
    (staff-ness, club scoping, field-staff rules) this role inherits — custom
    roles map to a safe staff tier. `permissions` is a list of `<module>.<action>`
    codes that defines the role's capabilities.
    """

    role = models.SlugField(max_length=40, unique=True)
    name = models.CharField(max_length=80, blank=True)
    base_role = models.CharField(max_length=20, choices=Role.choices, blank=True)
    permissions = models.JSONField(default=list, blank=True)
    is_system = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-is_system", "name")
        verbose_name_plural = "Role access"

    def __str__(self):
        return f"RoleAccess({self.role}: {len(self.permissions or [])} perms)"

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        from .access import invalidate_role_cache
        invalidate_role_cache()

    def delete(self, *args, **kwargs):
        super().delete(*args, **kwargs)
        from .access import invalidate_role_cache
        invalidate_role_cache()


class User(AbstractUser):
    """Custom user with role-based access control.

    `username` is dropped — email is the login identifier.
    """

    username = None
    # Globally unique. A soft-deleted account's email is tombstoned (see
    # `soft_delete`) so the original address becomes free to re-onboard while
    # uniqueness stays simple and `USERNAME_FIELD` remains unique (no auth.E003).
    email = models.EmailField(_("email address"), unique=True)
    phone = models.CharField(max_length=20, blank=True)
    # `role` is the system *behaviour* role (staff-ness, scoping). `role_slug`
    # is the assigned role's identity (system or custom) that drives the
    # permission matrix + display name; empty means it equals `role`.
    role = models.CharField(
        max_length=20,
        choices=Role.choices,
        default=Role.CUSTOMER,
        db_index=True,
    )
    role_slug = models.SlugField(max_length=40, blank=True)
    avatar = models.ImageField(upload_to="avatars/", null=True, blank=True)
    is_active = models.BooleanField(default=True)

    # Per-channel login access - an ADDITIONAL gate on top of role/permissions
    # (never a replacement). `web_login_enabled` controls Admin Web Portal login
    # (the cookie-authenticated SPA); `api_login_enabled` controls token login on
    # the Bearer-authenticated API (customer web app / integrations). Independent,
    # so a user may be allowed on one channel and blocked on the other. Both
    # default True.
    web_login_enabled = models.BooleanField(default=True)
    api_login_enabled = models.BooleanField(default=True)

    # Single owner account. Exactly one user may have this True (enforced by a
    # partial unique constraint + `clean()`). It is the canonical ownership flag;
    # the `role` enum still drives RBAC behaviour. Changed only via election / the
    # `promote_super_admin` CLI command / the `transfer-super-admin` API action.
    is_super_admin = models.BooleanField(default=False)

    # Soft delete — non-owner accounts are flagged, not row-removed, so audit
    # and historical records (bookings, payments) stay intact. The default
    # manager hides these; `all_objects` includes them.
    is_deleted = models.BooleanField(default=False, db_index=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    # DB-backed account lockout (durable + auditable + shared across workers).
    # The per-IP throttle is separate; this is per-account state.
    failed_login_attempts = models.PositiveIntegerField(default=0)
    locked_until = models.DateTimeField(null=True, blank=True)
    lock_reason = models.CharField(max_length=120, blank=True)

    # Force a password change on next login (set by admin set-password/reset,
    # cleared when the user changes their password).
    must_change_password = models.BooleanField(default=False)
    # Stamped whenever the password changes (set_password) — for password-age
    # display / future expiry policy.
    last_password_change_at = models.DateTimeField(null=True, blank=True)

    # Lightweight auth telemetry. last_login_ip is captured on successful login;
    # last_activity_at is updated (throttled) on authenticated requests.
    last_login_ip = models.GenericIPAddressField(null=True, blank=True)
    last_activity_at = models.DateTimeField(null=True, blank=True)

    # Multi-factor auth (TOTP). `mfa_secret` is set during enrolment and only
    # honoured once `mfa_enabled` is True (i.e. the user confirmed a code).
    mfa_enabled = models.BooleanField(default=False)
    mfa_secret = models.CharField(max_length=64, blank=True)
    # Admin enforcement lock (lock-only): when True, MFA enrolment is mandatory
    # for this user on top of the role policy. It can only ADD a requirement,
    # never remove a role-mandated one. See `mfa_locked`.
    mfa_enforced = models.BooleanField(default=False)
    # Admin availability switch (the "Disabled" state in the per-user MFA model).
    # When True the user may NOT use MFA (self-enrolment is blocked and any
    # existing enrolment is cleared). Default True = MFA off until an admin
    # enables it (the Microsoft 365 model). A mandated user (role-required /
    # enforced) is never effectively disabled — see `mfa_policy` / `mfa_locked`,
    # and the self-enrol guard lets a mandated user enrol regardless.
    mfa_disabled = models.BooleanField(default=True)

    # Any token issued before this timestamp is rejected (set on password
    # change/reset and deactivation) — invalidates all existing sessions at once.
    tokens_revoked_at = models.DateTimeField(null=True, blank=True)

    # Per-user permission overrides on top of the role template:
    # {"grant": ["payments.refund", ...], "revoke": ["bookings.cancel", ...]}.
    permission_overrides = models.JSONField(default=dict, blank=True)

    # Club / facility scoping - which venues and resources this user works at or
    # manages. Empty for unrestricted roles (super_admin/admin) or customers.
    assigned_clubs = models.ManyToManyField(
        "clubs.Club", blank=True, related_name="assigned_users",
    )
    assigned_facilities = models.ManyToManyField(
        "facilities.Facility", blank=True, related_name="assigned_users",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["first_name", "last_name"]

    objects = ActiveUserManager()   # default: excludes soft-deleted
    all_objects = UserManager()     # escape hatch: includes soft-deleted

    class Meta:
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["role"]),
            models.Index(fields=["email"]),
        ]
        constraints = [
            # At most one owner: a partial unique index over rows where
            # is_super_admin is True (Postgres + SQLite both support this).
            models.UniqueConstraint(
                fields=["is_super_admin"],
                condition=models.Q(is_super_admin=True),
                name="uniq_single_super_admin",
            ),
        ]

    def __str__(self):
        return f"{self.full_name} <{self.email}>"

    def clean(self):
        """Owner invariant: is_super_admin=True requires the super_admin role."""
        super().clean()
        if self.is_super_admin and self.role != Role.SUPER_ADMIN:
            raise ValidationError(
                {"is_super_admin": _("The owner account must have the Super Admin role.")}
            )

    def soft_delete(self):
        """Flag the account deleted (and inactive) without removing the row.

        The original email is **tombstoned** so the address frees up for
        re-onboarding while the global `unique=True` on email still holds. The
        tombstone embeds the pk, which is unique, so two tombstones can never
        collide (capped to the EmailField max length). The original email is
        preserved in the audit trail by the caller before this runs.

        The owner account must never be soft-deleted; callers guard that first.
        """
        with transaction.atomic():
            self.is_deleted = True
            self.is_active = False
            self.deleted_at = timezone.now()
            if not self.email.startswith("deleted+"):
                self.email = f"deleted+{self.pk}+{self.email}"[:254]
            self.save(update_fields=[
                "email", "is_deleted", "is_active", "deleted_at", "updated_at",
            ])

    def set_password(self, raw_password):
        super().set_password(raw_password)
        # Stamp the change in-memory; persisted on the next save. Callers that
        # save with update_fields must include "last_password_change_at".
        self.last_password_change_at = timezone.now()

    @property
    def full_name(self) -> str:
        name = f"{self.first_name} {self.last_name}".strip()
        return name or self.email

    @property
    def is_staff_member(self) -> bool:
        return self.role in STAFF_ROLES

    @property
    def is_locked(self) -> bool:
        """True while the account is inside its lockout window."""
        return bool(self.locked_until and self.locked_until > timezone.now())

    @property
    def mfa_role_required(self) -> bool:
        """MFA mandated by this user's ROLE (settings.MFA_REQUIRED_ROLES)."""
        from django.conf import settings
        return self.role in getattr(settings, "MFA_REQUIRED_ROLES", set())

    @property
    def mfa_locked(self) -> bool:
        """MFA enrolment is mandatory for this user — by role policy OR the admin
        enforcement lock. Single source of truth for the enrolment gate and for
        whether the user may self-disable MFA. Enforcement only ever adds a lock,
        so a role-required user stays locked even with mfa_enforced=False.
        """
        return self.mfa_role_required or self.mfa_enforced

    @property
    def mfa_policy(self) -> str:
        """The per-user MFA state for the admin UI (M365-style):
        'enforced' (mandatory, by role or admin lock) > 'disabled' (off,
        unavailable) > 'optional' (available; the user may self-enrol)."""
        if self.mfa_role_required or self.mfa_enforced:
            return "enforced"
        if self.mfa_disabled:
            return "disabled"
        return "optional"

    # --- Access helpers (role template + per-user overrides) ---------------
    @property
    def role_identity(self) -> str:
        """The assigned role's slug (custom or system) used for the matrix."""
        return self.role_slug or self.role

    @property
    def role_name(self) -> str:
        from .access import role_registry
        entry = role_registry().get(self.role_identity)
        if entry:
            return entry["name"]
        return dict(Role.choices).get(self.role_identity, self.role_identity)

    def get_effective_permissions(self) -> set:
        from .access import resolve_permissions
        return resolve_permissions(self.role_identity, self.permission_overrides)

    def has_perm_code(self, code: str) -> bool:
        return code in self.get_effective_permissions()

    @property
    def is_club_unrestricted(self) -> bool:
        """Super admins / admins are never limited by club assignment."""
        from .access import UNRESTRICTED_ROLES
        return self.role in UNRESTRICTED_ROLES

    def scoped_club_ids(self):
        """IDs of clubs this user is limited to, or None for unrestricted users."""
        if self.is_club_unrestricted:
            return None
        return list(self.assigned_clubs.values_list("id", flat=True))


class UserSession(models.Model):
    """Metadata for one login session, keyed to the active refresh-token `jti`.

    The authoritative "is this session live?" check stays with simplejwt's
    OutstandingToken/BlacklistedToken; this row only enriches it with device /
    network context for the admin Active Sessions screen. Written best-effort at
    login and updated on refresh rotation — never on the token-validation path,
    so it can't affect authentication.
    """

    class Device(models.TextChoices):
        DESKTOP = "desktop", "Desktop"
        MOBILE = "mobile", "Mobile"
        TABLET = "tablet", "Tablet"
        BOT = "bot", "Bot"
        OTHER = "other", "Other"

    jti = models.CharField(max_length=255, unique=True, db_index=True)   # current refresh-token jti (rotates)
    sid = models.CharField(max_length=255, blank=True, db_index=True)    # stable session id (in the access token; survives rotation)
    user = models.ForeignKey("User", on_delete=models.CASCADE, related_name="login_sessions")
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=512, blank=True)
    browser = models.CharField(max_length=80, blank=True)
    operating_system = models.CharField(max_length=80, blank=True)
    device_type = models.CharField(max_length=10, choices=Device.choices, default=Device.OTHER)
    login_at = models.DateTimeField(auto_now_add=True)
    last_activity_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    mfa_verified = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    logout_reason = models.CharField(max_length=40, blank=True)

    class Meta:
        ordering = ("-login_at",)
        indexes = [models.Index(fields=["user", "is_active"])]

    def __str__(self):
        return f"session<{self.jti[:8]}> {self.user_id}"
