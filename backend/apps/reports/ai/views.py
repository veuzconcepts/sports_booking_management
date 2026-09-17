"""The AI Insights endpoints.

Every one is gated by the same `reports.view` capability as the rest of the
Reports page, and every one resolves its own scope from the signed-in user.
Nothing here accepts a scope, an organization or a club from the client without
checking it, and nothing here writes business data.
"""

from __future__ import annotations

import logging

from django.http import HttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auditlogs.services import log_event

from .. import exporters
from ..permissions import CanViewReports
from . import cache as report_cache
from . import client, service, tools

logger = logging.getLogger(__name__)

MAX_QUESTION_LENGTH = 500


class AiCapabilitiesView(APIView):
    """What this user can ask, and whether the assistant is available at all."""

    permission_classes = [permissions.IsAuthenticated, CanViewReports]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        return Response(service.capabilities(request.user))


class AiAskView(APIView):
    """Ask a reporting question."""

    permission_classes = [permissions.IsAuthenticated, CanViewReports]

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def post(self, request):
        question = str(request.data.get("question") or "").strip()
        if not question:
            return Response({"detail": "Ask a question first."},
                            status=status.HTTP_400_BAD_REQUEST)
        if len(question) > MAX_QUESTION_LENGTH:
            return Response(
                {"detail": f"Keep the question under {MAX_QUESTION_LENGTH} characters."},
                status=status.HTTP_400_BAD_REQUEST)

        session_id = str(request.data.get("session_id") or "default")[:64]
        refresh = bool(request.data.get("refresh"))

        try:
            payload = service.ask(request.user, question, session_id, refresh=refresh)
        except client.AiUnavailable as exc:
            # Deliberately not a 500: the Reports page is fine, one panel is not.
            return Response({"detail": str(exc)},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)

        # The question and the figures are not written to the audit trail; what
        # is useful later is that a report was run, by whom, and how.
        log_event(request, "ai_report_requested", {
            "tools": payload.get("tools_used"),
            "cached": payload.get("cached"),
            "tokens": (payload.get("usage") or {}).get("total_tokens"),
        })
        return Response(payload)


class AiSessionView(APIView):
    """Start a new conversation."""

    permission_classes = [permissions.IsAuthenticated, CanViewReports]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def delete(self, request):
        session_id = str(request.query_params.get("session_id") or "default")[:64]
        report_cache.clear_session(request.user.id, session_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class AiExportView(APIView):
    """Download a report the assistant already produced.

    Reuses the stored dataset rather than asking the model again: the file has
    to contain the figures the user saw, and a second generation could differ.
    It is also the difference between an export costing nothing and costing a
    provider call.
    """

    permission_classes = [permissions.IsAuthenticated, CanViewReports]

    @extend_schema(responses=OpenApiTypes.BINARY)
    def get(self, request):
        report_id = request.query_params.get("report_id") or ""
        fmt = request.query_params.get("fmt", "xlsx")
        if fmt not in ("xlsx", "pdf"):
            return Response({"detail": "fmt must be 'xlsx' or 'pdf'."},
                            status=status.HTTP_400_BAD_REQUEST)

        scope = tools.ReportScope.for_user(request.user)
        # Checked against the CURRENT scope, so a report generated before a
        # permission change cannot be downloaded after it.
        entry = report_cache.load_report(report_id, request.user.id, scope.signature())
        if not entry:
            return Response(
                {"detail": "That report is no longer available. Ask the question again."},
                status=status.HTTP_404_NOT_FOUND)

        sheets = exporters.ai_report_sheets(entry)
        if fmt == "pdf":
            content = exporters.ai_report_to_pdf(entry, sheets)
            ctype = "application/pdf"
        else:
            content = exporters.ai_report_to_xlsx(entry, sheets)
            ctype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

        log_event(request, "ai_report_exported", {"format": fmt})

        response = HttpResponse(content, content_type=ctype)
        # A generated name, not the question: a question can contain a customer
        # name, and a filename ends up in logs and download histories.
        response["Content-Disposition"] = f'attachment; filename="insights-report.{fmt}"'
        return response
