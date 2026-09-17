"""Complete approved staff club transfers whose effective date has arrived.

Run from cron (or a Celery beat schedule) — e.g. daily:
    python manage.py activate_due_transfers
The Staff Details page also activates lazily on load, so this is a backstop for
headless operation.
"""

from django.core.management.base import BaseCommand

from apps.staff.services import activate_due_transfers


class Command(BaseCommand):
    help = "Activate (complete) approved staff club transfers that are now due."

    def handle(self, *args, **options):
        count = activate_due_transfers()
        self.stdout.write(self.style.SUCCESS(f"Activated {count} due transfer(s)."))
