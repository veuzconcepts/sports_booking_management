"""System settings endpoints: organization, booking rules, currency, tax, config."""

from django.shortcuts import get_object_or_404
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auditlogs.services import log_event
from config.listing import GroupedListMixin

from . import currency as currency_cfg
from . import schedule as sched
from . import theme as theme_cfg
from .models import (
    BookingConfiguration,
    Language,
    Organization,
    ScheduleException,
    SystemConfig,
    TaxRate,
    ThemePreset,
)
from .permissions import (
    BookingConfigPermission,
    OrganizationPermission,
    SchedulePermission,
    SettingsPermission,
    ThemePermission,
)
from .serializers import (
    BookingConfigurationSerializer,
    LanguageSerializer,
    OrganizationSerializer,
    ScheduleExceptionSerializer,
    SystemConfigSerializer,
    TaxRateSerializer,
    ThemePresetSerializer,
)


class _Conflict(APIException):
    """409 for a mutation the current state does not allow."""

    status_code = status.HTTP_409_CONFLICT
    default_detail = "This action conflicts with the current configuration."


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

        instance = serializer.instance
        # On a PATCH the scope fields may be absent. Falling back to the stored
        # row keeps a club manager's own edit at club scope instead of having it
        # read as an organization-wide change they are not allowed to make.
        club = serializer.validated_data.get("club", getattr(instance, "club", None))
        facility = serializer.validated_data.get(
            "facility", getattr(instance, "facility", None))
        checker = SchedulePermission()
        if not checker._may_write(self.request.user,
                                  getattr(club, "id", None), facility):
            raise PermissionDenied(checker.message)

    @extend_schema(request=ScheduleExceptionSerializer, responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["post"], url_path="impact")
    def impact(self, request):
        """What would this special date cost, asked BEFORE it is saved.

        Nothing is written. The proposed row is validated exactly as a real save
        would validate it, then measured against the bookings customers are
        already holding, so a closure is never applied without the administrator
        being shown what it strands (see the confirmation rule for high-impact
        configuration changes).
        """
        instance = None
        row_id = request.data.get("id")
        if row_id:
            instance = get_object_or_404(self.get_queryset(), pk=row_id)

        serializer = self.get_serializer(
            instance, data=request.data, partial=instance is not None)
        serializer.is_valid(raise_exception=True)
        self._check_scope(serializer)
        return Response(self._impact_payload(
            serializer.validated_data.get(
                "start_date", getattr(instance, "start_date", None)),
            serializer.validated_data.get(
                "end_date", getattr(instance, "end_date", None)),
            club=serializer.validated_data.get(
                "club", getattr(instance, "club", None)),
            facility=serializer.validated_data.get(
                "facility", getattr(instance, "facility", None)),
            day_config={
                "closed": serializer.validated_data.get("closed", True),
                "shifts": serializer.validated_data.get("shifts") or [],
                "breaks": serializer.validated_data.get("breaks") or [],
            },
        ))

    @extend_schema(request=None, responses=OpenApiTypes.OBJECT)
    @action(detail=True, methods=["get"], url_path="removal-impact")
    def removal_impact(self, request, pk=None):
        """What would break if this special date were removed.

        Deleting a closure simply restores the normal hours, but deleting a row
        that WIDENED the hours puts every booking made inside that extra time
        back outside the weekly pattern. The answer is resolved as though this
        row were already gone.
        """
        obj = self.get_object()
        return Response(self._impact_payload(
            obj.start_date, obj.last_date, club=obj.club, facility=obj.facility,
            day_config=None, exclude_id=obj.id))

    def _impact_payload(self, start, end, *, club, facility,
                        day_config, exclude_id=None):
        if start is None:
            return {"from": None, "to": None, "count": 0, "bookings": []}
        end = end or start
        affected = sched.exception_impact(
            start, end, club=club, facility=facility,
            day_config=day_config, exclude_id=exclude_id)
        return {
            "from": start.isoformat(),
            "to": end.isoformat(),
            "count": len(affected),
            "bookings": affected,
        }

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


