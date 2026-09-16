"""System settings endpoints: organization, booking rules, currency, tax, config."""

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import permissions, status, viewsets
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auditlogs.services import log_event

from . import currency as currency_cfg
from . import schedule as sched
from .models import (
    BookingConfiguration,
    Organization,
    ScheduleException,
    SystemConfig,
    TaxRate,
)
from .permissions import (
    BookingConfigPermission,
    OrganizationPermission,
    SchedulePermission,
    SettingsPermission,
)
from .serializers import (
    BookingConfigurationSerializer,
    OrganizationSerializer,
    ScheduleExceptionSerializer,
    SystemConfigSerializer,
    TaxRateSerializer,
)


class OrganizationView(APIView):
    """Read or update the single organization profile. Gated by the
    `organization.view` / `organization.manage` permissions. Accepts multipart so
    branding images (logos / favicon / OG) can be uploaded with the profile."""

    permission_classes = [permissions.IsAuthenticated, OrganizationPermission]
    parser_classes = [JSONParser, MultiPartParser, FormParser]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        return Response(OrganizationSerializer(
            Organization.get_solo(), context={"request": request}).data)

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def put(self, request):
        org = Organization.get_solo()
        ser = OrganizationSerializer(org, data=request.data, partial=True,
                                     context={"request": request})
        ser.is_valid(raise_exception=True)
        ser.save()
        log_event(request, "organization_updated", {"name": ser.data.get("name", "")})
        return Response(ser.data)

    def patch(self, request):
        return self.put(request)


