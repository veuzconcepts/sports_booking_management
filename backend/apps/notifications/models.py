"""Notifications — templates and a delivery log.

A `NotificationTemplate` holds reusable subject/body text with `{placeholders}`
per channel. Every send produces a `Notification` row (the delivery log) whose
`status` reflects the dispatch outcome. Channel adapters live in `channels.py`;
the dispatcher in `services.py` renders a template and records the result.
"""

from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _


class NotificationChannel(models.TextChoices):
    EMAIL = "email", _("Email")
    SMS = "sms", _("SMS")
    PUSH = "push", _("Push")
    IN_APP = "in_app", _("In-app")        # shown in the bell feed, no external gateway


class NotificationStatus(models.TextChoices):
    PENDING = "pending", _("Pending")
    SENT = "sent", _("Sent")
    FAILED = "failed", _("Failed")


class NotificationTemplate(models.Model):
    code = models.SlugField(
        max_length=60, unique=True,
        help_text="Stable identifier the dispatcher looks up, e.g. 'booking_confirmed'.",
    )
    name = models.CharField(max_length=120)
    channel = models.CharField(
        max_length=10, choices=NotificationChannel.choices,
        default=NotificationChannel.EMAIL,
    )
    subject = models.CharField(
        max_length=200, blank=True,
        help_text="Supports {placeholders} filled from the event context.",
    )
    body = models.TextField(help_text="Supports {placeholders} from the event context.")
    is_active = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("code",)

    def __str__(self):
        return f"{self.code} ({self.channel})"


class Notification(models.Model):
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="notifications",
        null=True, blank=True,
    )
    to_address = models.CharField(
        max_length=255, blank=True,
        help_text="Resolved email / phone / device token at send time.",
    )
    channel = models.CharField(max_length=10, choices=NotificationChannel.choices)
    template = models.ForeignKey(
        NotificationTemplate,
        on_delete=models.SET_NULL,
        related_name="notifications",
        null=True, blank=True,
    )
    event = models.CharField(max_length=60, blank=True)
    subject = models.CharField(max_length=200, blank=True)
    body = models.TextField(blank=True)
    status = models.CharField(
        max_length=10, choices=NotificationStatus.choices,
        default=NotificationStatus.PENDING, db_index=True,
    )
    error = models.CharField(max_length=255, blank=True)
    context = models.JSONField(default=dict, blank=True)
    # Deep-link the recipient straight to the subject (e.g. an invoice/credit note).
    link = models.CharField(max_length=255, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    # When the recipient opened it (in-app feed). Null = unread.
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["status", "-created_at"]),
            models.Index(fields=["recipient", "-created_at"]),
        ]

    def __str__(self):
        return f"{self.channel} → {self.to_address} [{self.status}]"