class LanguageViewSet(GroupedListMixin, viewsets.ModelViewSet):
    """Languages the application is offered in.

    Administrators decide which languages exist, which is the default and how
    each is labelled. They do NOT edit translation keys here: enabling a
    language and translating it are separate concerns, and the keys are part of
    the build rather than user data.
    """

    queryset = Language.objects.all()
    serializer_class = LanguageSerializer
    permission_classes = [permissions.IsAuthenticated, SettingsPermission]
    filterset_fields = ["is_enabled", "direction"]
    search_fields = ["code", "name", "native_name"]
    ordering_fields = ["display_order", "name", "code", "is_enabled"]
    ordering = ("display_order", "name")
    group_by_fields = {
        "direction": {"field": "direction"},
        "is_enabled": {"field": "is_enabled", "true_label": "Enabled",
                       "empty_label": "Disabled"},
    }

    @staticmethod
    def _release_default(keep_pk=None):
        """Clear the default flag everywhere else.

        Called BEFORE the row that is claiming it is saved: the partial unique
        constraint allows only one default at a time, so promoting first and
        demoting afterwards fails mid-transaction.
        """
        qs = Language.objects.filter(is_default=True)
        if keep_pk is not None:
            qs = qs.exclude(pk=keep_pk)
        qs.update(is_default=False)

    def perform_create(self, serializer):
        if serializer.validated_data.get("is_default"):
            self._release_default()
        language = serializer.save()
        log_event(self.request, "language_added", {
            "code": language.code, "name": language.name,
            "enabled": language.is_enabled, "default": language.is_default,
        }, subject=("language", language.id))

    def perform_update(self, serializer):
        if serializer.validated_data.get("is_default"):
            self._release_default(keep_pk=serializer.instance.pk)
        language = serializer.save()
        log_event(self.request, "language_changed", {
            "code": language.code, "enabled": language.is_enabled,
            "default": language.is_default,
        }, subject=("language", language.id))

    def perform_destroy(self, instance):
        # Deleting the default would leave the application with nothing to fall
        # back to. Disabling is the reversible action and is what we steer to.
        if instance.is_default:
            raise _Conflict(
                "The default language cannot be deleted. Make another language "
                "the default first.")
        log_event(self.request, "language_removed", {"code": instance.code},
                  subject=("language", instance.id))
        instance.delete()

    @action(detail=True, methods=["post"], url_path="make-default")
    def make_default(self, request, pk=None):
        """Promote this language to the default, enabling it if needed."""
        language = self.get_object()
        self._release_default(keep_pk=language.pk)
        language.is_default = True
        # A default nobody can select is not a default, so promoting enables.
        language.is_enabled = True
        language.save(update_fields=["is_default", "is_enabled", "updated_at"])
        log_event(request, "language_default_changed", {"code": language.code},
                  subject=("language", language.id))
        return Response(self.get_serializer(language).data)


class PublicLanguagesView(APIView):
    """The languages a visitor may choose, before they have signed in.

    Deliberately unauthenticated and read-only: the login page, the forgotten
    password page and the public booking site all need to render in the right
    language before there is a user to have a preference. It exposes only what
    a language selector needs, never the full admin record.
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        languages = Language.objects.filter(is_enabled=True).order_by(
            "display_order", "name")
        return Response({
            "default": Language.default_code(),
            "languages": [{
                "code": l.code,
                "locale": l.effective_locale,
                "name": l.name,
                "native_name": l.native_name,
                "direction": l.direction,
                "is_default": l.is_default,
            } for l in languages],
        })


class ThemeView(APIView):
    """The active organization theme, plus everything the settings screen needs
    to render its controls: the token catalogue and the contrast report.

    Reading is gated by `organization.view`; saving by `organization.manage`.
    The catalogue is served from the backend so the two never drift.
    """

    permission_classes = [permissions.IsAuthenticated, ThemePermission]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        org = Organization.get_solo()
        return Response({
            "theme": org.theme or {},
            "resolved": theme_cfg.resolve(org.theme),
            "defaults": theme_cfg.resolve({}),
            "catalogue": theme_cfg.catalogue(),
            "groups": theme_cfg.GROUP_LABELS,
            "corner_styles": sorted(theme_cfg.CORNER_STYLES),
            "preset_name": org.theme_preset_name,
            "contrast": theme_cfg.contrast_report(org.theme),
        })

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def put(self, request):
        org = Organization.get_solo()
        try:
            cleaned = theme_cfg.clean(request.data.get("theme"))
        except theme_cfg.ThemeError as exc:
            raise ValidationError({"theme": [str(exc)]}) from exc

        preset_name = (request.data.get("preset_name") or "").strip()[:60]
        org.theme = cleaned
        org.theme_preset_name = preset_name
        org.save(update_fields=["theme", "theme_preset_name", "updated_at"])
        log_event(request, "theme_updated",
                  {"preset": preset_name, "tokens": sorted(cleaned)})
        return Response({
            "theme": org.theme,
            "resolved": theme_cfg.resolve(org.theme),
            "preset_name": org.theme_preset_name,
            "contrast": theme_cfg.contrast_report(org.theme),
        })

    def patch(self, request):
        return self.put(request)

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def delete(self, request):
        """Reset to the system default: drop every override."""
        org = Organization.get_solo()
        org.theme = {}
        org.theme_preset_name = ""
        org.save(update_fields=["theme", "theme_preset_name", "updated_at"])
        log_event(request, "theme_reset", {})
        return Response({
            "theme": {},
            "resolved": theme_cfg.resolve({}),
            "preset_name": "",
            "contrast": theme_cfg.contrast_report({}),
        })


class ThemeContrastView(APIView):
    """Score a theme that has not been saved yet, so the settings screen can warn
    while the administrator is still choosing.

    The arithmetic lives on the backend because the thresholds are a policy, not
    a rendering detail, and the same answer has to hold for any future client.
    """

    permission_classes = [permissions.IsAuthenticated, ThemePermission]

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def post(self, request):
        try:
            cleaned = theme_cfg.clean(request.data.get("theme"))
        except theme_cfg.ThemeError as exc:
            raise ValidationError({"theme": [str(exc)]}) from exc
        return Response({"contrast": theme_cfg.contrast_report(cleaned)})


class PublicThemeView(APIView):
    """The resolved theme and the branding a signed-out visitor may see.

    The login screen and the customer website need this before a session
    exists. It exposes only what is already public on a rendered page: the
    palette, the logo, the favicon and the display name. Never the stored
    override map, the preset library, or anything else from the profile.
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        org = Organization.get_solo()

        def url(image):
            if not image:
                return None
            return request.build_absolute_uri(image.url) if request else image.url

        return Response({
            "name": org.name or "",
            "theme": theme_cfg.resolve(org.theme),
            "logo_light": url(org.logo_light),
            "logo_dark": url(org.logo_dark),
            "favicon": url(org.favicon),
        })


