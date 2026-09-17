from django.core.management.base import BaseCommand

from apps.payments.services import expire_due_memberships


class Command(BaseCommand):
    help = "Expire active memberships whose end date has passed."

    def handle(self, *args, **options):
        count = expire_due_memberships()
        self.stdout.write(self.style.SUCCESS(f"Expired {count} membership(s)."))
