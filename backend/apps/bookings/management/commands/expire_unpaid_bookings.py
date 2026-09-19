"""Release courts held by online checkouts that were never completed.

The same work a scheduled job does, available as a command so a deployment
without a worker can run it from cron and so an expiry can be triggered by
hand while testing.

Deliberately narrow: a pay-at-venue booking, a part-paid booking, a booking
with a live split arrangement and anything staff have touched are all left
alone. See `expire_unpaid_bookings` for why each of those matters.
"""

from django.core.management.base import BaseCommand

from apps.bookings.services import PAYMENT_WINDOW_MINUTES, expire_unpaid_bookings


class Command(BaseCommand):
    help = "Release bookings whose online payment window has passed."

    def handle(self, *args, **options):
        released = expire_unpaid_bookings()
        self.stdout.write(self.style.SUCCESS(
            f"Released {released} booking(s) whose online payment was not "
            f"completed within {PAYMENT_WINDOW_MINUTES} minutes. "
            "Pay-at-venue and part-paid bookings were not touched."))
