"""Booking endpoints: CRUD, slot availability, lifecycle actions, recurrence."""

from datetime import date as date_cls
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import ProtectedError, Q
from django.utils import timezone
from rest_framework import mixins, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError
from rest_framework.response import Response

from apps.accounts import access
from apps.accounts.models import STAFF_ROLES, Role
from apps.auditlogs.services import log_event
from django.db.models import Exists, OuterRef

from apps.payments.models import Invoice, Payment
from config.listing import GroupedListMixin

from . import services as booking_services
from .filters import BookingFilter
from .models import (
    ACTIVE_STATUSES, BOOKING_DELETION_REASONS, COMPLETED_STATUSES, PAID_PAYMENT_STATUSES,
    Booking, BookingHold, BookingOrder, BookingPolicy, BookingStatus, HoldStatus,
)
from .permissions import BookingHoldPermission, BookingObjectPermission
from .serializers import (
    AssignSerializer,
    BookingHoldSerializer,
    BookingCreateSerializer,
    BookingOrderSerializer,
    BookingPolicySerializer,
    BookingSerializer,
    CompleteBookingSerializer,
    RecurrenceSerializer,
    StatusActionSerializer,
)

User = get_user_model()


class _Conflict(APIException):
    """409 for a blocked mutation (e.g. deleting a closed/paid booking)."""
    status_code = status.HTTP_409_CONFLICT
    default_detail = "This action conflicts with the booking's current state."


class AvailabilityConflict(Exception):
    """Raised when an assigned worker/facility isn't available. Carries the exact body
    shape the assign action returns (`detail`, `code`, `overridable`) so the
    booking form and the assign dialog present one consistent UX. A plain
    Exception (not APIException) so DRF doesn't stringify the boolean; create()/
    update() translate it into a clean 409 Response below."""

    def __init__(self, reasons, *, overridable):
        self.body = {"detail": " ".join(reasons), "code": "availability",
                     "overridable": overridable}
        super().__init__(self.body["detail"])


def assignment_conflicts(*, worker, facility, club, on_date, at_time, duration,
                         exclude_booking_id, facility_type=None):
    """Shift + facility availability reasons for a worker/facility at a time. Empty list =
    all clear. Single source of truth for both create/update and the assign action."""
    from apps.staff.services import check_facility_availability, check_worker_availability

    reasons = []
    if worker and on_date and at_time:
        ok, why = check_worker_availability(
            worker, on_date=on_date, at_time=at_time, duration=duration,
            exclude_booking_id=exclude_booking_id)
        if not ok:
            reasons.append(why)
    if facility and on_date and at_time:
        ok, why = check_facility_availability(
            facility, club=club, on_date=on_date, at_time=at_time, duration=duration,
            facility_type=facility_type, exclude_booking_id=exclude_booking_id)
        if not ok:
            reasons.append(why)
    return reasons


