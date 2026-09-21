"""Permission catalogue (module × action), role matrix, and the resolver.

Permissions are `"<module>.<action>"` codes. Each role has a permission set that
is **editable in the database** (`RoleAccess`) and managed from the Roles &
Permissions master page; the constants here are the seeded defaults / fallback.

Effective per user = role permissions ∪ granted overrides − revoked overrides
(`super_admin` is always full and cannot be reduced).
"""

from django.core.cache import cache

from .models import Role

# --- Module × action catalogue --------------------------------------------
ACTION_LABELS = {
    "view": "View",
    "add": "Add",
    "edit": "Edit",
    "delete": "Delete",
    "merge": "Merge",
    "verify": "Verify",
    "assign": "Assign",
    "assign_override": "Override Availability",
    "skip_assignment": "Skip Assignment",
    "cancel": "Cancel",
    "duplicate": "Duplicate",
    "credit": "Request Refund",
    "credit_approve": "Approve Refund",
    "cancel_invoice": "Cancel invoice",
    "view_payer_contacts": "View Payer Contacts",
    "export": "Export",
    "manage": "Manage",
    "activity": "Activity Log",
    "transfer": "Transfer",
    "transfer_approve": "Approve Transfer",
    "transfer_cancel": "Cancel Transfer",
    "club_history": "Club History",
    "reassign": "Reassign Records",
    "suspend": "Suspend",
    "usage_adjust": "Adjust Usage",
    "apply_subscription": "Redeem Subscription",
    "unapply_subscription": "Unapply Subscription",
    "publish": "Publish",
    "media": "Media Library",
    "manage_rules": "Manage Rules",
    "manage_tiers": "Manage Tiers",
    "adjust": "Adjust Points",
    "redeem": "Redeem Points",
    "view_ledger": "View Ledger",
    "reverse": "Reverse Transaction",
}

# (key, label, [actions]) — actions are the module's relevant capabilities.
MODULES = [
    ("bookings", "Bookings", ["view", "add", "edit", "delete", "assign", "assign_override", "skip_assignment", "cancel", "reopen", "duplicate", "apply_subscription", "unapply_subscription"]),
    ("customers", "Customers", ["view", "add", "edit", "delete", "merge", "verify"]),
    ("loyalty", "Loyalty", ["view", "manage_rules", "manage_tiers", "adjust", "redeem", "view_ledger", "reverse"]),
    ("clubs", "Clubs & Venues", ["view", "add", "edit", "delete"]),
    ("facilities", "Facilities & Catalogue", ["view", "add", "edit", "delete"]),
    ("promotions", "Promo Codes", ["view", "add", "edit", "delete"]),
    ("staff", "Staff & Shifts", ["view", "add", "edit", "delete", "activity",
                                  "transfer", "transfer_approve", "transfer_cancel",
                                  "club_history", "reassign"]),
    ("invoicing", "Invoices", ["view", "add", "credit", "credit_approve", "cancel_invoice"]),
    # `view_payer_contacts` reveals the email and phone of the OTHER people who
    # settled a split booking. They are a third party's contact details sitting
    # on somebody else's booking, so seeing who paid what (`view`) is separated
    # from being able to contact them.
    ("payments", "Payments", ["view", "add", "delete", "view_payer_contacts"]),
    # Subscriptions (membership plans + customer memberships) — a first-class
    # module with its own capabilities, no longer folded under Payments.
    ("subscriptions", "Subscriptions", ["view", "add", "edit", "delete", "assign",
                                        "suspend", "cancel", "usage_adjust"]),
    ("reports", "Reports", ["view", "export"]),
    ("notifications", "Notifications", ["view", "manage"]),
    ("settings", "System Settings", ["view", "manage"]),
    ("organization", "Organization Info", ["view", "manage"]),
    ("users", "Users & Access", ["view", "add", "edit", "delete"]),
    ("roles", "Roles & Permissions", ["view", "add", "edit", "delete", "duplicate"]),
    ("audit", "Audit Log", ["view"]),
    # Customer-facing website CMS. `edit` covers create/update/delete of content;
    # `publish` toggles draft↔live; `media` manages the Media Library uploads.
    ("website", "Website", ["view", "edit", "publish", "media"]),
]

