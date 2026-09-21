"""Payment serializers — wallet, payments, refunds, memberships, invoices."""

from decimal import Decimal

from django.utils import timezone
from rest_framework import serializers
from apps.settings_app.media import public_file_url

from rest_framework.validators import UniqueValidator

from .models import (
    CreditNote,
    EntitlementLimit,
    EntitlementTarget,
    Invoice,
    Membership,
    MembershipBalance,
    MembershipPlan,
    MembershipUsage,
    PlanEntitlement,
    Payment,
    Receipt,
    Refund,
    Wallet,
    WalletTxn,
)


class WalletTxnSerializer(serializers.ModelSerializer):
    class Meta:
        model = WalletTxn
        fields = (
            "id", "wallet", "txn_type", "amount", "balance_after",
            "note", "related_payment", "created_at",
        )
        read_only_fields = fields


class WalletSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source="customer.full_name", read_only=True)
    transactions = WalletTxnSerializer(many=True, read_only=True)

    class Meta:
        model = Wallet
        fields = (
            "id", "customer", "customer_name", "currency", "balance",
            "transactions", "created_at", "updated_at",
        )
        read_only_fields = ("id", "balance", "created_at", "updated_at")


class RefundSerializer(serializers.ModelSerializer):
    payment_reference = serializers.CharField(source="payment.reference", read_only=True)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    credit_note_number = serializers.SerializerMethodField()
    credit_note_id = serializers.SerializerMethodField()

    class Meta:
        model = Refund
        fields = (
            "id", "reference", "payment", "payment_reference",
            "amount", "method", "reason", "status", "status_display",
            "credit_note_number", "credit_note_id", "created_by", "created_by_name", "created_at",
        )
        read_only_fields = fields

    def get_credit_note_number(self, obj) -> str | None:
        cn = getattr(obj, "credit_note", None)
        return cn.number if cn else None

    def get_credit_note_id(self, obj) -> int | None:
        cn = getattr(obj, "credit_note", None)
        return cn.id if cn else None


class PaymentSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source="customer.full_name", read_only=True, default=None)
    booking_reference = serializers.CharField(source="booking.reference", read_only=True, default=None)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    method_display = serializers.CharField(source="get_method_display", read_only=True)
    invoice_number = serializers.CharField(source="invoice.number", read_only=True, default=None)
    invoice_id = serializers.IntegerField(source="invoice.id", read_only=True, default=None)
    receipt_id = serializers.IntegerField(source="invoice.receipt.id", read_only=True, default=None)
    receipt_number = serializers.CharField(source="invoice.receipt.number", read_only=True, default=None)
    refunds = RefundSerializer(many=True, read_only=True)
    refundable_amount = serializers.DecimalField(max_digits=13, decimal_places=3, read_only=True)

    class Meta:
        model = Payment
        fields = (
            "id", "reference", "booking", "booking_reference",
            "invoice_id", "invoice_number", "receipt_id", "receipt_number",
            "customer", "customer_name",
            "method", "method_display", "status", "status_display", "currency",
            "amount", "refunded_amount", "refundable_amount",
            "gateway", "gateway_reference", "failure_reason",
            "refunds", "paid_at", "created_by", "created_by_name",
            "created_at", "updated_at",
        )
        read_only_fields = fields


class PlanEntitlementSerializer(serializers.ModelSerializer):
    facility_type_name = serializers.CharField(source="facility_type.name", read_only=True, default=None)
    facility_category_name = serializers.CharField(source="facility_category.name", read_only=True, default=None)
    addon_name = serializers.CharField(source="addon.name", read_only=True, default=None)

    class Meta:
        model = PlanEntitlement
        fields = (
            "id", "target_type",
            "facility_type", "facility_type_name", "facility_category", "facility_category_name",
            "addon", "addon_name", "limit_type", "quantity", "period",
        )
        read_only_fields = ("id",)

    def validate(self, attrs):
        target = attrs.get("target_type")
        picks = {
            EntitlementTarget.FACILITY_TYPE: attrs.get("facility_type"),
            EntitlementTarget.CATEGORY: attrs.get("facility_category"),
            EntitlementTarget.ADDON: attrs.get("addon"),
        }
        if not picks.get(target):
            raise serializers.ValidationError("Select the entitlement's target for its type.")
        if attrs.get("limit_type") == EntitlementLimit.LIMITED and not attrs.get("quantity"):
            raise serializers.ValidationError("A limited entitlement needs a usage count.")
        return attrs


