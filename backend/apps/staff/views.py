"""Staff endpoints: staff profiles, shifts, performance snapshots."""

from rest_framework import permissions, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from apps.accounts.models import Role
from apps.auditlogs.services import log_event

from .filters import ShiftFilter
from .models import (
    PerformanceSnapshot, Shift, ShiftOption, StaffClubTransfer, StaffProfile,
    TransferStatus, TransferType,
)
from .permissions import StaffManagePermission
from .serializers import (
    PerformanceSnapshotSerializer,
    ShiftSerializer,
    StaffClubTransferSerializer,
    StaffProfileCreateSerializer,
    StaffProfileSerializer,
)


def _jsonable(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _branch_name(profile):
    return profile.base_club.name if profile.base_club_id else None


def _scope_to_club(qs, user, field):
    """Limit staff records to a club-restricted user's home clubs.

    `field` is the path to the staff member's `base_club_id`. Driven by the user's
    `assigned_clubs`, not by role name: club-unrestricted users (super/admin ->
    `scoped_club_ids()` is None) are unaffected. Staff with no base club are
    visible only to unrestricted users.
    """
    club_ids = user.scoped_club_ids()
    if club_ids is None:
        return qs
    return qs.filter(**{f"{field}__in": club_ids})


def _shift_summary(s):
    return {
        "shift_id": s.id,
        "staff": s.staff.employee_id,
        "date": str(s.date),
        "window": f"{s.start_time}-{s.end_time}",
        "is_active": s.is_active,
    }


# Staff profile fields whose changes are worth auditing.
_STAFF_TRACK = ["employee_id", "employment_type", "skills", "hired_on", "is_available", "notes"]


class StaffProfileViewSet(viewsets.ModelViewSet):
    queryset = (
        StaffProfile.objects
        .select_related("user", "base_club")
        .prefetch_related("shifts")
        .all()
    )
    permission_classes = [permissions.IsAuthenticated, StaffManagePermission]
    filterset_fields = ["employment_type", "is_available", "user__role"]
    search_fields = ["employee_id", "user__first_name", "user__last_name",
                     "user__email", "skills"]
    ordering_fields = ["employee_id", "rating", "created_at"]

    def get_serializer_class(self):
        if self.action == "create":
            return StaffProfileCreateSerializer
        return StaffProfileSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        user = self.request.user
        # Facility staff / operators only see their own profile; managers see all.
        if user.role in (Role.FACILITY_STAFF, Role.FACILITY_OPERATOR):
            return qs.filter(user=user)
        return _scope_to_club(qs, user, "base_club_id")

    def _guard_club_base(self, base_club, *, required):
        """A club-restricted user may only base staff at its own clubs (and, on
        create, must pick one — otherwise it would create a staff member it can't
        see). Club-unrestricted users (super/admin) are unaffected."""
        club_ids = self.request.user.scoped_club_ids()
        if club_ids is None:
            return
        clubs = set(club_ids)
        if base_club is None:
            if required:
                raise PermissionDenied("Assign the staff member to one of your own clubs.")
            return
        if getattr(base_club, "id", base_club) not in clubs:
            raise PermissionDenied("You can only base staff at your own clubs.")

    def _guard_assign_staff_role(self, slug):
        """Mirror UserViewSet's role guard so the staff-create path can't be used
        to escalate: only a super admin may mint admin/super-admin accounts, and a
        Club Admin may never create admin / super-admin / club-admin staff."""
        from apps.accounts import access
        user = self.request.user
        if access.is_senior_role(slug) and user.role != Role.SUPER_ADMIN:
            raise PermissionDenied("Only a super admin can create an admin or super admin account.")
        # Club Admin is admin-tier — only super/admin may create one (a manager
        # with staff.add must not be able to mint a club admin via this path).
        if access.base_role_for(slug) == Role.CLUB_ADMIN and \
                user.role not in (Role.SUPER_ADMIN, Role.ADMIN):
            raise PermissionDenied("Only an admin can create a club admin account.")

    # ----------------------------------------------------------------- #
    # Audit logging
    # ----------------------------------------------------------------- #
    def perform_create(self, serializer):
        self._guard_assign_staff_role(serializer.validated_data.get("role"))
        self._guard_club_base(
            serializer.validated_data.get("base_club"), required=True)
        profile = serializer.save()
        log_event(self.request, "staff_created", {
            "staff": profile.employee_id, "role": profile.role,
            "base_branch": _branch_name(profile),
        }, subject=("staff", profile.id))

    def perform_update(self, serializer):
        from rest_framework import serializers as drf_serializers

        inst = serializer.instance
        # The club can only be set at creation; changing it afterwards must go
        # through the Transfer workflow (approval + impact + Club History), so a
        # direct edit can't bypass the process. (Backend is the source of truth —
        # the Edit form also shows the club read-only.)
        if "base_club" in serializer.validated_data:
            new_club = serializer.validated_data.get("base_club")
            if getattr(new_club, "id", new_club) != inst.base_club_id:
                raise drf_serializers.ValidationError({
                    "base_club": "To move this employee to another club, use "
                                 "Transfer Employee - the club can't be changed by a direct edit.",
                })
        old = {f: getattr(inst, f) for f in _STAFF_TRACK}
        old_branch = _branch_name(inst)
        profile = serializer.save()

        changes = {}
        for f in _STAFF_TRACK:
            new = getattr(profile, f)
            if old[f] != new:
                changes[f] = {"from": _jsonable(old[f]), "to": _jsonable(new)}
        new_branch = _branch_name(profile)
        if old_branch != new_branch:
            changes["base_branch"] = {"from": old_branch, "to": new_branch}

        if changes:
            log_event(self.request, "staff_updated",
                      {"staff": profile.employee_id, "changes": changes},
                      subject=("staff", profile.id))

    def perform_destroy(self, instance):
        emp = instance.employee_id
        sid = instance.id
        super().perform_destroy(instance)
        log_event(self.request, "staff_deleted", {"staff": emp}, subject=("staff", sid))

    @action(detail=False, methods=["get"], url_path="me")
    def me(self, request):
        try:
            profile = StaffProfile.objects.select_related("user").get(user=request.user)
        except StaffProfile.DoesNotExist:
            return Response({"detail": "No staff profile."}, status=404)
        return Response(StaffProfileSerializer(profile).data)

    @action(detail=True, methods=["get"], url_path="performance-history")
    def performance_history(self, request, pk=None):
        staff = self.get_object()
        snapshots = staff.performance.all()
        return Response(PerformanceSnapshotSerializer(snapshots, many=True).data)

    @action(detail=True, methods=["get"], url_path="activity")
    def activity(self, request, pk=None):
        """Per-employee Activity Log — audit entries whose subject is this staff
        member (gated `staff.activity`, club-scoped via get_object())."""
        from apps.accounts import access
        from apps.auditlogs.models import AuditLog
        from apps.auditlogs.serializers import AuditLogSerializer

        staff = self.get_object()
        if not request.user.has_perm_code("staff.activity"):
            return Response({"detail": access.denial_message("staff", "activity")}, status=403)
        qs = (AuditLog.objects
              .filter(subject_type="staff", subject_id=str(staff.id))
              .select_related("actor")
              .order_by("-created_at"))
        page = self.paginate_queryset(qs)
        data = AuditLogSerializer(page if page is not None else qs, many=True).data
        return self.get_paginated_response(data) if page is not None else Response(data)

    @action(detail=True, methods=["get"], url_path="transfer-impact")
    def transfer_impact(self, request, pk=None):
        """Records a club transfer would touch (future bookings, active job
        cards, upcoming shifts) — drives the transfer modal's impact summary."""
        from apps.accounts import access
        from .services import transfer_impact as _impact

        staff = self.get_object()
        if not request.user.has_perm_code("staff.transfer"):
            return Response({"detail": access.denial_message("staff", "transfer")}, status=403)
        return Response(_impact(staff))

    def retrieve(self, request, *args, **kwargs):
        # Lazily complete any approved scheduled transfer that's now due, so the
        # page always reflects reality (cron/command also covers headless runs).
        from .services import activate_due_transfers
        activate_due_transfers()
        return super().retrieve(request, *args, **kwargs)

    @action(detail=True, methods=["put"], url_path="schedule")
    def set_schedule(self, request, pk=None):
        """Set (or clear) the employee's custom weekly shift schedule. An empty
        `shift_hours` disables the custom schedule → the staff member falls back
        to their Club schedule, then the Organization default. Gated by
        `staff.edit` (StaffManagePermission) and club-scoped via get_object()."""
        from apps.accounts import access
        from .services import resolve_staff_schedule, validate_shift_hours

        staff = self.get_object()
        if not request.user.has_perm_code("staff.edit"):
            return Response({"detail": access.denial_message("staff", "edit")}, status=403)

        raw = request.data.get("shift_hours") or {}
        staff.shift_hours = validate_shift_hours(raw) if raw else {}
        staff.save(update_fields=["shift_hours", "updated_at"])

        source = resolve_staff_schedule(staff)[1]
        log_event(request, "staff_shift_schedule_updated",
                  {"staff": staff.employee_id, "source": source},
                  subject=("staff", staff.id))
        return Response(StaffProfileSerializer(staff, context={"request": request}).data)


class ShiftViewSet(viewsets.ModelViewSet):
    queryset = Shift.objects.select_related("staff", "staff__user").all()
    serializer_class = ShiftSerializer
    permission_classes = [permissions.IsAuthenticated, StaffManagePermission]
    filterset_class = ShiftFilter
    ordering_fields = ["date", "start_time"]

    def get_queryset(self):
        qs = super().get_queryset()
        user = self.request.user
        if user.role in (Role.FACILITY_STAFF, Role.FACILITY_OPERATOR):
            return qs.filter(staff__user=user)
        return _scope_to_club(qs, user, "staff__base_club_id")

    # ----------------------------------------------------------------- #
    # Audit logging
    # ----------------------------------------------------------------- #
    def perform_create(self, serializer):
        shift = serializer.save()
        log_event(self.request, "shift_created", _shift_summary(shift),
                  subject=("staff", shift.staff_id))

    def perform_update(self, serializer):
        before = _shift_summary(serializer.instance)
        shift = serializer.save()
        after = _shift_summary(shift)
        diff = {k: {"from": before[k], "to": after[k]}
                for k in ("date", "window", "is_active") if before[k] != after[k]}
        summary = dict(after)
        if diff:
            summary["changes"] = diff
        log_event(self.request, "shift_updated", summary, subject=("staff", shift.staff_id))

    def perform_destroy(self, instance):
        summary = _shift_summary(instance)
        sid = instance.staff_id
        super().perform_destroy(instance)
        log_event(self.request, "shift_deleted", summary, subject=("staff", sid))


class StaffClubTransferViewSet(viewsets.ModelViewSet):
    """Club transfers (maker-checker). Each lifecycle step is gated by its own
    capability and audited; the history is immutable (no edit/delete)."""

    queryset = StaffClubTransfer.objects.select_related(
        "staff", "staff__user", "from_club", "to_club",
        "created_by", "approved_by", "cancelled_by").all()
    serializer_class = StaffClubTransferSerializer
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ["get", "post"]   # lifecycle is via approve/cancel actions
    filterset_fields = ["staff", "status"]
    ordering_fields = ["created_at", "effective_date"]

    def _require(self, cap):
        from apps.accounts import access
        u = self.request.user
        if u.role == Role.CUSTOMER or not u.has_perm_code(f"staff.{cap}"):
            raise PermissionDenied(access.denial_message("staff", cap))

    def _guard_staff_in_scope(self, staff):
        club_ids = self.request.user.scoped_club_ids()
        if club_ids is not None and staff.base_club_id not in set(club_ids):
            raise PermissionDenied("You can only manage staff at your own clubs.")

    def get_queryset(self):
        return _scope_to_club(super().get_queryset(), self.request.user, "staff__base_club_id")

    def list(self, request, *args, **kwargs):
        self._require("club_history")
        return super().list(request, *args, **kwargs)

    def retrieve(self, request, *args, **kwargs):
        self._require("club_history")
        return super().retrieve(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        from datetime import date as _date
        from apps.accounts import access
        from .services import transfer_impact, validate_transfer

        self._require("transfer")
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        staff = data["staff"]
        self._guard_staff_in_scope(staff)
        # A club-scoped actor may only transfer staff between clubs it owns —
        # moving someone INTO a foreign club touches that club's roster.
        club_ids = request.user.scoped_club_ids()
        if club_ids is not None and data["to_club"].id not in set(club_ids):
            raise PermissionDenied("You can only transfer staff to your own clubs.")

        ttype = data.get("transfer_type") or TransferType.IMMEDIATE
        effective = _date.today() if ttype == TransferType.IMMEDIATE else data.get("effective_date")
        validate_transfer(staff, data["to_club"], effective)

        plan = data.get("reassign_plan") or {}
        if plan and not request.user.has_perm_code("staff.reassign"):
            raise PermissionDenied(access.denial_message("staff", "reassign"))
        # The reassignment plan is an assignment decision: each chosen worker must
        # be available for the booking they'd take over. Block unless
        # the maker holds the matching assign-override capability.
        from .services import reassign_plan_conflicts
        conflicts = reassign_plan_conflicts(plan)
        if conflicts:
            kinds = {kind for kind, _, _ in conflicts}
            can_override = all(
                request.user.has_perm_code(f"{k}.assign_override") for k in kinds)
            if not (bool(request.data.get("override")) and can_override):
                return Response(
                    {"detail": " ".join(r for _, _, r in conflicts),
                     "code": "availability", "overridable": can_override},
                    status=409)

        transfer = StaffClubTransfer.objects.create(
            staff=staff, from_club=staff.base_club, to_club=data["to_club"],
            effective_date=effective, transfer_type=ttype,
            reason=data.get("reason", ""), remarks=data.get("remarks", ""),
            shift_option=data.get("shift_option", ShiftOption.APPLY_CLUB),
            reassign_plan=plan, impact_snapshot=transfer_impact(staff)["counts"],
            status=TransferStatus.PENDING, created_by=request.user)
        log_event(request, "staff_branch_transfer_requested", {
            "staff": staff.employee_id, "from": _branch_name(staff),
            "to": data["to_club"].name, "type": ttype, "effective": str(effective),
        }, subject=("staff", staff.id), status_code=201)
        return Response(self.get_serializer(transfer).data, status=201)

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        from datetime import date as _date
        from django.utils import timezone
        from .services import complete_transfer

        self._require("transfer_approve")
        transfer = self.get_object()
        if transfer.status != TransferStatus.PENDING:
            return Response({"detail": "Only a pending transfer can be approved."}, status=400)
        transfer.approved_by = request.user
        transfer.approved_at = timezone.now()
        transfer.status = TransferStatus.APPROVED
        transfer.save(update_fields=["approved_by", "approved_at", "status"])
        log_event(request, "staff_branch_transfer_approved",
                  {"staff": transfer.staff.employee_id},
                  subject=("staff", transfer.staff_id))
        # Immediate (or already-due) transfers complete on approval.
        if transfer.effective_date <= _date.today():
            complete_transfer(transfer, request=request, actor=request.user)
        return Response(self.get_serializer(transfer).data)

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        self._require("transfer_cancel")
        transfer = self.get_object()
        if transfer.status not in (TransferStatus.PENDING, TransferStatus.APPROVED):
            return Response(
                {"detail": "Only a pending or scheduled transfer can be cancelled."}, status=400)
        transfer.status = TransferStatus.CANCELLED
        transfer.cancelled_by = request.user
        transfer.cancel_reason = (request.data.get("reason") or "")[:255]
        transfer.save(update_fields=["status", "cancelled_by", "cancel_reason"])
        log_event(request, "staff_branch_transfer_cancelled",
                  {"staff": transfer.staff.employee_id, "reason": transfer.cancel_reason},
                  subject=("staff", transfer.staff_id))
        return Response(self.get_serializer(transfer).data)


class PerformanceSnapshotViewSet(viewsets.ModelViewSet):
    queryset = PerformanceSnapshot.objects.select_related("staff", "staff__user").all()
    serializer_class = PerformanceSnapshotSerializer
    permission_classes = [permissions.IsAuthenticated, StaffManagePermission]
    filterset_fields = ["staff", "date"]
    ordering_fields = ["date", "jobs_completed", "avg_rating"]

    def get_queryset(self):
        qs = super().get_queryset()
        user = self.request.user
        if user.role in (Role.FACILITY_STAFF, Role.FACILITY_OPERATOR):
            return qs.filter(staff__user=user)
        return _scope_to_club(qs, user, "staff__base_club_id")
