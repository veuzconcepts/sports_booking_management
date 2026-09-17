"""Payment endpoints: payments, refunds, wallets, memberships, invoices."""

from django.http import FileResponse
from rest_framework import mixins, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.auditlogs.services import log_event
from config.listing import GroupedListMixin

from apps.accounts import access
from apps.accounts.models import Role, STAFF_ROLES
from apps.bookings.models import Booking
from apps.customers.models import Customer
from apps.settings_app.currency import (
    min_accountable_unit,
    round_money,
    validate_currency_precision,
)
from django.core.exceptions import ValidationError as DjangoValidationError

from . import services as pay_services
from .filters import PaymentFilter
from .models import (
    CreditNote,
    Invoice,
    InvoiceStatus,
    Membership,
    MembershipPlan,
    Payment,
    PaymentStatus,
    Receipt,
    Wallet,
)
from .permissions import (
    InvoicePermission, MembershipPlanPermission, PaymentPermission,
    SubscriptionReadPermission,
)
from .pdf import render_invoice_pdf
from .serializers import (
    CancelInvoiceSerializer,
    ChargeSerializer,
    CreditNoteSerializer,
    InvoiceSerializer,
    AdjustUsageSerializer,
    ActivateMembershipSerializer,
    ExtendMembershipSerializer,
    IssueMembershipSerializer,
    MembershipReasonSerializer,
    MembershipUsageSerializer,
    RenewMembershipSerializer,
    MembershipPlanSerializer,
    MembershipSerializer,
    PaymentSerializer,
    ReceiptSerializer,
    RefundRejectSerializer,
    RefundRequestSerializer,
    TopUpSerializer,
    WalletSerializer,
)

def _subject_activity(view, subject_type, subject_id):
    """Paginated audit timeline for one entity (its subject-tagged events),
    newest first. Mirrors the staff per-employee activity log."""
    from apps.auditlogs.models import AuditLog
    from apps.auditlogs.serializers import AuditLogSerializer

    qs = (AuditLog.objects
          .filter(subject_type=subject_type, subject_id=str(subject_id))
          .select_related("actor").order_by("-created_at"))
    page = view.paginate_queryset(qs)
    data = AuditLogSerializer(page if page is not None else qs, many=True).data
    return view.get_paginated_response(data) if page is not None else Response(data)


def _customer_scope(qs, user):
    """Restrict a queryset to the requesting customer's own rows."""
    if user.role in STAFF_ROLES:
        return qs
    return qs.filter(customer__linked_user=user)


def _club_scope(qs, user):
    """Limit booking-linked finance rows to a club-restricted user's assigned
    clubs (plus club-less mobile jobs). Driven by the user's `assigned_clubs`,
    not by role name: super/admin (unrestricted -> `scoped_club_ids()` is None) and
    customers (already scoped to their own rows upstream) are unaffected."""
    from django.db.models import Q
    if user.role not in STAFF_ROLES:
        return qs
    club_ids = user.scoped_club_ids()
    if club_ids is None:
        return qs
    return qs.filter(Q(booking__club_id__in=club_ids) | Q(booking__club__isnull=True))


def _booking_in_scope(booking, user) -> bool:
    """Whether a staff user may act on this booking (charge / invoice). Mirrors the
    booking club scoping: club-restricted users are limited to their clubs (plus
    club-less mobile jobs); super/admin are unrestricted; non-staff never pass."""
    if user.role not in STAFF_ROLES:
        return False
    club_ids = user.scoped_club_ids()
    if club_ids is None:
        return True
    return booking.club_id is None or booking.club_id in club_ids