class MembershipPlanSerializer(serializers.ModelSerializer):
    code = serializers.CharField(
        max_length=40, validators=[UniqueValidator(queryset=MembershipPlan.objects.all())])
    entitlements = PlanEntitlementSerializer(many=True, required=False)
    # Read-only, informational: the included value + savings against the price
    # (unlimited entitlements listed separately, excluded from the number).
    value_breakdown = serializers.SerializerMethodField()

    class Meta:
        model = MembershipPlan
        fields = (
            "id", "name", "code", "description", "interval",
            "validity_mode", "duration_days", "fixed_start", "fixed_end",
            "price", "available_clubs", "eligible_tiers",
            "is_group", "is_active", "entitlements", "value_breakdown",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "created_at", "updated_at")

    def get_value_breakdown(self, obj):
        from .valuation import plan_value_breakdown, rows_from_entitlements
        return plan_value_breakdown(rows_from_entitlements(obj.entitlements.all()), obj.price)

    def _set_entitlements(self, plan, rows):
        plan.entitlements.all().delete()
        for row in rows:
            PlanEntitlement.objects.create(plan=plan, **row)

    def create(self, validated):
        ents = validated.pop("entitlements", [])
        clubs = validated.pop("available_clubs", [])
        plan = MembershipPlan.objects.create(**validated)
        plan.available_clubs.set(clubs)
        self._set_entitlements(plan, ents)
        return plan

    def update(self, instance, validated):
        ents = validated.pop("entitlements", None)
        clubs = validated.pop("available_clubs", None)
        for k, v in validated.items():
            setattr(instance, k, v)
        instance.save()
        if clubs is not None:
            instance.available_clubs.set(clubs)
        if ents is not None:
            self._set_entitlements(instance, ents)
        return instance


class MembershipBalanceSerializer(serializers.ModelSerializer):
    class Meta:
        model = MembershipBalance
        fields = ("id", "entitlement", "period_key", "consumed", "reserved", "granted")
        read_only_fields = fields


class MembershipUsageSerializer(serializers.ModelSerializer):
    booking_reference = serializers.CharField(source="booking.reference", read_only=True, default=None)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)

    class Meta:
        model = MembershipUsage
        fields = (
            "id", "txn_type", "quantity", "booking", "booking_reference",
            "target_label", "period_key", "note", "created_by_name", "created_at",
        )
        read_only_fields = fields


class MembershipInvoiceSerializer(serializers.ModelSerializer):
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    purpose_display = serializers.CharField(source="get_purpose_display", read_only=True)

    class Meta:
        model = Invoice
        fields = ("id", "number", "total", "currency", "status", "status_display",
                  "purpose", "purpose_display", "issued_at")
        read_only_fields = fields


class MembershipSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source="customer.full_name", read_only=True)
    plan_name = serializers.CharField(source="plan.name", read_only=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    club_name = serializers.CharField(source="club.name", read_only=True, default=None)
    entitlements = PlanEntitlementSerializer(source="plan.entitlements", many=True, read_only=True)
    balances = MembershipBalanceSerializer(many=True, read_only=True)
    invoices = MembershipInvoiceSerializer(many=True, read_only=True)
    # Current-period remaining per entitlement (quantity + granted − consumed −
    # reserved; null = unlimited), computed by the same engine bookings use, so
    # the UI never re-implements period maths or misses bonus/held units.
    entitlement_status = serializers.SerializerMethodField()

    class Meta:
        model = Membership
        fields = (
            "id", "number", "customer", "customer_name", "plan", "plan_name",
            "club", "club_name", "status", "status_display",
            "start_date", "end_date", "auto_renew",
            "entitlements", "balances", "entitlement_status", "invoices",
            "created_at", "updated_at",
        )
        read_only_fields = (
            "id", "number", "status", "start_date", "end_date",
            "created_at", "updated_at",
        )

    def get_entitlement_status(self, obj):
        from . import services as svc
        today = timezone.localdate()
        balances = list(obj.balances.all())
        out = []
        for ent in obj.plan.entitlements.all():
            pk = svc.period_key(ent.period, today)
            bal = next((b for b in balances
                        if b.entitlement_id == ent.id and b.period_key == pk), None)
            out.append({
                "entitlement": ent.id,
                "period_key": pk,
                "limit_type": ent.limit_type,
                "quantity": ent.quantity,
                "consumed": bal.consumed if bal else 0,
                "reserved": bal.reserved if bal else 0,
                "granted": bal.granted if bal else 0,
                "remaining": svc._remaining(obj, ent, pk),   # None = unlimited
            })
        return out


def _abs_pdf_url(obj, context) -> str | None:
    return public_file_url(obj.pdf, context.get("request"))


class ReceiptSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source="customer.full_name", read_only=True, default=None)
    bill_to = serializers.CharField(source="invoice.bill_to_display", read_only=True)
    invoice_number = serializers.CharField(source="invoice.number", read_only=True)
    pdf_url = serializers.SerializerMethodField()

    class Meta:
        model = Receipt
        fields = (
            "id", "number", "invoice", "invoice_number", "customer", "customer_name",
            "bill_to", "payment", "currency", "amount", "method", "issued_at", "pdf_url",
        )
        read_only_fields = fields

    def get_pdf_url(self, obj) -> str | None:
        return _abs_pdf_url(obj, self.context)


class CreditNoteSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source="customer.full_name", read_only=True, default=None)
    bill_to = serializers.CharField(source="invoice.bill_to_display", read_only=True)
    invoice_number = serializers.CharField(source="invoice.number", read_only=True)
    # Cross-links so the refund page can open the originating booking / payment.
    booking = serializers.IntegerField(source="invoice.booking.id", read_only=True, default=None)
    booking_reference = serializers.CharField(source="invoice.booking.reference", read_only=True, default=None)
    payment = serializers.IntegerField(source="invoice.payment.id", read_only=True, default=None)
    payment_reference = serializers.CharField(source="invoice.payment.reference", read_only=True, default=None)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    requested_by_name = serializers.CharField(source="requested_by.full_name", read_only=True, default=None)
    approved_by_name = serializers.CharField(source="approved_by.full_name", read_only=True, default=None)
    rejected_by_name = serializers.CharField(source="rejected_by.full_name", read_only=True, default=None)
    pdf_url = serializers.SerializerMethodField()

    class Meta:
        model = CreditNote
        fields = (
            "id", "number", "status", "status_display",
            "invoice", "invoice_number", "customer", "customer_name",
            "booking", "booking_reference", "payment", "payment_reference",
            "bill_to", "refund", "method", "currency", "subtotal", "tax_amount", "total", "tax_rate",
            "total_raw", "total_extended", "rounding_difference", "reason",
            "requested_by", "requested_by_name", "requested_at",
            "approved_by", "approved_by_name", "approved_at",
            "rejected_by", "rejected_by_name", "rejected_at", "remarks",
            "issued_at", "pdf_url",
        )
        read_only_fields = fields

    def get_pdf_url(self, obj) -> str | None:
        return _abs_pdf_url(obj, self.context)


class InvoiceSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source="customer.full_name", read_only=True, default=None)
    bill_to = serializers.CharField(source="bill_to_display", read_only=True)
    booking_reference = serializers.CharField(source="booking.reference", read_only=True, default=None)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    purpose_display = serializers.CharField(source="get_purpose_display", read_only=True)
    membership_number = serializers.CharField(source="membership.number", read_only=True, default=None)
    refunded_total = serializers.DecimalField(max_digits=13, decimal_places=3, read_only=True)
    refundable_amount = serializers.DecimalField(max_digits=13, decimal_places=3, read_only=True)
    amount_paid = serializers.SerializerMethodField()
    outstanding = serializers.SerializerMethodField()
    receipt = ReceiptSerializer(read_only=True)
    credit_notes = CreditNoteSerializer(many=True, read_only=True)
    pdf_url = serializers.SerializerMethodField()
    booking_detail = serializers.SerializerMethodField()

    class Meta:
        model = Invoice
        fields = (
            "id", "number", "customer", "customer_name", "bill_to",
            "bill_to_name", "bill_to_email",
            "payment", "booking", "booking_reference", "booking_detail",
            "purpose", "purpose_display", "membership", "membership_number",
            "currency", "subtotal", "tax_amount", "total", "tax_rate",
            "total_raw", "total_extended", "rounding_difference",
            "status", "status_display", "issued_at", "cancelled_at", "cancel_reason",
            "refunded_total", "refundable_amount", "amount_paid", "outstanding",
            "receipt", "credit_notes", "pdf_url",
        )
        read_only_fields = fields

    def get_pdf_url(self, obj) -> str | None:
        return _abs_pdf_url(obj, self.context)

    def get_booking_detail(self, obj):
        """FacilityCategory / add-ons / subscription coverage / promo from the linked booking,
        so the invoice page shows the full picture. Promo code is masked for users
        without promotions.view."""
        b = obj.booking
        if b is None:
            return None
        from apps.bookings.serializers import PROMO_MASK, can_view_promo
        promo = None
        if b.promo_code_id:
            promo = b.promo_code.code if can_view_promo(self.context) else PROMO_MASK
        return {
            "facility": (b.facility_type.name if b.facility_type_id
                         else b.facility_category.name if b.facility_category_id else None),
            "add_ons": [a.name for a in b.add_ons.all()],
            "club": b.club.name if b.club_id else None,
            "coverage": b.coverage_snapshot or None,
            "promo_code": promo,
            "promo_discount": str(b.promo_discount),
            "booking_total": str(b.total_amount),
        }

    def _paid(self, obj) -> Decimal:
        # Invoices settle in full in this system, so a paid/credited invoice is
        # fully paid; an issued one is outstanding.
        from .models import InvoiceStatus
        settled = (InvoiceStatus.PAID, InvoiceStatus.PARTIALLY_REFUNDED, InvoiceStatus.REFUNDED)
        return Decimal(obj.total) if obj.status in settled else Decimal("0")

    def get_amount_paid(self, obj) -> Decimal:
        return self._paid(obj)

    def get_outstanding(self, obj) -> Decimal:
        return max(Decimal("0"), Decimal(obj.total) - self._paid(obj))