MODULE_LABELS = {key: label for key, label, _ in MODULES}

# Data Administration (record ownership): with only Basic Access a user works on
# records they OWN (created/assigned); these grant access to OTHERS' records.
# `view_all` = read all; `modify_all` = create/edit/delete all (implies view_all).
DATA_ADMIN_COLUMNS = [("view_all", "View All"), ("modify_all", "Modify All")]
_DATA_ADMIN_LABELS = dict(DATA_ADMIN_COLUMNS)
# Features that enforce record-level ownership scoping -> which data-admin
# columns each supports. Read-only features (audit, reports) get View All only.
OWNABLE_FEATURES = {
    "bookings": ["view_all", "modify_all"],
    "customers": ["view_all", "modify_all"],
    "invoicing": ["view_all", "modify_all"],
    "payments": ["view_all", "modify_all"],
    "audit": ["view_all"],
    "reports": ["view_all"],
}


def _code(module: str, action: str) -> str:
    return f"{module}.{action}"


# Verb used in the user-facing denial sentence per action. Falls back to the
# lower-cased ACTION_LABELS entry when an action isn't listed here.
_DENIAL_VERBS = {
    "view": "view",
    "add": "create",
    "edit": "edit",
    "delete": "delete",
    "merge": "merge duplicate",
    "verify": "verify",
    "manage_rules": "manage loyalty rules for",
    "manage_tiers": "manage loyalty tiers for",
    "adjust": "adjust loyalty points for",
    "redeem": "redeem loyalty points for",
    "view_ledger": "view the loyalty ledger for",
    "reverse": "reverse loyalty transactions for",
    "assign": "assign",
    "assign_override": "override availability checks when assigning",
    "skip_assignment": "skip assignment for",
    "cancel": "cancel",
    "reopen": "reopen",
    "duplicate": "duplicate",
    "apply_subscription": "redeem a subscription for",
    "unapply_subscription": "unapply the subscription on",
    "reset": "reset",
    "credit": "request refunds for",
    "credit_approve": "approve refunds for",
    "cancel_invoice": "cancel",
    "view_payer_contacts": "view the contact details of the people who paid for",
    "export": "export",
    "manage": "manage",
    "activity": "view the activity log for",
    "transfer": "transfer",
    "transfer_approve": "approve transfers for",
    "transfer_cancel": "cancel transfers for",
    "club_history": "view club history for",
    "reassign": "reassign records for",
    "suspend": "suspend",
    "usage_adjust": "adjust usage for",
    "publish": "publish content on",
    "media": "manage media for",
    "view_all": "view all",
    "modify_all": "manage all",
}


def denial_message(module: str, action: str) -> str:
    """A specific, professional permission-denied sentence for a capability.

    e.g. denial_message("facilities", "view") ->
        "You do not have permission to view Facilities & Catalogue."
    Used as the DRF permission `message` so the 403 names the missing
    capability instead of the generic default.
    """
    verb = _DENIAL_VERBS.get(action, ACTION_LABELS.get(action, action).lower())
    label = MODULE_LABELS.get(module, module.replace("_", " ").title())
    return f"You do not have permission to {verb} {label}."


# Flat catalogue: code -> "Module — Action"
PERMISSIONS: dict[str, str] = {
    _code(key, action): f"{label} - {ACTION_LABELS.get(action, action.title())}"
    for key, label, actions in MODULES
    for action in actions
}
# Per-feature data-administration codes (View All / Modify All).
for _feat, _acts in OWNABLE_FEATURES.items():
    for _act in _acts:
        PERMISSIONS[_code(_feat, _act)] = f"{MODULE_LABELS[_feat]} - {_DATA_ADMIN_LABELS[_act]}"
ALL_PERMISSIONS = frozenset(PERMISSIONS)

# Opt-in only: sensitive capabilities that are OFF by default for every role
# (excluded even from Admin's "all"). They must be granted explicitly per role.
# super_admin is the system owner and always holds every permission.
OPT_IN_PERMISSIONS = frozenset({"invoicing.cancel_invoice", "payments.delete",
                                "bookings.skip_assignment",
                                "payments.view_payer_contacts"})