class ThemePresetViewSet(viewsets.ModelViewSet):
    """The saved theme library. Applying a preset copies its tokens onto the
    organization, so the preset itself is never what renders."""

    serializer_class = ThemePresetSerializer
    permission_classes = [permissions.IsAuthenticated, ThemePermission]
    filter_backends = []
    pagination_class = None

    def get_queryset(self):
        qs = ThemePreset.objects.all()
        if self.request.query_params.get("include_archived") != "true":
            qs = qs.filter(is_archived=False)
        return qs

    def perform_create(self, serializer):
        preset = serializer.save()
        log_event(self.request, "theme_preset_created", {"name": preset.name})

    def perform_update(self, serializer):
        preset = serializer.save()
        log_event(self.request, "theme_preset_updated", {"name": preset.name})

    def perform_destroy(self, instance):
        if instance.is_builtin:
            raise _Conflict("A built-in theme cannot be deleted.")
        # Archive rather than delete: a preset may be referenced by name in the
        # audit trail, and history should stay readable.
        instance.is_archived = True
        instance.save(update_fields=["is_archived", "updated_at"])
        log_event(self.request, "theme_preset_archived", {"name": instance.name})

    @action(detail=True, methods=["post"], url_path="apply")
    def apply_preset(self, request, pk=None):
        """Make this preset the active theme."""
        preset = self.get_object()
        org = Organization.get_solo()
        org.theme = theme_cfg.clean(preset.tokens)
        org.theme_preset_name = preset.name
        org.save(update_fields=["theme", "theme_preset_name", "updated_at"])
        log_event(request, "theme_preset_applied", {"name": preset.name})
        return Response({
            "theme": org.theme,
            "resolved": theme_cfg.resolve(org.theme),
            "preset_name": org.theme_preset_name,
            "contrast": theme_cfg.contrast_report(org.theme),
        })

    @action(detail=True, methods=["post"], url_path="duplicate")
    def duplicate(self, request, pk=None):
        """Copy a preset so a built-in one can be used as a starting point."""
        preset = self.get_object()
        base = f"{preset.name} copy"
        name, n = base, 2
        while ThemePreset.objects.filter(name=name).exists():
            name, n = f"{base} {n}", n + 1
        clone = ThemePreset.objects.create(
            name=name, tokens=preset.tokens,
            display_order=preset.display_order + 1)
        log_event(request, "theme_preset_created", {"name": clone.name})
        return Response(ThemePresetSerializer(clone).data,
                        status=status.HTTP_201_CREATED)
