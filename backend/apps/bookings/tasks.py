"""Scheduled booking lifecycle jobs (run eagerly unless USE_CELERY=True)."""

import logging

from celery import shared_task

logger = logging.getLogger("bookings.tasks")


@shared_task
def expire_unpaid_bookings_task():
    """Release courts held by online checkouts that were never completed.

    Runs every few minutes because the payment window is measured in minutes:
    a nightly sweep would hold a busy evening slot all day for somebody who
    closed the tab.

    Narrow on purpose. A pay-at-venue booking, a part-paid booking, one with
    a live split arrangement, one staff have touched, and one whose payment
    method was never recorded are all left alone. See
    `services.expire_unpaid_bookings` for why each of those matters: an
    automatic cancel is the one mistake here a customer feels directly, by
    arriving to find their court gone.
    """
    from .services import expire_unpaid_bookings

    released = expire_unpaid_bookings()
    if released:
        logger.info("Released %s booking(s) whose payment window passed.",
                    released)
    return released