def module_structure() -> list[dict]:
    """Catalogue shape the master-page UI renders into a matrix."""
    return [
        {
            "key": key,
            "label": label,
            "actions": [
                {"action": a, "code": _code(key, a), "label": ACTION_LABELS.get(a, a.title())}
                for a in actions
            ],
        }
        for key, label, actions in MODULES
    ]


# --- Grouped / aligned catalogue for the Roles matrix UI -------------------
# Basic Access columns (Salesforce-style), mapped onto our existing actions —
# codes are UNCHANGED (e.g. bookings.view is simply labelled "Read").
BASIC_COLUMNS = [
    ("read", "view", "Read"),
    ("create", "add", "Create"),
    ("edit", "edit", "Edit"),
    ("delete", "delete", "Delete"),
]
_BASIC_ACTIONS = {action for _col, action, _label in BASIC_COLUMNS}

# Feature sections (rows grouped for easy scanning; extend as features grow).
SECTIONS = [
    ("Operations", ["bookings"]),
    ("Customers", ["customers", "loyalty"]),
    ("Clubs & Facilities", ["clubs", "facilities", "promotions"]),
    ("People & Access", ["staff", "users", "roles"]),
    ("Finance", ["invoicing", "payments", "subscriptions"]),
    ("Insights & System", ["reports", "notifications", "settings", "organization", "audit"]),
    ("Website", ["website"]),
]


def permission_sections() -> dict:
    """Grouped + column-aligned shape for the Roles permission matrix.

    { "basic_columns": [{key,label}], "sections": [{section, features:[
        {key, label, basic:{read:code|None,...}, advanced:[{code,label}], codes:[...] }]}] }
    Codes are the same `feature.action` strings used everywhere else.
    """
    by_key = {key: (label, actions) for key, label, actions in MODULES}
    sections = []
    for title, keys in SECTIONS:
        features = []
        for key in keys:
            label, actions = by_key[key]
            basic = {
                col: (_code(key, action) if action in actions else None)
                for col, action, _label in BASIC_COLUMNS
            }
            advanced = [
                {"code": _code(key, a), "label": ACTION_LABELS.get(a, a.title())}
                for a in actions if a not in _BASIC_ACTIONS
            ]
            allowed = OWNABLE_FEATURES.get(key, [])
            data_admin = {
                col: (_code(key, col) if col in allowed else None)
                for col, _lbl in DATA_ADMIN_COLUMNS
            }
            codes = [_code(key, a) for a in actions] + [c for c in data_admin.values() if c]
            features.append({
                "key": key, "label": label, "basic": basic, "advanced": advanced,
                "data_admin": data_admin, "codes": codes,
            })
        sections.append({"section": title, "features": features})
    return {
        "basic_columns": [{"key": c, "label": lbl} for c, _a, lbl in BASIC_COLUMNS],
        "data_admin_columns": [{"key": c, "label": lbl} for c, lbl in DATA_ADMIN_COLUMNS],
        "sections": sections,
    }


def can_view_all(user, feature: str) -> bool:
    """May this user read OTHERS' records for `feature`? Features without a
    `view_all` code are not ownership-scoped → unrestricted (returns True)."""
    code = _code(feature, "view_all")
    if code not in PERMISSIONS:
        return True
    return code in user.get_effective_permissions()


def can_modify_all(user, feature: str) -> bool:
    """May this user create/edit/delete OTHERS' records for `feature`?"""
    code = _code(feature, "modify_all")
    if code not in PERMISSIONS:
        return True
    return code in user.get_effective_permissions()


def _codes(module: str, *actions: str) -> set:
    return {_code(module, a) for a in actions}