# --- Action payloads ---
class ChargeSerializer(serializers.Serializer):
    booking = serializers.IntegerField(required=False)
    method = serializers.ChoiceField(choices=["card", "cash", "wallet"])
    amount = serializers.DecimalField(max_digits=13, decimal_places=3, required=False)


class CancelInvoiceSerializer(serializers.Serializer):
    reason = serializers.CharField(required=False, allow_blank=True, max_length=255)


class RefundRequestSerializer(serializers.Serializer):
    """Request a refund against an invoice (creates a credit note). Omit `amount`
    to refund the full remaining balance; provide it for a partial refund."""
    amount = serializers.DecimalField(max_digits=13, decimal_places=3, required=False)
    reason = serializers.CharField(required=False, allow_blank=True, max_length=255)
    # How to return the money; defaults server-side to the original payment method.
    method = serializers.ChoiceField(
        choices=["cash", "card", "wallet", "bank_transfer"], required=False)


class RefundRejectSerializer(serializers.Serializer):
    # A rejection reason is mandatory — the approver must say why.
    remarks = serializers.CharField(required=True, allow_blank=False, max_length=500,
                                    error_messages={"required": "A reason is required to reject a refund.",
                                                    "blank": "A reason is required to reject a refund."})


class TopUpSerializer(serializers.Serializer):
    customer = serializers.IntegerField()
    # No hardcoded minimum — the action enforces the currency's minimum
    # accountable unit (e.g. JPY 1, USD 0.01, BHD 0.001).
    amount = serializers.DecimalField(max_digits=13, decimal_places=3)
    note = serializers.CharField(required=False, allow_blank=True, max_length=255)


class IssueMembershipSerializer(serializers.Serializer):
    customer = serializers.IntegerField()
    plan = serializers.IntegerField()
    club = serializers.IntegerField(required=False, allow_null=True)
    # Payment method for the sale (omit for a comped / admin-granted membership).
    method = serializers.ChoiceField(choices=["card", "cash", "wallet"], required=False)
    # Optional promo code applied to the plan price before charging.
    promo_code = serializers.CharField(required=False, allow_blank=True, max_length=64)
    auto_renew = serializers.BooleanField(required=False, default=True)


class ActivateMembershipSerializer(serializers.Serializer):
    """Confirm a customer-requested (draft) membership. Omit `method` to comp it."""
    method = serializers.ChoiceField(choices=["card", "cash", "wallet"], required=False)
    promo_code = serializers.CharField(required=False, allow_blank=True, max_length=64)


class RenewMembershipSerializer(ActivateMembershipSerializer):
    # Operator acknowledged that renewing early charges another full term now.
    confirm_early = serializers.BooleanField(required=False, default=False)


class MembershipReasonSerializer(serializers.Serializer):
    reason = serializers.CharField(required=False, allow_blank=True, max_length=255)


class ExtendMembershipSerializer(serializers.Serializer):
    days = serializers.IntegerField(required=False, min_value=1)
    end_date = serializers.DateField(required=False)

    def validate(self, attrs):
        if not attrs.get("days") and not attrs.get("end_date"):
            raise serializers.ValidationError("Provide a number of days or an end date.")
        return attrs


class AdjustUsageSerializer(serializers.Serializer):
    entitlement = serializers.IntegerField()
    units = serializers.IntegerField(min_value=1)
    # grant=True adds bonus units beyond the plan quantity; grant=False (default)
    # restores previously-consumed units. They are distinct operations.
    grant = serializers.BooleanField(required=False, default=False)
    # Optional explicit period bucket; left blank, the facility_category resolves it from
    # the entitlement's period (current bucket; restore falls back to the bucket
    # that actually holds consumed usage).
    period_key = serializers.CharField(required=False, allow_blank=True, max_length=12)
    note = serializers.CharField(required=False, allow_blank=True, max_length=255)
