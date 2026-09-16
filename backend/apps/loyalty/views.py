"""Loyalty config, tiers and reports endpoints."""

from rest_framework import permissions, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auditlogs.services import log_event

from . import services
from .models import LoyaltyConfiguration, LoyaltyTier
from .permissions import (
    LoyaltyConfigPermission,
    LoyaltyLedgerPermission,
    LoyaltyTierPermission,
)
from .serializers import LoyaltyConfigurationSerializer, LoyaltyTierSerializer


class LoyaltyConfigView(APIView):
    """Read/update the single loyalty rules row (earning, redemption, expiry)."""

    permission_classes = [permissions.IsAuthenticated, LoyaltyConfigPermission]

    def get(self, request):
        return Response(LoyaltyConfigurationSerializer(LoyaltyConfiguration.get_solo()).data)

    def put(self, request):
        cfg = LoyaltyConfiguration.get_solo()
        ser = LoyaltyConfigurationSerializer(cfg, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        log_event(request, "loyalty_config_updated", {"changes": {"loyalty": "updated"}})
        return Response(ser.data)

    def patch(self, request):
        return self.put(request)


class LoyaltyTierViewSet(viewsets.ModelViewSet):
    queryset = LoyaltyTier.objects.all().order_by("rank")
    serializer_class = LoyaltyTierSerializer
    permission_classes = [permissions.IsAuthenticated, LoyaltyTierPermission]


class LoyaltyReportViewSet(viewsets.ViewSet):
    """Loyalty reporting: issued/redeemed/expired, tier distribution, top
    customers, outstanding liability. Gated by `loyalty.view_ledger`."""

    permission_classes = [permissions.IsAuthenticated, LoyaltyLedgerPermission]

    def _range(self, request):
        return (request.query_params.get("date_from") or None,
                request.query_params.get("date_to") or None)

    @action(detail=False, methods=["get"])
    def summary(self, request):
        df, dt = self._range(request)
        return Response(services.points_summary_report(df, dt))

    @action(detail=False, methods=["get"], url_path="tier-distribution")
    def tier_distribution(self, request):
        return Response(services.tier_distribution_report())

    @action(detail=False, methods=["get"], url_path="top-customers")
    def top_customers(self, request):
        try:
            limit = int(request.query_params.get("limit", 20))
        except (TypeError, ValueError):
            limit = 20
        return Response(services.top_customers_report(limit=limit))

    @action(detail=False, methods=["get"])
    def liability(self, request):
        return Response(services.liability_report())
