"""Domain-level audit hooks.

The middleware records a baseline row for every mutating API request; this
helper lets views attach a richer, semantic event (e.g. a booking status
change, a post-completion edit, a money movement) to the same audit trail via
the `payload_summary` JSON field.
"""

import logging

logger = logging.getLogger(__name__)


def _client_ip(request):
    xff = request.META.get("HTTP_X_FORWARDED_FOR")
    if xff:
        return xff.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


def log_event(request, event: str, summary: dict | None = None, status_code: int = 200,
              actor=None, subject=None):
    """Write a domain audit event. Never raises — auditing must not break a request.

    Pass `actor` explicitly when the caller already has the user and must NOT
    touch `request.user` — e.g. from inside authentication, where reading
    `request.user` would re-trigger authentication (re-entrancy).

    `subject` optionally links the event to the ENTITY it's about (vs the actor
    who did it), as a ("type", id) tuple — e.g. ("staff", 12). This powers
    per-entity activity timelines. `None` leaves the subject blank.
    """
    from .models import AuditLog

    try:
        if actor is None:
            actor = request.user if getattr(request.user, "is_authenticated", False) else None
        payload = {"event": event}
        if summary:
            payload.update(summary)
        subject_type, subject_id = "", ""
        if subject:
            subject_type = str(subject[0])[:32]
            subject_id = str(subject[1])[:64]
        AuditLog.objects.create(
            actor=actor,
            method=request.method,
            path=request.path[:512],
            status_code=status_code,
            ip=_client_ip(request),
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:255],
            payload_summary=payload,
            subject_type=subject_type,
            subject_id=subject_id,
        )
    except Exception:  # pragma: no cover - defensive
        logger.exception("Domain audit event write failed: %s", event)


def log_system_event(event: str, summary: dict | None = None, *, subject=None, actor=None):
    """Audit an action performed by the SYSTEM (no HTTP request) — e.g. a
    scheduled-transfer activation run from a cron/Celery task. Same trail, no
    request context."""
    from .models import AuditLog

    try:
        payload = {"event": event, "system": True}
        if summary:
            payload.update(summary)
        subject_type, subject_id = "", ""
        if subject:
            subject_type = str(subject[0])[:32]
            subject_id = str(subject[1])[:64]
        AuditLog.objects.create(
            actor=actor, method="SYSTEM", path="system/scheduled", status_code=200,
            payload_summary=payload, subject_type=subject_type, subject_id=subject_id,
        )
    except Exception:  # pragma: no cover - defensive
        logger.exception("System audit event write failed: %s", event)
