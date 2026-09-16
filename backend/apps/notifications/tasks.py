"""Async notification delivery (runs eagerly unless USE_CELERY=True)."""

import logging

from celery import shared_task
from django.contrib.auth import get_user_model

logger = logging.getLogger("notifications.tasks")


@shared_task(bind=True, max_retries=3, default_retry_delay=30)
def deliver_notification_task(self, recipient_id, template_code, context=None, event=None):
    """Render + record + send a notification to a user (by id, so it's serializable)."""
    from .services import notify

    recipient = get_user_model().objects.filter(pk=recipient_id).first()
    if recipient is None:
        return None
    try:
        notify(recipient, template_code, context or {}, event=event)
    except Exception as exc:  # pragma: no cover - retry path
        logger.exception("Notification %s delivery failed for user %s", template_code, recipient_id)
        raise self.retry(exc=exc)
    return recipient_id