# --- Default permission matrix per role (seed / fallback) ------------------
_MANAGER = (
    _codes("bookings", "view", "add", "edit", "delete", "assign", "cancel", "reopen", "duplicate", "apply_subscription", "unapply_subscription", "view_all", "modify_all")
    # Manager edits customers + refunds payments -> view_all + modify_all so the
    # existing "sees/manages everything" behaviour is preserved.
    | _codes("customers", "view", "add", "edit", "verify", "view_all", "modify_all")
    | _codes("loyalty", "view", "manage_rules", "manage_tiers", "adjust", "redeem", "view_ledger")
    | _codes("clubs", "view")
    | _codes("facilities", "view")
    | _codes("promotions", "view", "add", "edit", "delete")
    | _codes("staff", "view", "add", "edit", "delete", "activity",
             "transfer", "transfer_cancel", "club_history", "reassign")
    | _codes("invoicing", "view", "add", "credit", "view_all", "modify_all")
    | _codes("payments", "view", "add", "view_all", "modify_all")
    | _codes("subscriptions", "view", "add", "edit", "delete", "assign", "suspend", "cancel")
    | _codes("reports", "view", "export", "view_all")   # managers see company-wide reports
    | _codes("notifications", "view")
)
# Club Admin: admin-like within their assigned clubs (club-scoped, NOT in
# UNRESTRICTED_ROLES), plus club-limited user management. No global config
# (organization / settings / role editing).
_CLUB_ADMIN = (
    _codes("bookings", "view", "add", "edit", "delete", "assign", "assign_override", "cancel", "reopen", "duplicate", "apply_subscription", "unapply_subscription", "view_all", "modify_all")
    | _codes("customers", "view", "add", "edit", "verify", "view_all", "modify_all")
    | _codes("loyalty", "view", "manage_rules", "manage_tiers", "adjust", "redeem", "view_ledger", "reverse")
    | _codes("clubs", "view", "edit")
    | _codes("facilities", "view", "add", "edit")
    | _codes("promotions", "view", "add", "edit", "delete")
    | _codes("staff", "view", "add", "edit", "delete", "activity",
             "transfer", "transfer_approve", "transfer_cancel", "club_history", "reassign")
    | _codes("invoicing", "view", "add", "credit", "credit_approve", "view_all", "modify_all")
    | _codes("payments", "view", "add", "view_all", "modify_all")
    | _codes("subscriptions", "view", "add", "edit", "delete", "assign", "suspend", "cancel", "usage_adjust")
    | _codes("reports", "view", "export", "view_all")   # scoped to their clubs in reports
    | _codes("notifications", "view")
    | _codes("users", "view", "add", "edit", "delete")  # club-limited (enforced in the viewset)
)
_FACILITY_OPERATOR = (
    _codes("bookings", "view", "edit", "assign")
    # View-only roles keep full visibility (view_all) but no modify_all.
    | _codes("customers", "view", "view_all")
    | _codes("clubs", "view") | _codes("facilities", "view")
    | _codes("invoicing", "view", "view_all") | _codes("payments", "view", "view_all")
)
_FACILITY_STAFF = (
    _codes("bookings", "view", "edit")
    | _codes("customers", "view", "view_all")
    | _codes("clubs", "view") | _codes("facilities", "view")
)

DEFAULT_ROLE_PERMISSIONS: dict[str, frozenset] = {
    # super_admin is always full (system owner). Admin gets everything EXCEPT the
    # opt-in capabilities, which must be granted explicitly per role.
    Role.SUPER_ADMIN: ALL_PERMISSIONS,
    Role.ADMIN: frozenset(ALL_PERMISSIONS - OPT_IN_PERMISSIONS),
    Role.CLUB_ADMIN: frozenset(_CLUB_ADMIN),
    Role.MANAGER: frozenset(_MANAGER),
    Role.FACILITY_OPERATOR: frozenset(_FACILITY_OPERATOR),
    Role.FACILITY_STAFF: frozenset(_FACILITY_STAFF),
    Role.CUSTOMER: frozenset(),
}

# Club-unrestricted: see/manage every club. Club Admin is deliberately NOT here,
# so scoped_club_ids() limits it to its assigned_clubs.
UNRESTRICTED_ROLES = {Role.SUPER_ADMIN, Role.ADMIN}
# Senior = top of the management chain (can manage Club Admins + everyone).
SENIOR_ROLES = {Role.SUPER_ADMIN, Role.ADMIN}

