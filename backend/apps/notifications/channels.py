"""Pluggable notification channel adapters.

Email uses Django's configured backend (console in dev). SMS and push are
stubbed — they log and report success so the delivery flow is exercised
end-to-end without a real provider. Phase-next can drop in Twilio / FCM here.
"""

import logging

from django.conf import settings
from django.core.mail import send_mail

logger = logging.getLogger(__name__)


class ChannelError(Exception):
    pass


def send_email(to_address: str, subject: str, body: str) -> None:
    if not to_address:
        raise ChannelError("No email address for recipient.")
    send_mail(
        subject=subject or "(no subject)",
        message=body,
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[to_address],
        fail_silently=False,
    )


def send_sms(to_address: str, subject: str, body: str) -> None:
    if not to_address:
        raise ChannelError("No phone number for recipient.")
    # Stub: a real adapter (e.g. Twilio) would POST to the provider here.
    logger.info("[SMS stub] to=%s body=%s", to_address, body)


def send_push(to_address: str, subject: str, body: str) -> None:
    # Stub: a real adapter (e.g. FCM) would push to the device token here.
    logger.info("[PUSH stub] to=%s subject=%s", to_address, subject)


DISPATCHERS = {
    "email": send_email,
    "sms": send_sms,
    "push": send_push,
}


def deliver(channel: str, to_address: str, subject: str, body: str) -> None:
    handler = DISPATCHERS.get(channel)
    if handler is None:
        raise ChannelError(f"Unknown channel '{channel}'.")
    handler(to_address, subject, body)
