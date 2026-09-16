from django.conf import settings
from django.db import models


class AuditLog(models.Model):
    """Immutable record of sensitive actions.

    Phase 5 will expose this through a read-only admin viewer and add
    domain hooks (booking-after-completion edits, role changes, money moves).
    The middleware writes a baseline row for every non-safe API request.
    """

    METHOD_CHOICES = [
        ("POST", "POST"), ("PUT", "PUT"), ("PATCH", "PATCH"), ("DELETE", "DELETE"),
    ]

    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="audit_entries",
    )
    method = models.CharField(max_length=10, choices=METHOD_CHOICES)
    path = models.CharField(max_length=512)
    status_code = models.PositiveSmallIntegerField()
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=255, blank=True)
    payload_summary = models.JSONField(default=dict, blank=True)
    # Optional link to the entity this event is ABOUT (vs `actor` = who did it),
    # e.g. ("staff", "12"). Enables per-entity activity timelines without forking
    # the audit system. Blank for untagged / baseline rows.
    subject_type = models.CharField(max_length=32, blank=True, db_index=True)
    subject_id = models.CharField(max_length=64, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["-created_at"]),
            models.Index(fields=["actor", "-created_at"]),
            models.Index(fields=["subject_type", "subject_id", "-created_at"]),
        ]

    def __str__(self):
        actor = self.actor.email if self.actor else "anonymous"
        return f"[{self.created_at:%Y-%m-%d %H:%M}] {actor} {self.method} {self.path} → {self.status_code}"