# All built-in role templates. super_admin is always full and not editable.
SYSTEM_ROLES = [Role.SUPER_ADMIN, Role.ADMIN, Role.CLUB_ADMIN, Role.MANAGER,
                Role.FACILITY_OPERATOR, Role.FACILITY_STAFF, Role.CUSTOMER]
# Never deletable: the system owner + the auth-critical customer role (powers
# sign-up / customer login). Every other role can be deleted when unassigned and
# not used as the base of a custom role.
PROTECTED_ROLES = frozenset({Role.SUPER_ADMIN, Role.CUSTOMER})
# Behaviour bases a *custom* role may map to. ADMIN (unrestricted + senior) is
# allowed so a super admin can compose an "admin-like" role from permissions;
# creating/assigning an admin-based role is gated to super admins (see the role
# views + user-management guards). The rest are club-scoped staff tiers.
CUSTOM_BASE_ROLES = [Role.ADMIN, Role.MANAGER, Role.FACILITY_OPERATOR, Role.FACILITY_STAFF]

_ROLE_CACHE_KEY = "role_registry_v2"


def invalidate_role_cache():
    cache.delete(_ROLE_CACHE_KEY)


def role_registry() -> dict:
    """Cached map: slug -> {name, base_role, permissions, is_system}."""
    data = cache.get(_ROLE_CACHE_KEY)
    if data is None:
        from .models import RoleAccess
        data = {
            ra.role: {
                "name": ra.name or dict(Role.choices).get(ra.role, ra.role.title()),
                "base_role": ra.base_role or ra.role,
                "permissions": list(ra.permissions or []),
                "is_system": ra.is_system,
            }
            for ra in RoleAccess.objects.all()
        }
        cache.set(_ROLE_CACHE_KEY, data, 300)
    return data


def base_role_for(slug: str) -> str:
    """The system role whose *behaviour* a slug maps to."""
    entry = role_registry().get(slug)
    if entry:
        return entry["base_role"]
    return slug if slug in Role.values else Role.CUSTOMER


def valid_role(slug: str) -> bool:
    return slug in role_registry() or slug in Role.values


def is_senior_role(slug: str) -> bool:
    return base_role_for(slug) in SENIOR_ROLES


def get_role_permissions(slug: str) -> set:
    """A role's permission set — from the registry if defined, else defaults."""
    if base_role_for(slug) == Role.SUPER_ADMIN:
        return set(ALL_PERMISSIONS)
    entry = role_registry().get(slug)
    if entry is not None:
        return set(entry["permissions"]) & set(ALL_PERMISSIONS)
    return set(DEFAULT_ROLE_PERMISSIONS.get(slug, frozenset()))


def resolve_permissions(slug: str, overrides: dict | None) -> set:
    """Effective permissions for a user: role set ± per-user overrides."""
    if base_role_for(slug) == Role.SUPER_ADMIN:
        return set(ALL_PERMISSIONS)
    base = get_role_permissions(slug)
    overrides = overrides or {}
    grant = set(overrides.get("grant", [])) & set(ALL_PERMISSIONS)
    revoke = set(overrides.get("revoke", [])) & set(ALL_PERMISSIONS)
    return (base | grant) - revoke


def clean_overrides(overrides: dict | None) -> dict:
    overrides = overrides or {}
    grant = sorted(set(overrides.get("grant", [])) & set(ALL_PERMISSIONS))
    revoke = sorted(set(overrides.get("revoke", [])) & set(ALL_PERMISSIONS))
    return {"grant": grant, "revoke": revoke}


def ensure_role_defaults():
    """Seed/refresh the six system roles in the registry (non-destructive)."""
    from .models import RoleAccess
    for role in SYSTEM_ROLES:
        defaults = sorted(DEFAULT_ROLE_PERMISSIONS.get(role, []))
        obj, created = RoleAccess.objects.get_or_create(
            role=role,
            defaults={
                "name": dict(Role.choices)[role],
                "base_role": role,
                "is_system": True,
                "permissions": defaults,
            },
        )
        if not created:
            # Keep admin-customised permissions; just ensure metadata is correct.
            obj.name = obj.name or dict(Role.choices)[role]
            obj.base_role = role
            obj.is_system = True
            obj.save()
    invalidate_role_cache()
