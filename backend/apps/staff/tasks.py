"""Async / scheduled staff tasks (run eagerly unless USE_CELERY=True)."""

import logging

from celery import shared_task

logger = logging.getLogger("staff.tasks")


@shared_task
def activate_due_transfers_task():
    """Beat-scheduled: complete approved club transfers that are now due.

    Mirrors `manage.py activate_due_transfers`; the Staff Details page also
    activates lazily on load, so this is the headless backstop. Returns the
    count activated.
    """
    from .services import activate_due_transfers

    count = activate_due_transfers()
    if count:
        logger.info("activate_due_transfers_task activated %s transfer(s).", count)
    return count