class PaymentViewSet(GroupedListMixin, mixins.DestroyModelMixin,
                     viewsets.ReadOnlyModelViewSet):
    """Payments are created via `charge`, not direct POST. Deletion is allowed only
    with the opt-in `payments.delete` capability and never for settled/refunded rows."""

    queryset = (
        Payment.objects
        .select_related("customer", "customer__linked_user", "booking")
        .prefetch_related("refunds")
        .all()
    )
    serializer_class = PaymentSerializer
    permission_classes = [permissions.IsAuthenticated, PaymentPermission]
    filterset_class = PaymentFilter
    search_fields = ["reference", "customer__email", "customer__full_name",
                     "booking__reference"]
    ordering_fields = ["created_at", "amount", "status", "method", "reference"]
    group_by_fields = {
        "status": {"field": "status"},
        "method": {"field": "method"},
        "customer": {"field": "customer_id", "label": "customer__full_name",
                     "filter_param": "customer", "empty_label": "No customer"},
    }

    def get_queryset(self):
        qs = _club_scope(_customer_scope(super().get_queryset(), self.request.user), self.request.user)
        user = self.request.user
        # Staff: without payments.view_all see only transactions they took.
        if user.role in STAFF_ROLES and not access.can_view_all(user, "payments"):
            qs = qs.filter(created_by=user)
        return qs

    def destroy(self, request, *args, **kwargs):
        """Delete a payment — opt-in `payments.delete` only. Blocked when the row
        is tied to an invoice or has refunds (those must be reversed, not erased)."""
        if not request.user.has_perm_code("payments.delete"):
            return Response({"detail": "You don't have permission to delete payments."},
                            status=status.HTTP_403_FORBIDDEN)
        payment = self.get_object()
        if getattr(payment, "invoice", None) is not None:
            return Response({"detail": "This payment is linked to an invoice - credit/cancel the invoice instead."},
                            status=status.HTTP_400_BAD_REQUEST)
        if payment.refunds.exists():
            return Response({"detail": "This payment has refunds and cannot be deleted."},
                            status=status.HTTP_400_BAD_REQUEST)
        ref = payment.reference
        payment.delete()
        log_event(request, "payment_deleted", {"payment": ref})
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["post"])
    def charge(self, request):
        """Take a payment. Requires the `payments.add` capability."""
        if not request.user.has_perm_code("payments.add"):
            return Response({"detail": "You do not have permission to take payments."},
                            status=status.HTTP_403_FORBIDDEN)
        ser = ChargeSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data

        booking = None
        if data.get("booking"):
            try:
                booking = Booking.objects.select_related("customer").get(pk=data["booking"])
            except Booking.DoesNotExist:
                return Response({"detail": "Booking not found."},
                                status=status.HTTP_404_NOT_FOUND)
            if not _booking_in_scope(booking, request.user):
                return Response({"detail": "Booking not found."},
                                status=status.HTTP_404_NOT_FOUND)
            customer = booking.customer
            amount = data.get("amount") or booking.total_amount
        else:
            return Response({"detail": "A booking is required to charge."},
                            status=status.HTTP_400_BAD_REQUEST)

        cur = booking.currency
        if data.get("amount") is not None:
            try:
                validate_currency_precision(data["amount"], cur, "standard")
            except DjangoValidationError as exc:
                return Response({"detail": exc.messages[0]}, status=status.HTTP_400_BAD_REQUEST)
        if round_money(amount, cur) < min_accountable_unit(cur):
            return Response({"detail": f"Amount must be at least {min_accountable_unit(cur)} {cur}."},
                            status=status.HTTP_400_BAD_REQUEST)

        payment = pay_services.charge(
            customer, amount, data["method"], booking=booking, request=request,
        )
        code = (status.HTTP_201_CREATED if payment.status == "paid"
                else status.HTTP_402_PAYMENT_REQUIRED)
        return Response(PaymentSerializer(payment, context={"request": request}).data, status=code)

    # NOTE: the direct payment refund was retired. Refunds are issued from the
    # Invoice (request-refund -> credit note), which returns the money on the
    # originating payment automatically. See InvoiceViewSet.request_refund.

    @action(detail=True, methods=["post"], url_path="generate-invoice")
    def generate_invoice(self, request, pk=None):
        if not request.user.has_perm_code("invoicing.add"):
            return Response({"detail": "You don't have permission to manage invoices."},
                            status=status.HTTP_403_FORBIDDEN)
        payment = self.get_object()
        # Idempotent: reuse this payment's live invoice, or the booking's, if one
        # already exists (avoids duplicates / a OneToOne clash on the payment).
        dead = [InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED]
        existing = getattr(payment, "invoice", None)
        if (existing is None or existing.status in dead) and payment.booking_id:
            existing = (Invoice.objects.filter(booking=payment.booking)
                        .exclude(status__in=dead)
                        .order_by("-issued_at").first())
        if existing and existing.status not in dead:
            return Response(InvoiceSerializer(existing, context={"request": request}).data,
                            status=status.HTTP_200_OK)
        try:
            invoice = pay_services.create_invoice(
                customer=payment.customer, booking=payment.booking,
                payment=payment, request=request,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(InvoiceSerializer(invoice, context={"request": request}).data,
                        status=status.HTTP_201_CREATED)


class WalletViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Wallet.objects.select_related("customer", "customer__linked_user").prefetch_related("transactions").all()
    serializer_class = WalletSerializer
    permission_classes = [permissions.IsAuthenticated, PaymentPermission]
    filterset_fields = ["customer"]

    def get_queryset(self):
        return _customer_scope(super().get_queryset(), self.request.user)

    @action(detail=False, methods=["get"], url_path="me")
    def me(self, request):
        if request.user.role != Role.CUSTOMER:
            return Response({"detail": "Customers only."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            customer = request.user.customer_profile
        except Customer.DoesNotExist:
            return Response({"detail": "No customer profile."}, status=status.HTTP_404_NOT_FOUND)
        wallet = pay_services.get_or_create_wallet(customer)
        return Response(WalletSerializer(wallet, context={"request": request}).data)

    @action(detail=False, methods=["post"], url_path="top-up")
    def top_up(self, request):
        if not request.user.has_perm_code("payments.add"):
            return Response({"detail": "You do not have permission to top up wallets."},
                            status=status.HTTP_403_FORBIDDEN)
        ser = TopUpSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            customer = Customer.objects.get(pk=ser.validated_data["customer"])
        except Customer.DoesNotExist:
            return Response({"detail": "Customer not found."}, status=status.HTTP_404_NOT_FOUND)
        cur = pay_services.get_or_create_wallet(customer).currency
        try:
            validate_currency_precision(ser.validated_data["amount"], cur, "standard")
        except DjangoValidationError as exc:
            return Response({"detail": exc.messages[0]}, status=status.HTTP_400_BAD_REQUEST)
        if round_money(ser.validated_data["amount"], cur) < min_accountable_unit(cur):
            return Response({"detail": f"Amount must be at least {min_accountable_unit(cur)} {cur}."},
                            status=status.HTTP_400_BAD_REQUEST)
        txn = pay_services.topup_wallet(
            customer, ser.validated_data["amount"], request=request,
            note=ser.validated_data.get("note", "Wallet top-up"),
        )
        return Response(WalletSerializer(txn.wallet, context={"request": request}).data,
                        status=status.HTTP_201_CREATED)


class MembershipPlanViewSet(viewsets.ModelViewSet):
    queryset = MembershipPlan.objects.prefetch_related(
        "entitlements__facility_type__price", "entitlements__facility_category",
        "entitlements__addon", "available_clubs").all()
    serializer_class = MembershipPlanSerializer
    permission_classes = [permissions.IsAuthenticated, MembershipPlanPermission]
    filterset_fields = ["interval", "is_active", "is_group"]
    search_fields = ["name", "code", "description"]
    ordering_fields = ["price", "name"]

    def get_permissions(self):
        # value-preview is a pure read-only calculation (no writes); any
        # authenticated user who can open the plan form may use it.
        if getattr(self, "action", None) == "value_preview":
            return [permissions.IsAuthenticated()]
        return super().get_permissions()

    @action(detail=False, methods=["post"], url_path="value-preview")
    def value_preview(self, request):
        """Included value + savings for a DRAFT plan (unsaved entitlements), so the
        create/edit form shows live figures. Reuses the same valuation as the saved
        plan's `value_breakdown` field — no duplicate logic, no data written."""
        from apps.facilities.models import AddOn, FacilityCategory, FacilityType
        from .valuation import plan_value_breakdown

        def _obj(model, pk):
            return model.objects.filter(pk=pk).first() if pk else None

        rows = []
        for e in (request.data.get("entitlements") or []):
            rows.append({
                "target_type": e.get("target_type"),
                "facility_type": _obj(FacilityType, e.get("facility_type")),
                "facility_category": _obj(FacilityCategory, e.get("facility_category")),
                "addon": _obj(AddOn, e.get("addon")),
                "limit_type": e.get("limit_type"),
                "quantity": e.get("quantity"),
                "period": e.get("period"),
            })
        return Response(plan_value_breakdown(rows, request.data.get("price") or 0))

    def perform_create(self, serializer):
        plan = serializer.save()
        log_event(self.request, "membership_plan_created",
                  {"plan": plan.name, "code": plan.code,
                   "entitlements": plan.entitlements.count()}, status_code=201,
                  subject=("membership_plan", plan.id))

    def perform_update(self, serializer):
        plan = serializer.save()
        log_event(self.request, "membership_plan_updated",
                  {"plan": plan.name, "code": plan.code,
                   "entitlements": plan.entitlements.count()},
                  subject=("membership_plan", plan.id))

    @action(detail=True, methods=["get"], url_path="activity")
    def activity(self, request, pk=None):
        """Plan change timeline — audit entries whose subject is this plan."""
        plan = self.get_object()
        return _subject_activity(self, "membership_plan", plan.id)


class MembershipViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = (
        Membership.objects
        .select_related("customer", "customer__linked_user", "plan", "club")
        .prefetch_related("plan__entitlements", "balances", "invoices")
        .all()
    )
    serializer_class = MembershipSerializer
    permission_classes = [permissions.IsAuthenticated, SubscriptionReadPermission]
    filterset_fields = ["status", "customer", "plan", "club", "auto_renew"]
    ordering_fields = ["start_date", "end_date"]

    def get_queryset(self):
        return _customer_scope(super().get_queryset(), self.request.user)

    @action(detail=False, methods=["post"])
    def issue(self, request):
        if not request.user.has_perm_code("subscriptions.assign"):
            return Response({"detail": access.denial_message("subscriptions", "assign")},
                            status=status.HTTP_403_FORBIDDEN)
        ser = IssueMembershipSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            customer = Customer.objects.get(pk=ser.validated_data["customer"])
            plan = MembershipPlan.objects.get(pk=ser.validated_data["plan"])
        except (Customer.DoesNotExist, MembershipPlan.DoesNotExist):
            return Response({"detail": "Customer or plan not found."},
                            status=status.HTTP_404_NOT_FOUND)
        try:
            membership = pay_services.issue_membership(
                customer, plan, club_id=ser.validated_data.get("club"),
                method=ser.validated_data.get("method"),
                promo_code=(ser.validated_data.get("promo_code") or "").strip() or None,
                auto_renew=ser.validated_data.get("auto_renew", True), request=request,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(MembershipSerializer(membership, context={"request": request}).data,
                        status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def activate(self, request, pk=None):
        """Confirm a membership the customer requested from the app (draft →
        active): starts the term today and raises the purchase invoice."""
        if not request.user.has_perm_code("subscriptions.assign"):
            return Response({"detail": access.denial_message("subscriptions", "assign")},
                            status=status.HTTP_403_FORBIDDEN)
        payload = ActivateMembershipSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        return self._run(request, pay_services.activate_membership,
                         method=payload.validated_data.get("method"),
                         promo_code=(payload.validated_data.get("promo_code") or "").strip() or None)

    @action(detail=True, methods=["post"])
    def renew(self, request, pk=None):
        if not request.user.has_perm_code("subscriptions.edit"):
            return Response({"detail": access.denial_message("subscriptions", "edit")},
                            status=status.HTTP_403_FORBIDDEN)
        membership = self.get_object()
        payload = RenewMembershipSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        try:
            membership = pay_services.renew_membership(
                membership, method=payload.validated_data.get("method"),
                promo_code=(payload.validated_data.get("promo_code") or "").strip() or None,
                confirm_early=payload.validated_data.get("confirm_early", False),
                request=request)
        except pay_services.EarlyRenewalError as exc:
            # Distinguishable so the client can offer a "renew anyway" confirmation.
            return Response({"detail": str(exc), "code": exc.code},
                            status=status.HTTP_400_BAD_REQUEST)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(MembershipSerializer(membership, context={"request": request}).data)

    # --- Lifecycle ------------------------------------------------------- #
    def list(self, request, *args, **kwargs):
        pay_services.expire_due_memberships()   # keep statuses current (lazy)
        return super().list(request, *args, **kwargs)

    def _gate(self, request, cap):
        if not request.user.has_perm_code(f"subscriptions.{cap}"):
            return Response({"detail": access.denial_message("subscriptions", cap)},
                            status=status.HTTP_403_FORBIDDEN)
        return None

    def _result(self, membership, request):
        return Response(MembershipSerializer(membership, context={"request": request}).data)

    def _run(self, request, fn, **kwargs):
        try:
            return self._result(fn(self.get_object(), request=request, **kwargs), request)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=["post"])
    def suspend(self, request, pk=None):
        denied = self._gate(request, "suspend")
        if denied:
            return denied
        payload = MembershipReasonSerializer(data=request.data); payload.is_valid(raise_exception=True)
        return self._run(request, pay_services.suspend_membership,
                         reason=payload.validated_data.get("reason", ""))

    @action(detail=True, methods=["post"])
    def resume(self, request, pk=None):
        denied = self._gate(request, "suspend")
        if denied:
            return denied
        return self._run(request, pay_services.resume_membership)

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        denied = self._gate(request, "cancel")
        if denied:
            return denied
        payload = MembershipReasonSerializer(data=request.data); payload.is_valid(raise_exception=True)
        return self._run(request, pay_services.cancel_membership,
                         reason=payload.validated_data.get("reason", ""))

    @action(detail=True, methods=["post"])
    def extend(self, request, pk=None):
        denied = self._gate(request, "edit")
        if denied:
            return denied
        payload = ExtendMembershipSerializer(data=request.data); payload.is_valid(raise_exception=True)
        return self._run(request, pay_services.extend_membership,
                         days=payload.validated_data.get("days"),
                         end_date=payload.validated_data.get("end_date"))

    @action(detail=True, methods=["post"], url_path="adjust-usage")
    def adjust_usage(self, request, pk=None):
        denied = self._gate(request, "usage_adjust")
        if denied:
            return denied
        payload = AdjustUsageSerializer(data=request.data); payload.is_valid(raise_exception=True)
        membership = self.get_object()
        from .models import PlanEntitlement
        ent = PlanEntitlement.objects.filter(
            pk=payload.validated_data["entitlement"], plan_id=membership.plan_id).first()
        if not ent:
            return Response({"detail": "Entitlement not found for this plan."},
                            status=status.HTTP_404_NOT_FOUND)
        try:
            pay_services.adjust_usage(
                membership, ent, payload.validated_data["units"],
                grant=payload.validated_data.get("grant", False),
                # Blank → let the facility_category resolve the entitlement's period bucket.
                period_key=(payload.validated_data.get("period_key") or None),
                note=payload.validated_data.get("note", ""), request=request)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return self._result(membership, request)

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        """Stream the membership card PDF (built on demand)."""
        from io import BytesIO
        from .pdf import build_membership_bytes
        m = self.get_object()
        return FileResponse(BytesIO(build_membership_bytes(m)), as_attachment=True,
                            filename=f"{m.number or m.id}.pdf", content_type="application/pdf")

    @action(detail=True, methods=["get"])
    def usage(self, request, pk=None):
        """Usage ledger (history) for one membership — paginated."""
        membership = self.get_object()
        qs = membership.usage.select_related("created_by", "booking").all()
        page = self.paginate_queryset(qs)
        ser = MembershipUsageSerializer(page if page is not None else qs, many=True,
                                        context={"request": request})
        return self.get_paginated_response(ser.data) if page is not None else Response(ser.data)

    @action(detail=True, methods=["get"])
    def activity(self, request, pk=None):
        """Lifecycle timeline for one membership — the subject-tagged audit events
        (issued / renewed / suspended / resumed / cancelled / extended / expired /
        usage adjusted), newest first. Gated by subscriptions.view via the viewset."""
        membership = self.get_object()
        return _subject_activity(self, "membership", membership.id)


class InvoiceViewSet(GroupedListMixin, viewsets.ReadOnlyModelViewSet):
    queryset = (
        Invoice.objects
        .select_related("customer", "customer__linked_user", "payment", "booking")
        .all()
    )
    serializer_class = InvoiceSerializer
    permission_classes = [permissions.IsAuthenticated, InvoicePermission]
    filterset_fields = ["customer", "booking", "status"]
    search_fields = ["number", "customer__email", "customer__full_name",
                     "booking__reference", "bill_to"]
    group_by_fields = {
        "status": {"field": "status"},
        "customer": {"field": "customer_id", "label": "customer__full_name",
                     "filter_param": "customer", "empty_label": "No customer"},
    }
    ordering_fields = ["issued_at", "total"]

    def get_queryset(self):
        return _club_scope(_customer_scope(super().get_queryset(), self.request.user), self.request.user)

    def _ok(self, invoice):
        return Response(InvoiceSerializer(invoice, context={"request": self.request}).data)

    @action(detail=False, methods=["post"])
    def generate(self, request):
        """Generate an invoice from a booking (reuses its rule-adjusted total)."""
        if not request.user.has_perm_code("invoicing.add"):
            return Response({"detail": "You don't have permission to manage invoices."},
                            status=status.HTTP_403_FORBIDDEN)
        booking = Booking.objects.select_related("customer").filter(pk=request.data.get("booking")).first()
        if not booking or not _booking_in_scope(booking, request.user):
            return Response({"detail": "Booking not found."}, status=status.HTTP_404_NOT_FOUND)
        # Walk-in (B2C) bookings are invoiceable too — the invoice carries a bill-to
        # snapshot from the walk-in details (or "Walk-in customer").
        # Idempotent: if the booking already has a live invoice, return it instead
        # of issuing a duplicate. A fresh invoice is only created when none exists
        # or every prior one was cancelled/fully credited (a deliberate reissue).
        existing = (Invoice.objects.filter(booking=booking)
                    .exclude(status__in=[InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED])
                    .order_by("-issued_at").first())
        if existing:
            return Response(InvoiceSerializer(existing, context={"request": request}).data,
                            status=status.HTTP_200_OK)
        # Link a paid, not-yet-invoiced payment when one exists (marks it Paid).
        payment = Payment.objects.filter(
            booking=booking, status=PaymentStatus.PAID, invoice__isnull=True).first()
        try:
            invoice = pay_services.create_invoice(
                customer=booking.customer, booking=booking, payment=payment, request=request)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(InvoiceSerializer(invoice, context={"request": request}).data,
                        status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        """Cancel an UNPAID invoice issued in error (requires invoicing.cancel_invoice,
        an opt-in capability). Paid invoices must be reversed with a credit note. Audited."""
        if not request.user.has_perm_code("invoicing.cancel_invoice"):
            return Response({"detail": "You don't have permission to cancel invoices."},
                            status=status.HTTP_403_FORBIDDEN)
        invoice = self.get_object()
        payload = CancelInvoiceSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        try:
            pay_services.cancel_invoice(
                invoice, payload.validated_data.get("reason", ""), request=request)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return self._ok(invoice)

    @action(detail=True, methods=["post"], url_path="request-refund")
    def request_refund(self, request, pk=None):
        """Request a refund against a PAID invoice. Creates a credit note (the
        official refund document); if org approval is required it is left pending,
        otherwise the money is returned immediately. Requires invoicing.credit."""
        if not request.user.has_perm_code("invoicing.credit"):
            return Response({"detail": access.denial_message("invoicing", "credit")},
                            status=status.HTTP_403_FORBIDDEN)
        invoice = self.get_object()
        payload = RefundRequestSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        amount = payload.validated_data.get("amount")
        if amount is not None:
            try:
                validate_currency_precision(amount, invoice.currency, "standard")
            except DjangoValidationError as exc:
                return Response({"detail": exc.messages[0]}, status=status.HTTP_400_BAD_REQUEST)
        try:
            credit_note = pay_services.request_refund(
                invoice, amount=amount,
                reason=payload.validated_data.get("reason", ""),
                method=payload.validated_data.get("method"),
                request=request,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(CreditNoteSerializer(credit_note, context={"request": request}).data,
                        status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        """Stream the invoice PDF, rendering it on first access if needed."""
        invoice = self.get_object()
        if not invoice.pdf:
            render_invoice_pdf(invoice)
            invoice.refresh_from_db()
        return FileResponse(
            invoice.pdf.open("rb"), as_attachment=True,
            filename=f"{invoice.number}.pdf", content_type="application/pdf",
        )


def _doc_club_scope(qs, user):
    """Club-scope receipts/credit notes via their invoice's booking club."""
    from django.db.models import Q
    if user.role not in STAFF_ROLES:
        return qs
    club_ids = user.scoped_club_ids()
    if club_ids is None:
        return qs
    return qs.filter(Q(invoice__booking__club_id__in=club_ids)
                     | Q(invoice__booking__club__isnull=True))


class ReceiptViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = (Receipt.objects
                .select_related("customer", "customer__linked_user", "invoice", "payment")
                .all())
    serializer_class = ReceiptSerializer
    permission_classes = [permissions.IsAuthenticated, InvoicePermission]
    filterset_fields = ["customer", "invoice"]
    search_fields = ["number", "invoice__number", "customer__email"]
    ordering_fields = ["issued_at", "amount"]

    def get_queryset(self):
        return _doc_club_scope(_customer_scope(super().get_queryset(), self.request.user),
                                 self.request.user)

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        """Stream the receipt PDF, rendering it on first access if needed."""
        from .pdf import render_receipt_pdf
        receipt = self.get_object()
        if not receipt.pdf:
            render_receipt_pdf(receipt)
            receipt.refresh_from_db()
        return FileResponse(
            receipt.pdf.open("rb"), as_attachment=True,
            filename=f"{receipt.number}.pdf", content_type="application/pdf",
        )


class CreditNoteViewSet(GroupedListMixin, viewsets.ReadOnlyModelViewSet):
    queryset = (CreditNote.objects
                .select_related("customer", "customer__linked_user", "invoice", "refund")
                .all())
    serializer_class = CreditNoteSerializer
    permission_classes = [permissions.IsAuthenticated, InvoicePermission]
    filterset_fields = ["customer", "invoice", "status"]
    search_fields = ["number", "invoice__number", "customer__email",
                     "customer__full_name"]
    ordering_fields = ["requested_at", "issued_at", "total", "status"]
    group_by_fields = {
        "status": {"field": "status"},
        "customer": {"field": "customer_id", "label": "customer__full_name",
                     "filter_param": "customer", "empty_label": "No customer"},
    }

    def get_queryset(self):
        return _doc_club_scope(_customer_scope(super().get_queryset(), self.request.user),
                                 self.request.user)

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        """Stream the credit-note PDF, rendering it on first access if needed."""
        from .pdf import render_credit_note_pdf
        credit_note = self.get_object()
        if not credit_note.pdf:
            render_credit_note_pdf(credit_note)
            credit_note.refresh_from_db()
        return FileResponse(
            credit_note.pdf.open("rb"), as_attachment=True,
            filename=f"{credit_note.number}.pdf", content_type="application/pdf",
        )

    @action(detail=True, methods=["post"], url_path="update-reason")
    def update_reason(self, request, pk=None):
        """Edit ONLY the reason note on a credit note — allowed even after it's issued
        (posted). The financial document itself is never changed. Requires
        invoicing.credit; audited."""
        if not request.user.has_perm_code("invoicing.credit"):
            return Response({"detail": access.denial_message("invoicing", "credit")},
                            status=status.HTTP_403_FORBIDDEN)
        credit_note = self.get_object()
        reason = (request.data.get("reason") or "").strip()[:255]
        prev = credit_note.reason
        credit_note.reason = reason
        credit_note.save(update_fields=["reason"])
        log_event(request, "credit_note_reason_updated",
                  {"credit_note": credit_note.number, "from": prev, "to": reason})
        return Response(CreditNoteSerializer(credit_note, context={"request": request}).data)

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        """Approve a pending refund and process it. Requires invoicing.credit_approve.
        An approver may approve a refund they raised themselves (for an accessible
        club) — holding the approval capability is sufficient."""
        if not request.user.has_perm_code("invoicing.credit_approve"):
            return Response({"detail": access.denial_message("invoicing", "credit_approve")},
                            status=status.HTTP_403_FORBIDDEN)
        credit_note = self.get_object()
        try:
            credit_note = pay_services.approve_refund(credit_note, request=request)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(CreditNoteSerializer(credit_note, context={"request": request}).data)

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        """Reject a pending refund (no money moves). Requires invoicing.credit_approve."""
        if not request.user.has_perm_code("invoicing.credit_approve"):
            return Response({"detail": access.denial_message("invoicing", "credit_approve")},
                            status=status.HTTP_403_FORBIDDEN)
        credit_note = self.get_object()
        payload = RefundRejectSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        try:
            credit_note = pay_services.reject_refund(
                credit_note, remarks=payload.validated_data.get("remarks", ""), request=request)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(CreditNoteSerializer(credit_note, context={"request": request}).data)
