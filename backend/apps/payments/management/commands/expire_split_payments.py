"""Close split-payment arrangements whose deadline has passed.

The same work the Celery beat job does, available as a command so a deployment
without a worker can run it from cron, and so it can be run by hand while
testing an expiry. Safe to run repeatedly: expiry only ever acts on
arrangements still marked active.
"""

from django.core.management.base import BaseCommand

from apps.payments.split import expire_due_splits


class Command(BaseCommand):
    help = "Expire split payment arrangements past their deadline."

    def handle(self, *args, **options):
        closed = expire_due_splits()
        self.stdout.write(self.style.SUCCESS(
            f"Expired {closed} split payment arrangement(s). "
            "No money was moved and no booking was changed."))