class BookingViewSet(GroupedListMixin, viewsets.ModelViewSet):
    queryset = (
        Booking.objects
        .select_related(
            "customer", "customer__linked_user", "facility_category",
            "facility_type", "club", "facility", "assigned_to",
            # So a list row can name its order without a query each.
            "order",
        )
        .prefetch_related("add_ons", "status_history")
        # `can_delete` asks whether any money is attached. Answering that per row
        # cost two EXISTS queries per booking, which a 100-row listing page turns
        # into 200; as subqueries it is part of the one list query.
        .annotate(
            _has_payments=Exists(
                Payment.objects.filter(booking=OuterRef("pk")).values("pk")),
            _has_invoices=Exists(
                Invoice.objects.filter(booking=OuterRef("pk")).values("pk")),
        )
        .all()
    )
    permission_classes = [permissions.IsAuthenticated, BookingObjectPermission]
    filterset_class = BookingFilter
    # What the listing search box actually looks through. Deliberately the
    # fields an operator would search a booking by, not every text column.
    search_fields = ["reference", "customer__full_name", "customer__email",
                     "customer__mobile_number", "walk_in_name", "walk_in_phone",
                     "facility_type__name", "club__name", "facility__name"]
    ordering_fields = [
        "reference", "customer__full_name", "facility_type__name", "club__name",
        "status", "assigned_to__first_name", "payment_status",
        "scheduled_date", "scheduled_time", "created_at", "total_amount",
    ]
    ordering = ("-created_at",)   # Newest created first by default.

    # Grouping the bookings list. `filter_param` is the query parameter the
    # table sends back to fetch one group's rows, so every key here must also be
    # filterable in BookingFilter.
    group_by_fields = {
        "club": {"field": "club_id", "label": "club__name",
                 "filter_param": "club", "empty_label": "No club"},
        "facility": {"field": "facility_id", "label": "facility__name",
                     "filter_param": "facility", "empty_label": "Unassigned"},
        "facility_type": {"field": "facility_type_id", "label": "facility_type__name",
                          "filter_param": "facility_type"},
        "status": {"field": "status", "choices": BookingStatus.choices},
        "payment_status": {"field": "payment_status"},
        "source": {"field": "source"},
        "scheduled_date": {"field": "scheduled_date", "filter_param": "scheduled_date"},
        "customer": {"field": "customer_id", "label": "customer__full_name",
                     "filter_param": "customer", "empty_label": "Walk-in"},
        "assigned_to": {"field": "assigned_to_id", "label": "assigned_to__first_name",
                        "filter_param": "assigned_to", "empty_label": "Unassigned"},
    }

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return BookingCreateSerializer
        return BookingSerializer

    # Single-booking actions whose response the detail page renders: each must
    # carry the coverage fields (eligible_subscription / coverage_state /
    # membership_coverage) so the UI reflects coverage WITHOUT a manual refresh.
    # List/multi-object actions are excluded to avoid per-row coverage cost.
    COVERAGE_ACTIONS = frozenset({
        "retrieve", "transition", "complete", "bill", "cancel", "no_show", "reopen",
        "redeem_subscription", "unapply_subscription", "apply_promo",
        "remove_promo", "assign", "skip_assignment",
    })

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        # Membership coverage is a single-object field (avoids per-row list cost).
        ctx["with_coverage"] = self.action in self.COVERAGE_ACTIONS
        return ctx

    def get_queryset(self):
        qs = super().get_queryset()
        user = self.request.user
        if user.role == Role.CUSTOMER:
            return qs.filter(customer__linked_user=user)

        # Club scoping: users limited to clubs see only those clubs' bookings
        # (plus club-less mobile jobs). Super_admin/admin are unrestricted.
        club_ids = user.scoped_club_ids()
        if club_ids is not None:
            qs = qs.filter(Q(club_id__in=club_ids) | Q(club__isnull=True))

        # Record ownership: without `bookings.view_all` a user sees only records
        # they own (created or assigned to them) plus unclaimed work. Managers /
        # admins hold view_all, so their club-wide visibility is unchanged.
        if not access.can_view_all(user, "bookings"):
            qs = qs.filter(Q(created_by=user) | Q(assigned_to=user) | Q(assigned_to__isnull=True))
        return qs

    def _owns_booking(self, obj):
        u = self.request.user
        return obj.created_by_id == u.id or obj.assigned_to_id == u.id

    def _guard_modify(self, obj):
        """Editing/deleting OTHERS' bookings needs `bookings.modify_all`."""
        u = self.request.user
        if u.role == Role.CUSTOMER:
            return                                  # customer ownership via object perm
        if access.can_modify_all(u, "bookings") or self._owns_booking(obj):
            return
        raise PermissionDenied("You can only modify bookings you own. Ask for Modify All access.")

    # ----------------------------------------------------------------- #
    # Slot availability
    # ----------------------------------------------------------------- #
    @action(detail=True, methods=["get"], url_path="free-facilities")
    def free_facilities(self, request, pk=None):
        """Facilities that could still take THIS booking's slot.

        Drives the staff override picker: it lists only units that can host the
        booked facility type, are not out for maintenance, and are free for the
        booking's whole interval - so the dialog can never offer a choice the
        server would reject. The currently-assigned facility is included.
        """
        booking = self.get_object()
        free = booking_services.free_facilities(
            booking.scheduled_date, booking.scheduled_time,
            duration=booking.duration_minutes, club=booking.club,
            facility_type=booking.facility_type, exclude_booking_id=booking.id,
        )
        return Response({
            "booking": booking.id,
            "current": booking.facility_id,
            "results": [{"id": f.id, "name": f.name, "club": f.club_id} for f in free],
        })

    @action(detail=False, methods=["get"], url_path="booking-window")
    def booking_window(self, request):
        """`?club=<id>` -> the dates/times the policy allows a booking in.

        The date picker uses this to grey out what the server would refuse, so a
        customer is never offered a day only to be told it is too far ahead.
        """
        club = None
        club_id = request.query_params.get("club")
        if club_id:
            from apps.clubs.models import Club
            club = Club.objects.filter(pk=club_id).first()
        return Response(booking_services.booking_window(club))

    @action(detail=False, methods=["get"], url_path="availability")
    def availability(self, request):
        """`?club=<id>&date=YYYY-MM-DD&facility_type=<id>` -> available slots.

        `facility_type` matters: capacity is the facilities that can host THAT
        type, and each slot is tested against the type's full duration.
        """
        raw_date = request.query_params.get("date")
        try:
            on_date = date_cls.fromisoformat(raw_date) if raw_date else date_cls.today()
        except ValueError:
            return Response({"detail": "Invalid date (expected YYYY-MM-DD)."},
                            status=status.HTTP_400_BAD_REQUEST)
        club = None
        club_id = request.query_params.get("club")
        if club_id:
            from apps.clubs.models import Club
            club = Club.objects.filter(pk=club_id).first()
        facility_type = None
        ft_id = request.query_params.get("facility_type")
        if ft_id:
            from apps.facilities.models import FacilityType
            facility_type = FacilityType.objects.filter(pk=ft_id).first()
            if facility_type is None:
                return Response({"detail": "Facility type not found."},
                                status=status.HTTP_404_NOT_FOUND)

        slots = booking_services.available_slots(
            on_date, club=club, facility_type=facility_type)
        return Response({"club": club.id if club else None,
                         "facility_type": facility_type.id if facility_type else None,
                         "date": on_date.isoformat(), "slots": slots})

    @action(detail=False, methods=["post"], url_path="price-preview")
    def price_preview(self, request):
        """Backend-computed price breakdown for a draft booking (no save).

        Drives the live "Price Calculation Summary": evaluates the same engine
        used on save (catalogue → pricing rules → promo → VAT) so the UI never
        guesses. Returns base/add-ons, the applied rules, discount/surcharge
        totals, VAT and the final amount.
        """
        from datetime import time as time_cls
        from apps.facilities.models import AddOn
        from apps.settings_app.currency import get_default_currency

        d = request.data
        num = lambda v: int(v) if str(v or "").isdigit() else None      # noqa: E731
        pdate = lambda v: (date_cls.fromisoformat(v) if v else None)    # noqa: E731

        if not (num(d.get("facility_type")) or num(d.get("facility_category"))):
            return Response({"detail": "Select a facility to preview pricing."},
                            status=status.HTTP_400_BAD_REQUEST)

        try:
            booking = Booking(
                currency=get_default_currency(),
                facility_type_id=num(d.get("facility_type")),
                facility_category_id=num(d.get("facility_category")),
                customer_id=num(d.get("customer")),
                club_id=num(d.get("club")),
                booking_type=d.get("booking_type") or "",
                scheduled_date=pdate(d.get("scheduled_date")) or date_cls.today(),
                scheduled_time=time_cls.fromisoformat(d["scheduled_time"]) if d.get("scheduled_time") else time_cls(0, 0),
            )
            promo = None
            code = (d.get("promo_code_input") or "").strip()
            if code:
                from apps.promotions import services as promo_services
                try:
                    promo = promo_services.get_active_promo(code)
                except promo_services.PromoError:
                    promo = None   # preview ignores invalid codes; final save validates
            booking.promo_code = promo
            addon_ids = [int(x) for x in (d.get("add_ons") or []) if str(x).isdigit()]
            addon_objs = list(AddOn.objects.filter(id__in=addon_ids))
            booking.compute_pricing(addons=addon_objs)
            # Membership coverage summary (read-only) for the live booking form —
            # mirrors what compute_pricing already zero-priced; never None-safe to fail.
            from apps.payments.services import coverage_summary
            coverage = coverage_summary(booking, addon_objs=addon_objs)
        except (ValueError, TypeError):
            return Response({"detail": "Could not preview pricing for the selection."},
                            status=status.HTTP_400_BAD_REQUEST)

        return Response({
            "base_amount": booking.base_amount,
            "addons_amount": booking.addons_amount,
            "subtotal": booking.base_amount + booking.addons_amount,
            "applied_rules": booking.applied_rules,
            "discount_total": booking.discount_amount,
            "surcharge_total": booking.surcharge_amount,
            "promo_discount": booking.promo_discount,
            "promo_applied": bool(booking.promo_code_id),
            "vat_amount": booking.tax_amount,
            "tax_inclusive": bool(getattr(booking.facility_type, "tax_inclusive", False)) if booking.facility_type_id else False,
            "final_amount": booking.total_amount,
            "currency": booking.currency,
            "coverage": coverage,
        })

    @action(detail=False, methods=["post"], url_path="validate-promo")
    def validate_promo(self, request):
        """Validate a promo code against the DRAFT booking (no save) so the form can
        show a real apply/valid/invalid result + the discount. Always 200; the body
        carries `valid` + a user-facing `message`. Mirrors the save-time checks."""
        from datetime import time as time_cls
        from apps.promotions import services as promo_services
        from apps.facilities.models import AddOn
        from apps.settings_app.currency import get_default_currency

        d = request.data
        code = (d.get("code") or d.get("promo_code_input") or "").strip()
        if not code:
            return Response({"valid": False, "message": "Enter a promo code."})

        num = lambda v: int(v) if str(v or "").isdigit() else None      # noqa: E731
        if not (num(d.get("facility_type")) or num(d.get("facility_category"))):
            return Response({"valid": False, "message": "Select a facility before applying a code."})
        try:
            booking = Booking(
                currency=get_default_currency(),
                facility_type_id=num(d.get("facility_type")),
                facility_category_id=num(d.get("facility_category")),
                customer_id=num(d.get("customer")),
                club_id=num(d.get("club")),
                booking_type=d.get("booking_type") or "",
                scheduled_date=date_cls.fromisoformat(d["scheduled_date"]) if d.get("scheduled_date") else date_cls.today(),
                scheduled_time=time_cls.fromisoformat(d["scheduled_time"]) if d.get("scheduled_time") else time_cls(0, 0),
            )
            addon_objs = list(AddOn.objects.filter(
                id__in=[int(x) for x in (d.get("add_ons") or []) if str(x).isdigit()]))
            booking.compute_pricing(addons=addon_objs)   # price WITHOUT the promo
        except (ValueError, TypeError):
            return Response({"valid": False, "message": "Could not price the selection."})

        # Subtotal the promo applies to (post-rules, pre-tax) — mirrors save + apply-promo.
        subtotal = booking.total_amount - booking.tax_amount
        try:
            promo = promo_services.get_active_promo(code)
            category_ids = (list(booking.facility_type.categories.values_list("id", flat=True))
                            if booking.facility_type_id else [])
            promo_services.validate_for_booking(
                promo, subtotal=subtotal, customer_id=booking.customer_id,
                facility_type_id=booking.facility_type_id, category_ids=category_ids,
                addon_ids=[a.id for a in addon_objs],
            )
        except promo_services.PromoError as exc:
            return Response({"valid": False, "message": str(exc)})

        booking.promo_code = promo
        booking.compute_pricing(addons=addon_objs)       # re-price WITH the promo
        return Response({
            "valid": True,
            "code": promo.code,
            "description": promo.description,
            "discount": booking.promo_discount,
            "final_amount": booking.total_amount,
            "currency": booking.currency,
            "message": f"“{promo.code}” applied",
        })

    # ----------------------------------------------------------------- #
    # Lifecycle actions
    # ----------------------------------------------------------------- #
    def create(self, request, *args, **kwargs):
        try:
            return super().create(request, *args, **kwargs)
        except AvailabilityConflict as exc:
            return Response(exc.body, status=status.HTTP_409_CONFLICT)

    def update(self, request, *args, **kwargs):
        try:
            return super().update(request, *args, **kwargs)
        except AvailabilityConflict as exc:
            return Response(exc.body, status=status.HTTP_409_CONFLICT)

    def _enforce_assignment_availability(self, booking):
        """If the booking has a worker/facility assigned, enforce the same shift+facility
        availability rule as the assign action. Raises a 409 (AvailabilityConflict)
        unless the caller holds bookings.assign_override and passed override=true,
        in which case the override is recorded on the booking timeline."""
        if not (booking.assigned_to_id or booking.facility_id):
            return
        reasons = assignment_conflicts(
            worker=booking.assigned_to if booking.assigned_to_id else None,
            facility=booking.facility if booking.facility_id else None, club=booking.club,
            on_date=booking.scheduled_date, at_time=booking.scheduled_time,
            duration=booking.duration_minutes, facility_type=booking.facility_type,
            exclude_booking_id=booking.id)
        if not reasons:
            return
        request = self.request
        can_override = request.user.has_perm_code("bookings.assign_override")
        overriding = can_override and str(
            request.data.get("override", "")).lower() in ("1", "true", "yes")
        if not overriding:
            raise AvailabilityConflict(reasons, overridable=can_override)
        booking_services.record_booking_event(
            booking, f"Availability override: {' '.join(reasons)}", actor=request.user)

    def _log_coverage_and_payment(self, booking):
        """Booking-log entries for the subscription coverage outcome + the resulting
        payment status (the booking-time scenario behind a 0 / partial charge)."""
        snap = booking.coverage_snapshot
        if snap:
            booking_services.record_booking_event(
                booking,
                f"Subscription coverage applied - {snap['membership_number']} ({snap['plan_name']})",
                actor=self.request.user, event="coverage_applied", meta=snap)
        booking_services.record_booking_event(
            booking, f"Payment status: {booking.get_payment_status_display()}",
            actor=self.request.user, event="payment_status",
            meta={"to": booking.payment_status, "payable": str(booking.total_amount),
                  "currency": booking.currency})

    def perform_create(self, serializer):
        # Atomic so a 409 on the availability check rolls back the save (no
        # ATOMIC_REQUESTS) and the form sees the same conflict the assign action raises.
        with transaction.atomic():
            booking = serializer.save()
            self._enforce_assignment_availability(booking)
            # Hold any covered membership units for this booking (released on
            # cancel/no-show/reopen, converted to a deduction on completion).
            from apps.payments.services import reserve_for_booking
            reserve_for_booking(booking, request=self.request)
        self._log_coverage_and_payment(booking)
        log_event(self.request, "booking_created",
                  {"reference": booking.reference, "total": str(booking.total_amount)},
                  status_code=201)

    def perform_update(self, serializer):
        self._guard_modify(serializer.instance)
        was_completed = serializer.instance.status == BookingStatus.COMPLETED
        prev_payment_status = serializer.instance.payment_status
        with transaction.atomic():
            booking = serializer.save()
            self._enforce_assignment_availability(booking)
            # Re-sync the membership hold to the (possibly changed) selection, but not
            # once the booking is terminal (consumed/restored already settled).
            if booking.status not in (BookingStatus.COMPLETED, BookingStatus.CANCELLED,
                                      BookingStatus.NO_SHOW, BookingStatus.CLOSED):
                from apps.payments.services import reserve_for_booking
                reserve_for_booking(booking, request=self.request)
        booking_services.record_booking_event(
            booking, "Booking details updated", actor=self.request.user)
        # Surface a coverage/payment-status change caused by the edit.
        if booking.payment_status != prev_payment_status:
            self._log_coverage_and_payment(booking)
        if was_completed:
            # Editing a completed booking is a sensitive action — flag it.
            log_event(self.request, "booking_edited_after_completion",
                      {"reference": booking.reference})

    @action(detail=False, methods=["get"], url_path="deletion-reasons")
    def deletion_reasons(self, request):
        """Standard reasons offered by the delete-booking dialog."""
        return Response(BOOKING_DELETION_REASONS)

    def perform_destroy(self, instance):
        self._guard_modify(instance)
        # A completed/closed booking is a permanent financial record — it must never
        # be deleted (cancel it, or reverse the money with a credit note instead).
        if instance.status in COMPLETED_STATUSES:
            raise _Conflict(
                "A completed or closed booking can't be deleted. Cancel it instead, "
                "and issue a credit note for any payment already taken.")
        # Paid (or part-paid) bookings can NEVER be deleted — money has been taken.
        if instance.payment_status in PAID_PAYMENT_STATUSES or \
                instance.payments.exists() or instance.invoices.exists():
            raise _Conflict(
                "This booking has been paid (or has payments/invoices) and can't be "
                "deleted. Reverse the money first (e.g. issue a credit note), then cancel it.")

        # A reason is mandatory for the deletion audit trail. "Other" needs a note.
        data = getattr(self.request, "data", {}) or {}
        reason = str(data.get("reason") or "").strip()
        note = str(data.get("reason_note") or "").strip()
        if not reason:
            raise ValidationError({"reason": "Select or enter a reason for deleting this booking."})
        if reason.lower() == "other" and not note:
            raise ValidationError({"reason_note": "Describe the reason when choosing “Other”."})

        ref = instance.reference
        # Record WHO/WHAT/WHEN before the row is gone (cascade removes history etc.).
        log_event(self.request, "booking_deleted",
                  {"reference": ref, "reason": reason, "note": note,
                   "status": instance.status,
                   "customer": getattr(instance.customer, "customer_code", None),
                   "changes": {"Deleted booking": {"from": ref, "to": "removed"},
                               "Reason": reason + (f" - {note}" if note else "")}},
                  subject=("customer", instance.customer_id) if instance.customer_id else None)

        # Release any held membership units before the booking goes away.
        from apps.payments.services import restore_for_booking
        restore_for_booking(instance, request=self.request)
        # Return any loyalty points redeemed against this booking (fail-safe).
        try:
            from apps.loyalty.services import reverse_loyalty_for_cancellation
            reverse_loyalty_for_cancellation(instance, actor=self.request.user, request=self.request)
        except Exception:
            pass
        try:
            instance.delete()   # cascades the status history, etc.
        except ProtectedError:
            raise _Conflict(
                "This booking has linked records and can't be deleted. "
                "Cancel it instead.")

    @action(detail=False, methods=["post"])
    def duplicate(self, request):
        """Create a booking from a duplicated payload — same inputs, fresh date/time
        (the source's history, invoices and payments are never copied).
        Gated by the dedicated `bookings.duplicate` capability."""
        if not request.user.has_perm_code("bookings.duplicate"):
            return Response({"detail": "You don't have permission to duplicate bookings."},
                            status=status.HTTP_403_FORBIDDEN)
        serializer = BookingCreateSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        booking = serializer.save()
        log_event(request, "booking_duplicated",
                  {"reference": booking.reference, "total": str(booking.total_amount)},
                  status_code=201)
        return Response(self.get_serializer(booking).data,
                        status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"], url_path="transition")
    def transition(self, request, pk=None):
        """Move a booking to the next lifecycle status (guarded)."""
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.edit"):
            return Response({"detail": "You don't have permission to change booking status."},
                            status=status.HTTP_403_FORBIDDEN)
        ser = StatusActionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        target = ser.validated_data.get("status")
        if not target:
            return Response({"detail": "`status` is required."},
                            status=status.HTTP_400_BAD_REQUEST)
        # Business rule: a booking can't move into the ASSIGNED stage with no one
        # assigned unless the user is allowed to skip assignment. Closes the raw
        # status-transition bypass (the assign/skip endpoints handle the valid
        # paths).
        if (target == BookingStatus.ASSIGNED and booking.assigned_to_id is None
                and not request.user.has_perm_code("bookings.skip_assignment")):
            return Response(
                {"detail": "Assign a staff member before moving this booking to Assigned, "
                           "or use Skip assignment if you have permission."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            booking = booking_services.transition_booking(
                booking, target, actor=request.user,
                note=ser.validated_data.get("note", ""), request=request,
            )
        except ValueError as exc:
            # `code` distinguishes "this needs paying first" from every other
            # refusal, so the screen can offer to take the payment rather than
            # leaving staff at a dead end.
            return Response({"detail": str(exc), "code": getattr(exc, "code", "")},
                            status=status.HTTP_400_BAD_REQUEST)
        log_event(request, "booking_status_change",
                  {"reference": booking.reference, "to": target})
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"])
    def complete(self, request, pk=None):
        """Completion & payment wizard: record the payment (when one is owed and
        not already paid) then transition to Completed — which auto-generates the
        invoice and receipt. Enforces the payment-before-completion rule."""
        from decimal import Decimal

        from apps.payments import services as pay
        from apps.payments.models import Payment
        from apps.payments.models import PaymentStatus as PayStatus

        from .models import PaymentStatus as BookingPaymentStatus

        booking = self.get_object()
        if not request.user.has_perm_code("bookings.edit"):
            return Response({"detail": access.denial_message("bookings", "edit")},
                            status=status.HTTP_403_FORBIDDEN)

        ser = CompleteBookingSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data

        # Revalidate coverage BEFORE deciding what's owed: a held unit consumed by
        # another booking makes this one chargeable now (no free completion on a
        # unit it no longer holds).
        reval = pay.revalidate_booking_coverage(booking, request=request)
        if reval:
            booking_services.record_booking_event(
                booking, "Subscription no longer available - booking is now chargeable",
                actor=request.user, event="coverage_revalidated",
                meta={"source": "Staff", "membership": reval["membership"],
                      "from_amount": reval["from_amount"], "to_amount": reval["to_amount"],
                      "currency": booking.currency})

        # Only the still-OUTSTANDING amount is collected — a booking invoiced + paid
        # up front (or partially, after add-ons) is never re-charged, and only the
        # delta is asked for. Money on file is read from real Payment rows.
        outstanding = booking_services.booking_outstanding(booking)
        needs_payment = outstanding > 0 and booking.payment_status != BookingPaymentStatus.PAID

        if needs_payment:
            if not request.user.has_perm_code("payments.add"):
                return Response({"detail": access.denial_message("payments", "add")},
                                status=status.HTTP_403_FORBIDDEN)
            method = data.get("method")
            if not method:
                return Response(
                    {"detail": "Select a payment method to complete this booking."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if booking.customer_id:
                try:
                    booking_services.settle_booking_payment(
                        booking, method=method, amount=data.get("amount") or outstanding,
                        reference=data.get("reference", ""), notes=data.get("notes", ""),
                        request=request)
                except ValueError as exc:
                    return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            else:
                # Walk-in (B2C): no Customer row to attach a Payment to — mark paid;
                # the completion invoice (with its bill-to snapshot) is raised by
                # finalize_booking_finance on the transition below.
                booking.payment_status = BookingPaymentStatus.PAID
                booking.save(update_fields=["payment_status", "updated_at"])
                from apps.settings_app.currency import format_currency
                booking_services.record_booking_event(
                    booking, f"Payment recorded - {method} "
                             f"{format_currency(outstanding, booking.currency)}",
                    actor=request.user)

        try:
            booking = booking_services.transition_booking(
                booking, BookingStatus.COMPLETED, actor=request.user,
                note="Completed", request=request,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        log_event(request, "booking_completed", {"reference": booking.reference})
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"])
    def bill(self, request, pk=None):
        """Manual 'Generate Invoice & take payment' — the Invoice & Receipt wizard
        run before completion. Captures the outstanding amount (or the entered
        amount) and raises its paid invoice + receipt, WITHOUT changing the booking
        status. Used for paying in advance and for billing later add-ons (delta)."""
        from .models import PaymentStatus as BookingPaymentStatus

        booking = self.get_object()
        if not (request.user.has_perm_code("invoicing.add")
                and request.user.has_perm_code("payments.add")):
            return Response(
                {"detail": "You don't have permission to invoice and take payment."},
                status=status.HTTP_403_FORBIDDEN)
        if booking.status in {BookingStatus.CANCELLED, BookingStatus.NO_SHOW}:
            return Response({"detail": "This booking is cancelled - it cannot be invoiced."},
                            status=status.HTTP_400_BAD_REQUEST)
        if not booking.customer_id:
            return Response(
                {"detail": "Generate the invoice for a walk-in at Complete & Pay."},
                status=status.HTTP_400_BAD_REQUEST)
        ser = CompleteBookingSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        method = data.get("method")
        if not method:
            return Response({"detail": "Select a payment method."},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            booking_services.settle_booking_payment(
                booking, method=method, amount=data.get("amount"),
                reference=data.get("reference", ""), notes=data.get("notes", ""),
                request=request)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        booking.refresh_from_db()
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["get"])
    def finance(self, request, pk=None):
        """Consolidated financial history for a booking: invoices, payments (each
        with nested refunds) and a summary — so the whole Invoice → Payment →
        Refund trail is available on one screen without extra lookups."""
        from apps.payments.models import Invoice, Payment
        from apps.payments.serializers import InvoiceSerializer, PaymentSerializer

        booking = self.get_object()
        can_invoices = request.user.has_perm_code("invoicing.view")
        can_payments = request.user.has_perm_code("payments.view")
        if not (can_invoices or can_payments):
            return Response({"detail": "You don't have permission to view finances."},
                            status=status.HTTP_403_FORBIDDEN)
        ctx = {"request": request}
        # Strictly scope each section to its own capability — invoices + their
        # returns (credit notes) need invoicing.view; payments + their refunds need
        # payments.view. A user only ever receives what they're entitled to see.
        invoices = []
        if can_invoices:
            invoices = InvoiceSerializer(
                (Invoice.objects.filter(booking=booking)
                 .select_related("customer", "payment", "receipt")
                 .prefetch_related("credit_notes", "credit_notes__refund")
                 .order_by("-issued_at")), many=True, context=ctx).data
        payments = []
        if can_payments:
            payments = PaymentSerializer(
                (Payment.objects.filter(booking=booking)
                 .select_related("created_by")
                 .prefetch_related("refunds", "refunds__created_by", "refunds__credit_note")
                 .order_by("-created_at")), many=True, context=ctx).data
        # Who actually paid, when a booking was settled by several people. Kept
        # behind payments.view because it is a money record. A participant's
        # email and phone are a THIRD PARTY's contact details sitting on
        # somebody else's booking, so they need `payments.view_payer_contacts`
        # on top: reception chasing an unpaid share needs them, and most staff
        # reading a booking do not.
        splits = []
        can_contacts = request.user.has_perm_code("payments.view_payer_contacts")
        if can_payments:
            from apps.payments.models import BookingPaymentSplit
            # A split covers EITHER one booking or a whole multi-slot order.
            # Filtering on `booking` alone found only the first kind, so every
            # slot of a split multi-slot order showed no payers at all: the
            # arrangement hangs off the order, and the slot is what staff open.
            scope = Q(booking=booking)
            if booking.order_id:
                scope |= Q(order_id=booking.order_id)
            for split in (BookingPaymentSplit.objects.filter(scope)
                          .prefetch_related("shares", "shares__payment")
                          .order_by("-created_at")):
                splits.append({
                    "id": split.id,
                    "status": "expired" if split.is_expired else split.status,
                    "currency": split.currency,
                    "expires_at": split.expires_at,
                    "allocated": str(split.amount_allocated),
                    "paid": str(split.paid_total),
                    "shares": [{
                        "id": sh.id,
                        # The organizer IS the booking's customer, so their
                        # name is known even when the share was created without
                        # one. "Organizer" as a name tells staff nothing and
                        # reads like a second, anonymous participant.
                        "name": (sh.display_name if sh.participant_name
                                 else (split.organizer.full_name if sh.is_organizer
                                       else sh.display_name)),
                        "is_organizer": sh.is_organizer,
                        "amount": str(sh.amount),
                        "status": sh.status,
                        "paid_at": sh.paid_at,
                        "payment": sh.payment.reference if sh.payment_id else None,
                        # Absent, not blank, without the capability: a key that
                        # is always present invites a UI that renders an empty
                        # contact row and makes it look like none was given.
                        **({"email": sh.participant_email,
                            "phone": sh.participant_phone} if can_contacts else {}),
                    } for sh in split.shares.all()],
                })
        return Response({"invoices": invoices, "payments": payments,
                         "splits": splits})

    @action(detail=True, methods=["post"], url_path="split-share-link")
    def split_share_link(self, request, pk=None):
        """Issue a fresh payment link for one unpaid share, for staff to pass on.

        This ISSUES a link, it does not reveal the existing one: raw tokens are
        never stored, only their digests, so nobody, including us, can look up
        the link the customer was given. Minting a new one is the only honest
        recovery, and it is also the right answer when a link went somewhere it
        should not have.

        The previous link therefore stops working. That is the whole point when
        a link has leaked, and a trap when reception is only being helpful, so
        the caller is told plainly and the reissue is recorded on the booking's
        own timeline.

        Gated on `payments.add`: this is part of collecting money for a booking,
        which is exactly who should be able to do it.
        """
        from apps.payments import split as split_service
        from apps.payments.models import BookingPaymentShare

        booking = self.get_object()
        if not request.user.has_perm_code("payments.add"):
            return Response({"detail": access.denial_message("payments", "add")},
                            status=status.HTTP_403_FORBIDDEN)

        share_id = request.data.get("share")
        # A split covers either this booking or the order it belongs to, and the
        # share must be reached THROUGH one of those: an id from the request is
        # otherwise a way to mint a link for somebody else's booking entirely.
        scope = Q(split__booking=booking)
        if booking.order_id:
            scope |= Q(split__order_id=booking.order_id)
        share = (BookingPaymentShare.objects
                 .select_related("split")
                 .filter(scope, pk=share_id)
                 .first())
        if share is None:
            return Response({"detail": "That share was not found on this booking."},
                            status=status.HTTP_404_NOT_FOUND)

        try:
            share, raw = split_service.regenerate_share_token(
                share.split, share.id, request=request)
            url = split_service.share_link(raw)
        except split_service.SplitError as exc:
            return Response({"detail": str(exc), "code": exc.code},
                            status=status.HTTP_400_BAD_REQUEST)

        log_event(request, "split_share_link_reissued",
                  {"reference": booking.reference, "share": share.id})
        # The deadline comes with it. A link with no stated expiry is one staff
        # will send on tomorrow, and the arrangement, not the token, is what
        # runs out: reissuing does not extend it, because a link that outlived
        # the reservation would keep collecting for a court already resold.
        return Response({"share": share.id, "name": share.display_name,
                         "amount": str(share.amount), "url": url,
                         "expires_at": share.split.expires_at})

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        booking = self.get_object()
        # Customers may cancel their own bookings (object perm already enforced);
        # staff need the `bookings.cancel` capability.
        if request.user.role != Role.CUSTOMER and not request.user.has_perm_code("bookings.cancel"):
            return Response({"detail": "You don't have permission to cancel bookings."},
                            status=status.HTTP_403_FORBIDDEN)
        # A customer may only cancel inside the club's cancellation window; staff
        # are never blocked, so a member who phones in is still looked after.
        try:
            booking_services.enforce_cancellation_window(
                booking, actor_is_customer=request.user.role == Role.CUSTOMER)
        except booking_services.CancellationTooLate as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        ser = StatusActionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            booking = booking_services.transition_booking(
                booking, BookingStatus.CANCELLED, actor=request.user,
                note=ser.validated_data.get("note", ""),
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        log_event(request, "booking_cancelled", {"reference": booking.reference})
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"], url_path="no-show")
    def no_show(self, request, pk=None):
        """Mark the customer as a no-show."""
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.cancel"):
            return Response({"detail": "You don't have permission to mark no-show."},
                            status=status.HTTP_403_FORBIDDEN)
        ser = StatusActionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            booking = booking_services.transition_booking(
                booking, BookingStatus.NO_SHOW, actor=request.user,
                note=ser.validated_data.get("note", ""),
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        log_event(request, "booking_no_show", {"reference": booking.reference})
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        """Reopen a mistakenly-closed booking (requires `bookings.reopen`)."""
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.reopen"):
            return Response({"detail": "You don't have permission to reopen bookings."},
                            status=status.HTTP_403_FORBIDDEN)
        ser = StatusActionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            booking = booking_services.reopen_booking(
                booking, actor=request.user, note=ser.validated_data.get("note", ""),
                request=request,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        log_event(request, "booking_reopened",
                  {"reference": booking.reference, "to": booking.status})
        return Response(self.get_serializer(booking).data)

    def _subscription_change_guard(self, booking):
        """Redeem / Unapply are a PRE-INVOICE subscription action: allowed only while
        the booking is non-terminal and no invoice has been raised (and no money
        taken). Once an invoice exists, coverage is frozen — invoices are never
        auto-cancelled here. Returns a 400 Response when not allowed, else None."""
        reason = booking_services.coverage_change_locked(booking)
        if reason:
            return Response({"detail": reason}, status=status.HTTP_400_BAD_REQUEST)
        return None

    @action(detail=True, methods=["post"], url_path="redeem-subscription")
    def redeem_subscription(self, request, pk=None):
        """Apply an eligible subscription's coverage to an EXISTING booking without
        editing/resaving it: re-prices (coverage applies), holds the unit, updates
        the payable amount + payment status, snapshots, and logs. Gated by
        `bookings.apply_subscription`; pre-payment + non-terminal only."""
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.apply_subscription"):
            return Response({"detail": access.denial_message("bookings", "apply_subscription")},
                            status=status.HTTP_403_FORBIDDEN)
        blocked = self._subscription_change_guard(booking)
        if blocked:
            return blocked
        from apps.payments.services import coverage_for_booking, reserve_for_booking
        # Eligibility = a truly-free unit exists (holds are soft), so a booking can
        # redeem even while another only holds the unit.
        cov = coverage_for_booking(booking, ignore_opt_out=True, for_consumption=True)
        if not cov or not cov["covered_lines"]:
            return Response({"detail": "No eligible subscription is available for this booking."},
                            status=status.HTTP_400_BAD_REQUEST)
        prev_total, prev_status = str(booking.total_amount), booking.payment_status
        booking.subscription_opt_out = False
        # Force the redeemed coverage onto the price (don't let the soft hold of
        # another booking re-mark this one chargeable).
        booking.compute_pricing(covered_override={
            "membership": cov["membership"],
            "covered_service_item": cov["covered_service_item"],
            "covered_addon_ids": cov["covered_addon_ids"],
        })
        booking.sync_payment_status()
        booking.save()
        reserve_for_booking(booking, request=request, for_consumption=True)   # soft hold
        snap = booking.coverage_snapshot or {}
        booking_services.record_booking_event(
            booking,
            f"Subscription redeemed - {snap.get('membership_number', '')} ({snap.get('plan_name', '')})",
            actor=request.user, event="subscription_redeemed",
            meta={**snap, "from_amount": prev_total, "to_amount": str(booking.total_amount),
                  "from_status": prev_status, "to_status": booking.payment_status,
                  "currency": booking.currency})
        log_event(request, "booking_subscription_redeemed",
                  {"reference": booking.reference, "from": prev_total,
                   "to": str(booking.total_amount), "membership": snap.get("membership_number")})
        # Coverage that absorbs the whole booking leaves nothing to collect, so
        # the booking is confirmed here for the same reason a paid one is.
        booking_services.confirm_if_settled(booking, actor=request.user, request=request)
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"], url_path="unapply-subscription")
    def unapply_subscription(self, request, pk=None):
        """Remove subscription coverage from THIS booking only (release the held
        unit, re-price to the full chargeable amount), so it can be paid normally.
        Gated by `bookings.unapply_subscription`; pre-payment + non-terminal only."""
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.unapply_subscription"):
            return Response({"detail": access.denial_message("bookings", "unapply_subscription")},
                            status=status.HTTP_403_FORBIDDEN)
        blocked = self._subscription_change_guard(booking)
        if blocked:
            return blocked
        ser = StatusActionSerializer(data=request.data)   # reuse {note} as the reason
        ser.is_valid(raise_exception=True)
        reason = ser.validated_data.get("note", "")
        from apps.payments.services import restore_for_booking
        prev_total, prev_status = str(booking.total_amount), booking.payment_status
        prev_membership = (booking.coverage_snapshot or {}).get("membership_number")
        restore_for_booking(booking, request=request)   # release the held/covered unit
        booking.subscription_opt_out = True
        booking.compute_pricing()                       # coverage skipped → full price
        booking.sync_payment_status()
        booking.save()
        booking_services.record_booking_event(
            booking, "Subscription unapplied" + (f" - {reason}" if reason else ""),
            actor=request.user, event="subscription_unapplied",
            meta={"membership": prev_membership, "reason": reason,
                  "from_amount": prev_total, "to_amount": str(booking.total_amount),
                  "from_status": prev_status, "to_status": booking.payment_status,
                  "currency": booking.currency})
        log_event(request, "booking_subscription_unapplied",
                  {"reference": booking.reference, "reason": reason,
                   "from": prev_total, "to": str(booking.total_amount)})
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"], url_path="redeem-points")
    def redeem_points(self, request, pk=None):
        """Redeem the customer's loyalty points against this booking to reduce the
        payable. Gated by `loyalty.redeem`; pre-payment only. Body: {points}."""
        booking = self.get_object()
        if not request.user.has_perm_code("loyalty.redeem"):
            return Response({"detail": access.denial_message("loyalty", "redeem")},
                            status=status.HTTP_403_FORBIDDEN)
        from apps.loyalty.services import LoyaltyError, redeem_points
        try:
            result = redeem_points(booking, request.data.get("points"),
                                   actor=request.user, request=request)
        except LoyaltyError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        booking.refresh_from_db()
        booking_services.record_booking_event(
            booking, f"Loyalty redeemed - {result['points']} pts ({result['value']})",
            actor=request.user, event="loyalty_redeemed",
            meta={"points": result["points"], "value": str(result["value"])})
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"], url_path="unredeem-points")
    def unredeem_points(self, request, pk=None):
        """Undo a loyalty redemption on this booking (return the points). Gated by
        `loyalty.redeem`."""
        booking = self.get_object()
        if not request.user.has_perm_code("loyalty.redeem"):
            return Response({"detail": access.denial_message("loyalty", "redeem")},
                            status=status.HTTP_403_FORBIDDEN)
        from apps.loyalty.services import unredeem_points
        unredeem_points(booking, actor=request.user, request=request)
        booking.refresh_from_db()
        booking_services.record_booking_event(
            booking, "Loyalty redemption reversed", actor=request.user,
            event="loyalty_redeem_reversed")
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"], url_path="apply-promo")
    def apply_promo(self, request, pk=None):
        """Validate + apply a promo code to this booking and recompute pricing."""
        from apps.promotions import services as promo_services
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.edit"):
            return Response({"detail": "You don't have permission to edit bookings."},
                            status=status.HTTP_403_FORBIDDEN)
        locked = booking_services.pricing_change_locked(booking)
        if locked:
            return Response({"detail": locked}, status=status.HTTP_400_BAD_REQUEST)
        try:
            promo = promo_services.get_active_promo(request.data.get("code"))
            subtotal = booking.total_amount - booking.tax_amount + booking.promo_discount
            category_ids = (list(booking.facility_type.categories.values_list("id", flat=True))
                            if booking.facility_type_id else [])
            promo_services.validate_for_booking(
                promo, subtotal=subtotal, customer_id=booking.customer_id,
                facility_type_id=booking.facility_type_id, category_ids=category_ids,
                addon_ids=list(booking.add_ons.values_list("id", flat=True)),
                exclude_booking_id=booking.id,
            )
        except promo_services.PromoError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        booking.promo_code = promo
        booking.compute_pricing()
        # A discount can never drop the total below what's already been collected.
        if booking_services.booking_amount_paid(booking) > Decimal(str(booking.total_amount)):
            return Response(
                {"detail": "This promo's discount is more than the unpaid balance - it can't be applied."},
                status=status.HTTP_400_BAD_REQUEST)
        booking_services.sync_booking_payment_status(booking, save=False)
        booking.save()
        promo_services.record_redemption(promo, booking, booking.promo_discount, user=request.user)
        # Keep the code OUT of the free-text note — it lives in structured meta so it
        # can be masked for users without promotions.view.
        booking_services.record_booking_event(
            booking, "Promo applied", actor=request.user, event="promo_applied",
            meta={"code": promo.code, "discount": str(booking.promo_discount)})
        log_event(request, "booking_promo_applied", {"reference": booking.reference, "code": promo.code})
        # A discount big enough to clear the balance settles the booking.
        booking_services.confirm_if_settled(booking, actor=request.user, request=request)
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"], url_path="remove-promo")
    def remove_promo(self, request, pk=None):
        """Detach the promo code and recompute pricing."""
        from django.db.models import F
        from apps.promotions.models import PromoCode, PromoRedemption
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.edit"):
            return Response({"detail": "You don't have permission to edit bookings."},
                            status=status.HTTP_403_FORBIDDEN)
        locked = booking_services.pricing_change_locked(booking)
        if locked:
            return Response({"detail": locked}, status=status.HTTP_400_BAD_REQUEST)
        prev_code = booking.promo_code.code if booking.promo_code_id else None
        if booking.promo_code_id:
            removed = PromoRedemption.objects.filter(promo_id=booking.promo_code_id, booking=booking)
            if removed.exists():
                PromoCode.objects.filter(pk=booking.promo_code_id).update(used_count=F("used_count") - 1)
                removed.delete()
        booking.promo_code = None
        booking.compute_pricing()
        booking.save()
        booking_services.record_booking_event(
            booking, "Promo removed", actor=request.user, event="promo_removed",
            meta={"code": prev_code} if prev_code else None)
        log_event(request, "booking_promo_removed",
                  {"reference": booking.reference, "code": prev_code})
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"])
    def assign(self, request, pk=None):
        """Assign a staff member (and optionally a facility) to a booking."""
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.assign"):
            return Response({"detail": "You don't have permission to assign bookings."},
                            status=status.HTTP_403_FORBIDDEN)
        ser = AssignSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            worker = User.objects.get(pk=ser.validated_data["assigned_to"])
        except User.DoesNotExist:
            return Response({"detail": "Worker not found."},
                            status=status.HTTP_404_NOT_FOUND)
        if worker.role not in STAFF_ROLES:
            return Response({"detail": "Can only assign staff users."},
                            status=status.HTTP_400_BAD_REQUEST)

        # --- Shift / facility availability enforcement -------------------------- #
        # The worker must be scheduled to work then (and free), and any facility must
        # be active, at this club, and free. Holders of bookings.assign_override
        # may force past a failure; the override is recorded in the audit trail.
        from apps.facilities.models import Facility

        facility = booking.facility
        if "facility" in ser.validated_data:
            facility_id = ser.validated_data.get("facility")
            facility = (Facility.objects.filter(pk=facility_id, club=booking.club).first()
                        if (facility_id and booking.club_id) else None)

        reasons = assignment_conflicts(
            worker=worker, facility=facility, club=booking.club,
            on_date=booking.scheduled_date, at_time=booking.scheduled_time,
            duration=booking.duration_minutes, facility_type=booking.facility_type,
            exclude_booking_id=booking.id)

        overriding = bool(ser.validated_data.get("override")) and \
            request.user.has_perm_code("bookings.assign_override")
        if reasons and not overriding:
            can_override = request.user.has_perm_code("bookings.assign_override")
            return Response(
                {"detail": " ".join(reasons), "code": "availability",
                 "overridable": can_override}, status=status.HTTP_409_CONFLICT)

        # Assigning a worker walks the booking forward through Confirmed, and the
        # confirmation gate applies to that step exactly as it would to pressing
        # Confirm. Asked BEFORE anything is written, so a refusal does not leave a
        # worker assigned to a booking that never moved.
        try:
            booking_services.check_confirmable(booking)
        except ValueError as exc:
            return Response({"detail": str(exc), "code": "not_confirmable"},
                            status=status.HTTP_409_CONFLICT)

        booking.assigned_to = worker
        if "facility" in ser.validated_data:
            booking.facility = facility
        booking.save(update_fields=["assigned_to", "facility", "updated_at"])
        prior_status = booking.status
        # Move the booking forward into the Assigned stage. Confirm first if it's
        # still Pending so the lifecycle stays linear.
        if booking.status == BookingStatus.BOOKED:
            booking_services.transition_booking(
                booking, BookingStatus.CONFIRMED, actor=request.user,
                note="Confirmed on assignment",
            )
        if booking.status == BookingStatus.CONFIRMED:
            booking_services.transition_booking(
                booking, BookingStatus.ASSIGNED, actor=request.user,
                note=f"Assigned to {worker.full_name}",
            )
        # On a reassignment the status doesn't change, so the transition row above
        # didn't log it — record an explicit timeline event for visibility.
        if prior_status == BookingStatus.ASSIGNED:
            booking_services.record_booking_event(
                booking, f"Reassigned to {worker.full_name}", actor=request.user)
        if overriding and reasons:
            booking_services.record_booking_event(
                booking, f"Availability override: {' '.join(reasons)}", actor=request.user)
        from apps.staff.services import staff_subject
        summary = {"reference": booking.reference, "worker": worker.email}
        if overriding and reasons:
            summary["override"] = reasons
        log_event(request, "booking_assigned", summary, subject=staff_subject(worker))
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"], url_path="finish-draft")
    def finish_draft(self, request, pk=None):
        """Turn a saved draft into a real booking.

        A draft holds no court, so this is the first moment availability
        matters, and it may well have gone while the draft sat there. That is
        the honest place to find out: the alternative is a court promised
        twice and somebody turned away at the door.
        """
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.edit"):
            return Response({"detail": access.denial_message("bookings", "edit")},
                            status=status.HTTP_403_FORBIDDEN)
        if booking.status != BookingStatus.DRAFT:
            return Response({"detail": "This booking is not a draft.",
                             "code": "not_a_draft"},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            booking_services.finish_draft(booking, actor=request.user)
        except booking_services.DraftIncomplete as exc:
            return Response({"detail": str(exc), "code": "draft_incomplete",
                             "missing": exc.missing},
                            status=status.HTTP_400_BAD_REQUEST)
        except booking_services.FacilityUnavailable as exc:
            # The court went while the draft was sitting there. Say which and
            # why, rather than a bare validation error.
            return Response({"detail": str(exc), "code": "slot_unavailable"},
                            status=status.HTTP_409_CONFLICT)
        except booking_services.BookingRuleViolation as exc:
            return Response({"detail": " ".join(exc.reasons), "code": "rules",
                             "rules": exc.reasons},
                            status=status.HTTP_400_BAD_REQUEST)
        log_event(request, "booking_draft_completed", {"reference": booking.reference})
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"], url_path="skip-assignment")
    def skip_assignment(self, request, pk=None):
        """Advance the booking past the assignment stage without assigning anyone.

        Gated by the opt-in `bookings.skip_assignment` capability (off by default
        for every role; super admin always holds it). Only valid while the
        booking is Confirmed — it moves CONFIRMED → ASSIGNED with no worker set.
        """
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.skip_assignment"):
            return Response({"detail": access.denial_message("bookings", "skip_assignment")},
                            status=status.HTTP_403_FORBIDDEN)
        if booking.status != BookingStatus.CONFIRMED:
            return Response(
                {"detail": "Assignment can only be skipped once the booking is Confirmed."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        booking_services.transition_booking(
            booking, BookingStatus.ASSIGNED, actor=request.user,
            note="Assignment skipped (no worker assigned)", request=request,
        )
        log_event(request, "booking_assignment_skipped", {"reference": booking.reference})
        return Response(self.get_serializer(booking).data)

    @action(detail=True, methods=["post"], url_path="generate-recurrences")
    def generate_recurrences(self, request, pk=None):
        booking = self.get_object()
        if not request.user.has_perm_code("bookings.add"):
            return Response({"detail": "You don't have permission to create bookings."},
                            status=status.HTTP_403_FORBIDDEN)
        ser = RecurrenceSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        children = booking_services.generate_recurrences(
            booking, ser.validated_data["occurrences"]
        )
        if not children:
            return Response(
                {"detail": "Booking has no recurrence rule, or occurrences was 0."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        log_event(request, "booking_recurrences_generated",
                  {"reference": booking.reference, "count": len(children)})
        return Response(
            BookingSerializer(children, many=True, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class BookingPolicyViewSet(viewsets.ModelViewSet):
    """When bookings may be made and cancelled - organization default plus any
    per-club override. Reads are open to signed-in staff (the booking form needs
    the window); changes require `settings.manage`."""

    queryset = BookingPolicy.objects.select_related("club", "facility").all()
    serializer_class = BookingPolicySerializer
    filterset_fields = ["club", "facility", "is_default"]
    ordering_fields = ["is_default", "club"]

    def get_permissions(self):
        from apps.settings_app.permissions import BookingConfigPermission
        return [permissions.IsAuthenticated(), BookingConfigPermission()]

    def get_queryset(self):
        # Make sure the organization default exists before listing, so the
        # settings page always has a row to edit on a fresh install.
        booking_services.resolve_policy()
        qs = super().get_queryset()
        club_ids = self.request.user.scoped_club_ids()
        if club_ids is not None:
            # A facility row is in scope through the club that owns it.
            qs = qs.filter(Q(club_id__in=club_ids)
                           | Q(facility__club_id__in=club_ids)
                           | Q(is_default=True))
        return qs

    def perform_destroy(self, instance):
        if instance.is_default:
            raise _Conflict("The organization default policy cannot be deleted.")
        instance.delete()

    @action(detail=False, methods=["get"])
    def effective(self, request):
        """The multi-slot rules in force for a club or facility.

        Answerable without a policy row existing at that level, which is the
        normal case: most facilities inherit everything. The settings screen
        asks this to show what a field would do if left empty.
        """
        from apps.clubs.models import Club
        from apps.facilities.models import Facility

        club = facility = None
        facility_id = request.query_params.get("facility")
        club_id = request.query_params.get("club")
        if facility_id:
            facility = Facility.objects.filter(pk=facility_id).select_related("club").first()
            if facility is None:
                return Response({"detail": "Facility not found."},
                                status=status.HTTP_404_NOT_FOUND)
            club = facility.club
        elif club_id:
            club = Club.objects.filter(pk=club_id).first()
            if club is None:
                return Response({"detail": "Club not found."},
                                status=status.HTTP_404_NOT_FOUND)

        # Scope check: a manager restricted to some clubs may not read another's.
        club_ids = request.user.scoped_club_ids()
        if club_ids is not None and club is not None and club.id not in club_ids:
            return Response({"detail": "You don't have access to that club."},
                            status=status.HTTP_403_FORBIDDEN)

        rules = booking_services.resolve_slot_rules(club=club, facility=facility)
        if facility is not None:
            own = BookingPolicy.objects.filter(facility=facility).first()
        elif club is not None:
            own = BookingPolicy.objects.filter(club=club).first()
        else:
            # At the organization scope the row that applies is its own, and it
            # is created on first access, so this scope always has one.
            own = booking_services.resolve_policy()
        return Response({
            "rules": rules,
            "has_own_policy": own is not None,
            "policy": BookingPolicySerializer(own).data if own else None,
            "overrides": self._override_count(request, club=club, facility=facility),
        })

    def _overrides_below(self, request, club=None, facility=None):
        """Rows under a scope that state a multi-slot rule of their own.

        These are what stops a change made here from reaching everything below
        it, so the settings screen has to be able to name them and clear them.
        """
        if facility is not None:
            return BookingPolicy.objects.none()   # nothing is more specific

        stated = Q()
        for field in booking_services.MULTI_SLOT_FIELDS:
            stated |= Q(**{f"{field}__isnull": False})

        qs = BookingPolicy.objects.filter(stated).exclude(is_default=True)
        if club is not None:
            qs = qs.filter(facility__club=club)
        else:
            club_ids = request.user.scoped_club_ids()
            if club_ids is not None:
                qs = qs.filter(Q(club_id__in=club_ids) | Q(facility__club_id__in=club_ids))
        return qs.select_related("club", "facility")

    def _override_count(self, request, club=None, facility=None):
        rows = self._overrides_below(request, club=club, facility=facility)
        return {
            "clubs": rows.filter(club__isnull=False).count(),
            "facilities": rows.filter(facility__isnull=False).count(),
        }

    @action(detail=False, methods=["post"], url_path="clear-overrides")
    def clear_overrides(self, request):
        """Make everything below a scope follow it again.

        Only the multi-slot fields are cleared. A club that also sets its own
        lead time or cancellation window keeps it: the operator asked for one
        set of slot rules to apply, not for the row to be thrown away.
        """
        from apps.clubs.models import Club

        club = None
        club_id = request.data.get("club")
        if club_id:
            club = Club.objects.filter(pk=club_id).first()
            if club is None:
                return Response({"detail": "Club not found."},
                                status=status.HTTP_404_NOT_FOUND)

        club_ids = request.user.scoped_club_ids()
        if club_ids is not None and club is not None and club.id not in club_ids:
            return Response({"detail": "You don't have access to that club."},
                            status=status.HTTP_403_FORBIDDEN)

        rows = self._overrides_below(request, club=club)
        affected = [row.scope_label for row in rows]
        cleared = rows.update(**{f: None for f in booking_services.MULTI_SLOT_FIELDS})
        if cleared:
            log_event(
                request,
                "booking_policy_slot_overrides_cleared",
                {"scope": club.name if club else "Organization default",
                 "cleared": cleared, "affected": affected},
            )
        return Response({"cleared": cleared, "affected": affected})


class BookingHoldViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin,
                         viewsets.GenericViewSet):
    """Reservations, for the people who have to explain them.

    A reservation leaves no booking row, so until now a held court was visible
    to staff only as a slot they could not book. When a customer rings to say
    their checkout is stuck, or a court looks unavailable for no apparent
    reason, this is the screen that answers it, and the one place a stuck
    reservation can be let go without waiting out its clock.

    Read-only apart from `release`. Nothing here creates or extends a
    reservation: those belong to the checkout that owns the deadline.
    """

    serializer_class = BookingHoldSerializer
    queryset = (
        BookingHold.objects
        .select_related("club", "facility_type", "customer", "created_by",
                        "booking", "order")
        .prefetch_related("slots__facility")
        .all()
    )
    filterset_fields = ["status", "club", "facility_type", "source"]
    search_fields = ["reference", "customer__full_name", "club__name"]
    ordering_fields = ["created_at", "expires_at", "status"]
    ordering = ["-created_at"]

    def get_permissions(self):
        return [permissions.IsAuthenticated(), BookingHoldPermission()]

    def get_queryset(self):
        qs = super().get_queryset()

        # Club scoping, exactly as `BookingViewSet` does it. A reservation names
        # a customer and the courts they are holding, so a manager limited to
        # one club must not read another club's. `club` is non-null on a hold,
        # so there is no club-less case to admit.
        #
        # This also gates `release`, which resolves through this queryset: a
        # manager cannot give away a court at a club they do not run.
        club_ids = self.request.user.scoped_club_ids()
        if club_ids is not None:
            qs = qs.filter(club_id__in=club_ids)

        # `?live=true` asks the CLOCK, not the status: between sweeps the table
        # holds rows still marked active that have already run out, and a
        # listing that showed those would have staff chasing courts that are
        # back on sale.
        live = str(self.request.query_params.get("live") or "").lower()
        if live in ("1", "true", "yes"):
            qs = qs.filter(status=HoldStatus.ACTIVE,
                           expires_at__gt=timezone.now())
        elif live in ("0", "false", "no"):
            qs = qs.exclude(status=HoldStatus.ACTIVE,
                            expires_at__gt=timezone.now())
        return qs

    @action(detail=True, methods=["post"])
    def release(self, request, pk=None):
        """Give the courts back now instead of at the deadline.

        The reason this screen exists. Idempotent, because a reservation that
        has already ended is already released and saying so twice is not an
        error.
        """
        from apps.bookings import reservations

        hold = self.get_object()
        if not request.user.has_perm_code("bookings.edit"):
            return Response({"detail": access.denial_message("bookings", "edit")},
                            status=status.HTTP_403_FORBIDDEN)
        if hold.status != HoldStatus.ACTIVE:
            return Response(self.get_serializer(hold).data)

        reservations.release(hold)
        hold.refresh_from_db()
        log_event(request, "reservation_released", {"reference": hold.reference})
        return Response(self.get_serializer(hold).data)


class BookingOrderViewSet(mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    """One multi-slot checkout, as a single record.

    Retrieve-only, and deliberately so. An order owns no money and no status of
    its own: everything about it is summed or read from its bookings, and the
    way to change any of it is to act on the slot it belongs to. There is
    nothing here to list either, because an order is reached from a booking
    rather than browsed.
    """

    serializer_class = BookingOrderSerializer
    queryset = (
        BookingOrder.objects
        .select_related("customer", "club", "facility_type", "created_by")
        .prefetch_related("bookings", "bookings__facility", "bookings__assigned_to")
        .all()
    )

    def get_permissions(self):
        return [permissions.IsAuthenticated()]

    def get_queryset(self):
        qs = super().get_queryset()
        user = self.request.user
        if not user.has_perm_code("bookings.view"):
            return qs.none()
        # The same club boundary the bookings themselves obey. An order names a
        # customer and everything they booked, so a manager at one club must
        # not read another club's.
        club_ids = user.scoped_club_ids()
        if club_ids is not None:
            qs = qs.filter(club_id__in=club_ids)
        return qs
