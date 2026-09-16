"""Lightweight audit middleware — records every mutating API request.

Kept minimal in Phase 1; Phase 5 adds domain-level events (e.g. role change,
money movement, post-completion booking edits).
"""

import logging

from django.utils.deprecation import MiddlewareMixin

logger = logging.getLogger(__name__)

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
TRACKED_PREFIX = "/api/"


class AuditLogMiddleware(MiddlewareMixin):
    def process_response(self, request, response):
        try:
            if (
                request.method not in SAFE_METHODS
                and request.path.startswith(TRACKED_PREFIX)
            ):
                self._record(request, response)
        except Exception:  # never break a request for audit failure
            logger.exception("Audit log write failed")
        return response

    def _record(self, request, response):
        from .models import AuditLog  # local import — avoids app-loading cycle

        AuditLog.objects.create(
            actor=request.user if getattr(request.user, "is_authenticated", False) else None,
            method=request.method,
            path=request.path[:512],
            status_code=response.status_code,
            ip=self._client_ip(request),
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:255],
        )

    @staticmethod
    def _client_ip(request):
        xff = request.META.get("HTTP_X_FORWARDED_FOR")
        if xff:
            return xff.split(",")[0].strip()
        return request.META.get("REMOTE_ADDR")