class BookingConfigView(APIView):
    """Read or update the per-channel booking contact rules (Email/Phone required
    & unique for Website / Admin / Walk-in). Any signed-in user may read (the
    booking/customer forms need the rules); changing requires `settings.manage`."""

    permission_classes = [permissions.IsAuthenticated, BookingConfigPermission]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        return Response(BookingConfigurationSerializer(BookingConfiguration.get_solo()).data)

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def put(self, request):
        cfg = BookingConfiguration.get_solo()
        ser = BookingConfigurationSerializer(cfg, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        log_event(request, "booking_config_updated", {})
        return Response(ser.data)

    def patch(self, request):
        return self.put(request)


class CurrencyView(APIView):
    """Read or set the system default currency (applied to new records).

    Any authenticated user may READ the active currency (the whole UI formats
    money with it); only settings managers may CHANGE it.
    """

    permission_classes = [permissions.IsAuthenticated, SettingsPermission]

    def get_permissions(self):
        if self.request.method in permissions.SAFE_METHODS:
            return [permissions.IsAuthenticated()]
        return [permissions.IsAuthenticated(), SettingsPermission()]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        # Sourced from the Currency master (active currencies only).
        return Response({
            "currency": currency_cfg.get_default_currency(),
            "choices": currency_cfg.active_currencies(),
        })

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def put(self, request):
        code = (request.data.get("currency") or "").upper()
        codes = currency_cfg.valid_currency_codes()
        if code not in codes:
            return Response(
                {"detail": f"Unsupported currency. Choose one of: {', '.join(codes)}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        currency_cfg.set_default_currency(code)
        log_event(request, "currency_changed", {"currency": code})
        return Response({"currency": code})


class TaxRateViewSet(viewsets.ModelViewSet):
    queryset = TaxRate.objects.all()
    serializer_class = TaxRateSerializer
    permission_classes = [permissions.IsAuthenticated, SettingsPermission]
    filterset_fields = ["is_default", "country"]
    ordering_fields = ["name", "rate"]


class SystemConfigViewSet(viewsets.ModelViewSet):
    queryset = SystemConfig.objects.all()
    serializer_class = SystemConfigSerializer
    permission_classes = [permissions.IsAuthenticated, SettingsPermission]
    search_fields = ["key", "description"]
    lookup_field = "key"


def _scope_from_query(request):
    """(club, facility) named by `?club=` / `?facility=`, either may be None.

    A facility implies its club, so callers never have to send both and the two
    can never be sent disagreeing with each other.
    """
    from apps.clubs.models import Club
    from apps.facilities.models import Facility

    facility = None
    fid = request.query_params.get("facility")
    if fid:
        facility = Facility.objects.filter(pk=fid).select_related("club").first()

    club = facility.club if facility is not None else None
    cid = request.query_params.get("club")
    if club is None and cid:
        club = Club.objects.filter(pk=cid).first()
    return club, facility


class EffectiveScheduleView(APIView):
    """`?club=&facility=` -> the resolved week, each day tagged with its source.

    One read-only place for "what hours actually apply here", so the Club and
    Facility screens, the website and the booking form cannot drift apart. The
    booking engine resolves through the same functions.
    """

    permission_classes = [permissions.IsAuthenticated, SchedulePermission]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        club, facility = _scope_from_query(request)
        slot_minutes, slot_source = sched.resolve_slot_minutes(club, facility)
        before, after = sched.resolve_buffers(club, facility)

        if facility is not None:
            scope, parent = sched.SCOPE_FACILITY, sched.SCOPE_CLUB
        elif club is not None:
            scope, parent = sched.SCOPE_CLUB, sched.SCOPE_ORGANIZATION
        else:
            scope, parent = sched.SCOPE_ORGANIZATION, None

        return Response({
            "scope": scope,
            "parent": parent,
            "parent_label": sched.scope_label(parent, club, facility) if parent else None,
            "club": club.id if club else None,
            "facility": facility.id if facility else None,
            "slot_minutes": slot_minutes,
            "slot_minutes_source": slot_source,
            "buffer_before_minutes": before,
            "buffer_after_minutes": after,
            "timezone": Organization.get_solo().timezone,
            "week": sched.effective_week(club=club, facility=facility),
        })


class ScheduleImpactView(APIView):
    """`?club=&facility=&from=&to=` -> live bookings the current schedule would
    no longer allow.

    Called before and after a schedule change so an admin is told
    "this affects 3 existing bookings" and can see which. It never modifies a
    booking: moving or cancelling one stays a separate, permissioned action.
    """

    permission_classes = [permissions.IsAuthenticated, SchedulePermission]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        from datetime import date as date_cls, timedelta

        club, facility = _scope_from_query(request)

        def parse(name, fallback):
            raw = request.query_params.get(name)
            try:
                return date_cls.fromisoformat(raw) if raw else fallback
            except ValueError:
                return fallback

        start = parse("from", date_cls.today())
        end = parse("to", start + timedelta(days=60))
        dates = sched.dates_in(start, end)
        affected = sched.bookings_outside_schedule(dates, club=club, facility=facility)
        return Response({
            "from": start.isoformat(),
            "to": dates[-1].isoformat() if dates else start.isoformat(),
            "count": len(affected),
            "bookings": affected,
        })


class ScheduleExceptionViewSet(viewsets.ModelViewSet):
    """Special dates that replace the weekly pattern: holidays, Ramadan hours,
    tournaments, temporary closures."""

    queryset = ScheduleException.objects.select_related("club", "facility").all()
    serializer_class = ScheduleExceptionSerializer
    permission_classes = [permissions.IsAuthenticated, SchedulePermission]
    filterset_fields = ["club", "facility", "is_active", "closed"]
    search_fields = ["name", "notes"]
    ordering_fields = ["start_date", "name", "created_at"]
    ordering = ("start_date",)

    def get_queryset(self):
        """Club-restricted users see their own clubs' rows plus the
        organization-wide ones they are subject to, never another venue's."""
        from django.db.models import Q

        qs = super().get_queryset()
        club_ids = self.request.user.scoped_club_ids()
        if club_ids is not None:
            qs = qs.filter(
                Q(club_id__in=club_ids)
                | Q(facility__club_id__in=club_ids)
                | Q(club__isnull=True, facility__isnull=True))
        return qs

    def _check_scope(self, serializer):
        """Enforce the write scope before saving, so a club manager cannot
        create an organization-wide closure."""
        from rest_framework.exceptions import PermissionDenied

        club = serializer.validated_data.get("club")
        facility = serializer.validated_data.get("facility")
        checker = SchedulePermission()
        if not checker._may_write(self.request.user,
                                  getattr(club, "id", None), facility):
            raise PermissionDenied(checker.message)

    def perform_create(self, serializer):
        self._check_scope(serializer)
        obj = serializer.save(created_by=self.request.user)
        log_event(self.request, "schedule_exception_created", {
            "name": obj.name, "scope": obj.scope,
            "from": obj.start_date.isoformat(), "to": obj.last_date.isoformat(),
            "closed": obj.closed,
        }, subject=("schedule_exception", obj.id))

    def perform_update(self, serializer):
        self._check_scope(serializer)
        obj = serializer.save()
        log_event(self.request, "schedule_exception_changed", {
            "name": obj.name, "scope": obj.scope,
            "from": obj.start_date.isoformat(), "to": obj.last_date.isoformat(),
            "closed": obj.closed,
        }, subject=("schedule_exception", obj.id))

    def perform_destroy(self, instance):
        log_event(self.request, "schedule_exception_removed", {
            "name": instance.name, "scope": instance.scope,
        }, subject=("schedule_exception", instance.id))
        instance.delete()
