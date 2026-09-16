"""Promote a user to the single Super-Admin (owner) account.

    manage.py promote_super_admin <email> [--demote-others]

Refuses to "steal" ownership if another owner already exists — to reassign a
live owner, use the in-app transfer (the super admin calls
`POST /auth/users/{id}/transfer-super-admin/`). With --demote-others, any
*other* user holding the super_admin role is demoted to admin (audited).
This command is for bootstrap / CLI recovery.
"""

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.accounts.models import Role
from apps.auditlogs.services import log_event


class _CliRequest:
    """Minimal request shim so the CLI can reuse auditlogs.log_event.

    `user = None` => log_event records a system (actor-less) event.
    """

    def __init__(self):
        self.user = None
        self.method = "CLI"
        self.path = "cli:promote_super_admin"
        self.META = {}


class Command(BaseCommand):
    help = "Promote a user to the single Super-Admin (owner) account."

    def add_arguments(self, parser):
        parser.add_argument("email", help="Email of the user to promote.")
        parser.add_argument(
            "--demote-others", action="store_true",
            help="Demote any other super_admin-role users to admin.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        User = get_user_model()
        email = (options["email"] or "").strip().lower()

        try:
            target = User.objects.get(email__iexact=email)
        except User.DoesNotExist:
            raise CommandError(f"No user found with email {email!r}.")

        existing = (
            User.objects.filter(is_super_admin=True).exclude(pk=target.pk).first()
        )
        if existing:
            raise CommandError(
                f"{existing.email} is already the Super-Admin owner. "
                "Ownership is single-holder; the current super admin reassigns it "
                "via POST /auth/users/{id}/transfer-super-admin/ (not this command)."
            )

        req = _CliRequest()

        if options["demote_others"]:
            others = User.objects.filter(role=Role.SUPER_ADMIN).exclude(pk=target.pk)
            for user in others:
                user.role = Role.ADMIN
                user.role_slug = ""  # fall back to the behaviour role
                user.save(update_fields=["role", "role_slug", "updated_at"])
                log_event(req, "super_admin_demoted",
                          {"user": user.email, "by": "cli", "new_role": Role.ADMIN})
                self.stdout.write(f"Demoted {user.email} -> admin")

        target.role = Role.SUPER_ADMIN
        target.role_slug = ""
        target.is_super_admin = True
        target.clean()  # enforce the owner/role invariant before saving
        target.save(update_fields=["role", "role_slug", "is_super_admin", "updated_at"])
        log_event(req, "super_admin_promoted", {"user": target.email, "by": "cli"})

        self.stdout.write(self.style.SUCCESS(
            f"{target.email} is now the Super-Admin owner."
        ))
