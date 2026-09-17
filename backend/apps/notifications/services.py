"""Notification dispatcher.

`notify(recipient, template_code, context)` renders the named template, writes a
`Notification` log row, attempts delivery via the channel adapter, and records
the outcome. Never raises — a notification failure must not break the action
that triggered it.
"""

import logging

from django.utils import timezone

from . import channels
from .models import (
    Notification,
    NotificationChannel,
    NotificationStatus,
    NotificationTemplate,
)

logger = logging.getLogger(__name__)


def _render(text: str, context: dict) -> str:
    try:
        return text.format(**context)
    except (KeyError, IndexError, ValueError):
        # Leave unresolved placeholders intact rather than failing the send.
        return text


def _address_for(recipient, channel: str) -> str:
    if recipient is None:
        return ""
    if channel == NotificationChannel.EMAIL:
        return recipient.email or ""
    if channel == NotificationChannel.SMS:
        return getattr(recipient, "phone", "") or ""
    return str(recipient.id)  # push: device token stand-in


def notify_in_app(recipient, subject: str, body: str = "", *, event: str = "",
                  link: str = "", context: dict | None = None) -> Notification | None:
    """Create an in-app (bell) notification for a single user. No external gateway —
    it's marked SENT immediately and shows in the recipient's feed until read.
    Never raises."""
    if recipient is None:
        return None
    try:
        return Notification.objects.create(
            recipient=recipient, to_address=str(recipient.id),
            channel=NotificationChannel.IN_APP, event=event,
            subject=subject[:200], body=body, link=link[:255], context=context or {},
            status=NotificationStatus.SENT, sent_at=timezone.now(),
        )
    except Exception:  # pragma: no cover - defensive
        logger.exception("notify_in_app() failed for event %s", event)
        return None


def notify_in_app_many(recipients, subject: str, body: str = "", *, event: str = "",
                       link: str = "", context: dict | None = None) -> int:
    """Fan an in-app notification out to many users (deduped, skips falsy). Returns
    how many were created."""
    seen, n = set(), 0
    for r in recipients:
        if not r or r.id in seen:
            continue
        seen.add(r.id)
        if notify_in_app(r, subject, body, event=event, link=link, context=context):
            n += 1
    return n


def booking_notification_recipients(club, capability: str = "bookings.view"):
    """Active staff who can act on this booking's club: assigned to `club`
    (or club-unrestricted admins) AND holding the booking capability.

    Club-scoped roles must be assigned to the club; unrestricted roles
    (super-admin/admin) always qualify. The capability is resolved per user
    (role defaults ± per-user overrides), so it can't be queried in SQL — we
    narrow with the cheap filters first, then test the capability in Python.
    """
    from django.contrib.auth import get_user_model
    from django.db.models import Q

    from apps.accounts.access import UNRESTRICTED_ROLES
    from apps.accounts.models import STAFF_ROLES

    User = get_user_model()
    qs = User.objects.filter(is_active=True, role__in=STAFF_ROLES)
    site_filter = Q(role__in=UNRESTRICTED_ROLES)
    if club is not None:
        site_filter |= Q(assigned_clubs=club)
    qs = qs.filter(site_filter).distinct()
    return [u for u in qs if u.has_perm_code(capability)]


def notify_booking_created(booking) -> int:
    """Bell-notify the staff who own this booking's club + hold booking access
    that a new booking came in. Returns how many were notified. Never raises."""
    try:
        club = getattr(booking, "club", None)
        recipients = booking_notification_recipients(club)
        if not recipients:
            return 0
        who = (getattr(booking.customer, "full_name", "") or booking.walk_in_name or "A customer")
        when = f"{booking.scheduled_date:%a, %d %b} at {booking.scheduled_time:%H:%M}"
        where = club.name if club else "Mobile"
        svc = getattr(booking.facility_type, "name", None) or getattr(booking.service, "name", "service")
        return notify_in_app_many(
            recipients,
            subject=f"New booking · {booking.reference}",
            body=f"{who} booked {svc} - {when} ({where}).",
            event="booking_created",
            link=f"/bookings/{booking.id}",
            context={
                "reference": booking.reference,
                "source": booking.source,
                "club": where,
                "scheduled_date": booking.scheduled_date.isoformat(),
                "scheduled_time": booking.scheduled_time.strftime("%H:%M"),
            },
        )
    except Exception:  # pragma: no cover - defensive
        logger.exception("notify_booking_created() failed")
        return 0


def notify(recipient, template_code: str, context: dict | None = None,
           *, event: str = "") -> Notification | None:
    """Send a templated notification to a user. Returns the log row (or None)."""
    context = context or {}
    try:
        template = NotificationTemplate.objects.filter(
            code=template_code, is_active=True
        ).first()
        if template is None:
            logger.warning("No active notification template '%s'", template_code)
            return None

        subject = _render(template.subject, context)
        body = _render(template.body, context)
        to_address = _address_for(recipient, template.channel)

        notification = Notification.objects.create(
            recipient=recipient,
            to_address=to_address,
            channel=template.channel,
            template=template,
            event=event or template_code,
            subject=subject,
            body=body,
            context=context,
            status=NotificationStatus.PENDING,
        )
        try:
            channels.deliver(template.channel, to_address, subject, body)
            notification.status = NotificationStatus.SENT
            notification.sent_at = timezone.now()
        except Exception as exc:  # noqa: BLE001 - record, don't propagate
            notification.status = NotificationStatus.FAILED
            notification.error = str(exc)[:255]
            logger.warning("Notification %s failed: %s", template_code, exc)
        notification.save(update_fields=["status", "sent_at", "error"])
        return notification
    except Exception:  # pragma: no cover - defensive
        logger.exception("notify() failed for template %s", template_code)
        return None
