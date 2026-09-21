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


@shared_task
def expire_holds_task():
    """Close reservations whose deadline has passed.

    Not a correctness guarantee, and deliberately so. Every read path already
    checks the clock as well as the status, because a sweep that runs every
    few minutes leaves rows sitting ACTIVE past their deadline in between, and
    a court must never be blocked by one of those. `reservations.require_live`
    is what actually protects a booking.

    This is housekeeping: without it the table fills with rows that claim to
    be active, which makes every "what is live right now?" question staff ask
    answer wrongly, and gives anybody reading the data a false picture of how
    much stock is tied up.
    """
    from . import reservations

    closed = reservations.expire_due()
    if closed:
        logger.info("Closed %s reservation(s) past their deadline.", closed)
    return closed
