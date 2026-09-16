"""Promo code endpoints: CRUD + bulk generation."""

import secrets
import string

from rest_framework import filters, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.auditlogs.services import log_event

from .models import PromoCode
from .permissions import PromoPermission
from .serializers import BulkPromoSerializer, PromoCodeSerializer, PromoRedemptionSerializer

# Unambiguous alphabet (no O/0/I/1) for human-readable codes.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _suffix(n):
    return "".join(secrets.choice(_ALPHABET) for _ in range(n))


class PromoCodeViewSet(viewsets.ModelViewSet):
    queryset = PromoCode.objects.all()
    serializer_class = PromoCodeSerializer
    permission_classes = [permissions.IsAuthenticated, PromoPermission]
    filterset_fields = ["is_active", "discount_type", "batch"]
    search_fields = ["code", "description", "batch"]
    ordering_fields = ["created_at", "code", "valid_to", "used_count"]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]

    def perform_create(self, serializer):
        promo = serializer.save(created_by=self.request.user)
        log_event(self.request, "promo_created", {"code": promo.code}, status_code=201)

    def perform_destroy(self, instance):
        # Once redeemed, keep history — deactivate instead of deleting.
        if instance.used_count > 0:
            from rest_framework.exceptions import ValidationError
            raise ValidationError(
                {"detail": "This promo code has been used. Deactivate it instead of deleting."})
        code = instance.code
        instance.delete()
        log_event(self.request, "promo_deleted", {"code": code})

    @action(detail=True, methods=["get"])
    def redemptions(self, request, pk=None):
        """Full usage history for a code — who, when, amount, booking."""
        promo = self.get_object()
        qs = promo.redemptions.select_related("customer__linked_user", "user", "booking").all()
        return Response(PromoRedemptionSerializer(qs, many=True).data)

    @action(detail=False, methods=["post"], url_path="bulk-generate")
    def bulk_generate(self, request):
        """Generate N unique codes that share the same settings + batch tag."""
        params = BulkPromoSerializer(data=request.data)
        params.is_valid(raise_exception=True)
        qty = params.validated_data["quantity"]
        prefix = (params.validated_data.get("prefix") or "").strip().upper()
        length = params.validated_data.get("code_length", 6)

        # Validate the shared promo settings via the main serializer (uses a
        # throwaway code just to pass field validation).
        settings_in = {k: v for k, v in request.data.items()
                       if k not in ("quantity", "prefix", "code_length", "code")}
        probe = PromoCodeSerializer(data={**settings_in, "code": f"_PROBE_{_suffix(6)}"})
        probe.is_valid(raise_exception=True)
        vd = probe.validated_data
        m2m = {                                       # set after bulk_create (M2M)
            "categories": list(vd.pop("categories", [])),
            "services": list(vd.pop("services", [])),
            "addons": list(vd.pop("addons", [])),
        }
        shared = {k: v for k, v in vd.items() if k != "code"}

        batch = "B" + _suffix(8)
        existing = set(PromoCode.objects.values_list("code", flat=True))
        rows = []
        for _ in range(qty):
            code = None
            for _try in range(25):
                candidate = (f"{prefix}-{_suffix(length)}" if prefix else _suffix(length))
                if candidate not in existing:
                    code = candidate
                    existing.add(candidate)
                    break
            if code is None:
                return Response({"detail": "Could not generate unique codes - try a longer length."},
                                status=status.HTTP_409_CONFLICT)
            rows.append(PromoCode(code=code, batch=batch, created_by=request.user, **shared))

        PromoCode.objects.bulk_create(rows)
        created = PromoCode.objects.filter(batch=batch)
        # Attach the scope's M2M to each generated code (only the relevant one).
        scope_field = {"category": "categories", "package": "services", "addon": "addons"}.get(
            shared.get("applies_to"))
        if scope_field and m2m[scope_field]:
            for pc in created:
                getattr(pc, scope_field).set(m2m[scope_field])
        log_event(request, "promo_bulk_generated", {"batch": batch, "count": qty}, status_code=201)
        return Response(PromoCodeSerializer(created, many=True).data, status=status.HTTP_201_CREATED)
