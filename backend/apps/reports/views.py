"""Read-only reporting endpoints + Excel/PDF export."""

from datetime import date as date_cls

from django.http import HttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounts import access

from . import exporters, services
from .permissions import CanViewReports


def _owner(request):
    """None when the user may see company-wide reports (reports.view_all);
    otherwise the user, so reports are computed from their own activity."""
    return None if access.can_view_all(request.user, "reports") else request.user


def _parse_range(request):
    def parse(name):
        raw = request.query_params.get(name)
        if not raw:
            return None
        try:
            return date_cls.fromisoformat(raw)
        except ValueError:
            return None
    return parse("date_from"), parse("date_to")


def _parse_club(request):
    raw = request.query_params.get("club")
    return int(raw) if raw and str(raw).isdigit() else None


def _scope_clubs(request):
    """Hard club limit for any club-restricted user (its assigned clubs), driven
    by `assigned_clubs` rather than role name. Returns None for club-unrestricted
    users (super/admin), so they see every club. Reports are staff-only
    (`reports.view`), so customers never reach here."""
    return request.user.scoped_club_ids()


class ReportViewSet(viewsets.ViewSet):
    """Aggregated reports. All actions are manager-and-above, read-only."""

    permission_classes = [permissions.IsAuthenticated, CanViewReports]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["get"])
    def summary(self, request):
        return Response(services.dashboard_summary(
            owner=_owner(request), scope_clubs=_scope_clubs(request)))

    @extend_schema(responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["get"])
    def revenue(self, request):
        date_from, date_to = _parse_range(request)
        return Response(services.revenue_report(
            date_from, date_to, owner=_owner(request),
            club=_parse_club(request), scope_clubs=_scope_clubs(request)))

    @extend_schema(responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["get"])
    def bookings(self, request):
        date_from, date_to = _parse_range(request)
        return Response(services.bookings_report(
            date_from, date_to, owner=_owner(request),
            club=_parse_club(request), scope_clubs=_scope_clubs(request)))

    @extend_schema(responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["get"], url_path="services")
    def top_services(self, request):
        date_from, date_to = _parse_range(request)
        return Response(services.top_services(
            date_from, date_to, owner=_owner(request),
            club=_parse_club(request), scope_clubs=_scope_clubs(request)))

    @extend_schema(responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["get"])
    def performance(self, request):
        date_from, date_to = _parse_range(request)
        return Response(services.performance_report(date_from, date_to, owner=_owner(request)))

    @extend_schema(responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["get"])
    def memberships(self, request):
        date_from, date_to = _parse_range(request)
        return Response(services.memberships_report(
            date_from, date_to, scope_clubs=_scope_clubs(request)))

    @extend_schema(responses=OpenApiTypes.BINARY)
    @action(detail=False, methods=["get"])
    def export(self, request):
        """`?report=revenue|club|services&fmt=xlsx|pdf` → downloadable file.

        Uses `fmt` (not `format`, which DRF reserves for content negotiation).
        Honours the same `date_from`/`date_to`/`club` filters as the reports.
        """
        report_name = request.query_params.get("report", "revenue")
        fmt = request.query_params.get("fmt", "xlsx")
        if fmt not in ("xlsx", "pdf"):
            return Response({"detail": "fmt must be 'xlsx' or 'pdf'."},
                            status=status.HTTP_400_BAD_REQUEST)
        date_from, date_to = _parse_range(request)
        owner, club = _owner(request), _parse_club(request)
        scope = _scope_clubs(request)

        if report_name == "revenue":
            data = services.revenue_report(date_from, date_to, owner=owner, club=club, scope_clubs=scope)
            content = (exporters.revenue_to_pdf if fmt == "pdf" else exporters.revenue_to_xlsx)(data)
        elif report_name == "club":
            rev = {r["club"]: r["net"] for r in
                   services.revenue_report(date_from, date_to, owner=owner, club=club, scope_clubs=scope)["by_club"]}
            bk = services.bookings_report(date_from, date_to, owner=owner, club=club, scope_clubs=scope)
            sub = f"{bk['date_from']} → {bk['date_to']}"
            rows = [(r["name"], r["count"], float(rev.get(r["club"], "0"))) for r in bk["by_club"]]
            content = (exporters.table_to_pdf if fmt == "pdf" else exporters.table_to_xlsx)(
                "Revenue by club", sub, ["Club", "Bookings", "Net revenue"], rows)
        elif report_name == "services":
            top = services.top_services(date_from, date_to, owner=owner, club=club, scope_clubs=scope)
            rows = [(r["name"], r["bookings"], float(r["net"])) for r in top]
            content = (exporters.table_to_pdf if fmt == "pdf" else exporters.table_to_xlsx)(
                "Top services", "", ["Facility type", "Bookings", "Net revenue"], rows)
        else:
            return Response({"detail": "report must be 'revenue', 'club', or 'services'."},
                            status=status.HTTP_400_BAD_REQUEST)

        ctype = ("application/pdf" if fmt == "pdf"
                 else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        resp = HttpResponse(content, content_type=ctype)
        resp["Content-Disposition"] = f'attachment; filename="{report_name}-report.{fmt}"'
        return resp
