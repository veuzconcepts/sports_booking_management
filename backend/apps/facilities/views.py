"""Facility catalogue endpoints: categories, facility types, facilities,
add-ons and pricing rules."""

from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import APIException
from rest_framework.response import Response

from apps.accounts.permissions import FacilityCatalogPermission
from apps.settings_app.currency import decimals_for, get_default_currency

from .models import (
    AddOn,
    Facility,
    FacilityCategory,
    FacilityType,
    MaintenanceBlock,
    PricingRule,
)
from .pricing import adjustment_label, apply_adjustment
from .serializers import (
    AddOnSerializer,
    FacilityCategorySerializer,
    FacilitySerializer,
    FacilityTypeSerializer,
    MaintenanceBlockSerializer,
    PricingRuleSerializer,
)


class InUse(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "This record is still in use."


class FacilityCategoryViewSet(viewsets.ModelViewSet):
    queryset = FacilityCategory.objects.prefetch_related("available_clubs").all()
    serializer_class = FacilityCategorySerializer
    permission_classes = [FacilityCatalogPermission]
    filterset_fields = ["kind", "is_active"]
    search_fields = ["name", "description", "slug"]
    ordering_fields = ["display_order", "name", "base_price"]

    def destroy(self, request, *args, **kwargs):
        """Only allow deletion when no other records reference this category."""
        instance = self.get_object()
        blockers = []

        booking_count = instance.bookings.count()
        if booking_count:
            blockers.append(f"{booking_count} booking(s)")

        if blockers:
            return Response(
                {
                    "detail": (
                        "This category cannot be deleted because it is still used by "
                        + " and ".join(blockers)
                        + ". Reassign or remove those records first."
                    )
                },
                status=status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class FacilityTypeViewSet(viewsets.ModelViewSet):
    queryset = (
        FacilityType.objects
        .prefetch_related("categories", "add_ons", "available_clubs")
        .all()
    )
    serializer_class = FacilityTypeSerializer
    permission_classes = [FacilityCatalogPermission]
    filterset_fields = ["categories", "is_active", "online_booking_enabled"]
    search_fields = ["name", "description", "categories__name"]
    ordering_fields = ["name", "duration_minutes", "price", "created_at"]


class FacilityViewSet(viewsets.ModelViewSet):
    """Physical bookable units (courts, pitches, lanes, halls, rooms)."""

    queryset = (Facility.objects.select_related("club")
                .prefetch_related("facility_types").all())
    serializer_class = FacilitySerializer
    permission_classes = [permissions.IsAuthenticated, FacilityCatalogPermission]
    filterset_fields = ["club", "is_active", "facility_types"]
    search_fields = ["name", "club__name", "club__code"]
    ordering_fields = ["name"]

    def get_queryset(self):
        qs = super().get_queryset()
        club_ids = self.request.user.scoped_club_ids()
        return qs if club_ids is None else qs.filter(club_id__in=club_ids)

    def perform_destroy(self, instance):
        reasons = []
        if instance.bookings.exists():
            reasons.append("bookings")
        if instance.assigned_users.exists():
            reasons.append("assigned users")
        if reasons:
            raise InUse(f"This facility is still in use: {', '.join(reasons)}. "
                        "Remove those links first, then delete it.")
        instance.delete()


class PricingRuleViewSet(viewsets.ModelViewSet):
    queryset = (
        PricingRule.objects
        .prefetch_related("categories", "facility_types", "addons", "clubs", "membership_plans")
        .all()
    )
    serializer_class = PricingRuleSerializer
    permission_classes = [FacilityCatalogPermission]
    filterset_fields = ["is_active", "rule_type", "adjustment_type"]
    search_fields = ["name", "code", "description"]
    ordering_fields = ["priority", "display_order", "name", "valid_from", "created_at"]

    @action(detail=False, methods=["post"])
    def preview(self, request):
        """Preview how an adjustment changes a base price (calculation in backend)."""
        try:
            base = float(request.data.get("base_price") or 0)
            value = float(request.data.get("adjustment_value") or 0)
        except (TypeError, ValueError):
            return Response({"detail": "Invalid numbers."}, status=status.HTTP_400_BAD_REQUEST)
        adj_type = request.data.get("adjustment_type")
        final, delta = apply_adjustment(base, adj_type, value)
        if final < 0:
            final = type(final)(0)
        cur = get_default_currency()
        dp = decimals_for(cur)
        return Response({
            "base_price": round(base, dp),
            "adjustment_type": adj_type,
            "adjustment_label": adjustment_label(adj_type, value),
            "adjustment_amount": round(float(delta), dp),
            "final_price": round(float(final), dp),
            "currency": cur,
        })


class AddOnViewSet(viewsets.ModelViewSet):
    queryset = (
        AddOn.objects
        .prefetch_related("categories", "available_clubs")
        .all()
    )
    serializer_class = AddOnSerializer
    permission_classes = [FacilityCatalogPermission]
    filterset_fields = ["is_active", "is_featured", "categories", "available_all_clubs"]
    search_fields = ["name", "code", "description", "categories__name"]
    ordering_fields = ["display_order", "name", "price"]


class MaintenanceBlockViewSet(viewsets.ModelViewSet):
    """Periods a facility is out of service. Counts against capacity exactly
    like a booking, so a blocked court simply stops being offered."""

    queryset = (MaintenanceBlock.objects
                .select_related("facility", "facility__club").all())
    serializer_class = MaintenanceBlockSerializer
    permission_classes = [permissions.IsAuthenticated, FacilityCatalogPermission]
    filterset_fields = ["facility", "facility__club"]
    search_fields = ["reason", "facility__name"]
    ordering_fields = ["start_date", "end_date"]

    def get_queryset(self):
        qs = super().get_queryset()
        club_ids = self.request.user.scoped_club_ids()
        if club_ids is not None:
            qs = qs.filter(facility__club_id__in=club_ids)
        # `?active_on=YYYY-MM-DD` - blocks in force on a given day.
        on_date = self.request.query_params.get("active_on")
        if on_date:
            qs = qs.filter(start_date__lte=on_date, end_date__gte=on_date)
        return qs

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)
