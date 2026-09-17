"""Single Super-Admin (owner) election helper.

The owner account is identified by `User.is_super_admin = True`, of which there
may be at most one (DB partial unique constraint + model `clean()`).

`elect_single_super_admin` only auto-elects when the choice is *unambiguous*
(exactly one super_admin-role user). It never demotes anyone. Shared by the
data migration and the `promote_super_admin` management command's safety checks.
"""

# Use the role *string* (not the enum) so this stays safe to call from a
# historical model inside a data migration.
SUPER_ADMIN_ROLE = "super_admin"


def super_admin_candidates(user_model):
    """Users that hold the super_admin behaviour role."""
    return user_model.objects.filter(role=SUPER_ADMIN_ROLE)


def elect_single_super_admin(user_model):
    """Elect the owner only when unambiguous.

    Returns a (status, payload) tuple:
      ("elected", email)        — exactly one super_admin user; it was marked owner
      ("none", None)            — no super_admin users; nothing changed
      ("ambiguous", [emails])   — multiple super_admin users; nothing changed
    """
    qs = super_admin_candidates(user_model)
    count = qs.count()
    if count == 1:
        user = qs.first()
        if not user.is_super_admin:
            user.is_super_admin = True
            user.save(update_fields=["is_super_admin"])
        return ("elected", user.email)
    if count == 0:
        return ("none", None)
    return ("ambiguous", list(qs.values_list("email", flat=True)))
