"""Booking serializers — read, create, and status-action payloads."""

import re
from decimal import Decimal

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from apps.facilities.models import Facility
from apps.payments.models import PaymentMethod as PaymentMethodChoices

from .models import (
    Booking,
    BookingPolicy,
    BookingSource,
    BookingStatus,
    BookingStatusHistory,
    COMPLETED_STATUSES,
    PAID_PAYMENT_STATUSES,
    RecurrenceRule,
)

PROMO_MASK = "****"


def can_view_promo(context) -> bool:
    """Whether the requesting user may see promo CODES. Gated by promotions.view —
    everyone else gets the code masked everywhere it appears (booking, logs)."""
    user = getattr(context.get("request"), "user", None)
    return bool(user and getattr(user, "is_authenticated", False)
                and user.has_perm_code("promotions.view"))


def _mask_promo_in_note(note: str) -> str:
    """Strip a promo code from a free-text booking-log note for users without view.
    'Promo SAVE10 applied' -> 'Promo applied'."""
    return re.sub(r"^(Promo)\s+\S+\s+(applied|removed)", r"\1 \2", note or "")


class BookingStatusHistorySerializer(serializers.ModelSerializer):
    changed_by_name = serializers.CharField(source="changed_by.full_name", read_only=True)
    note = serializers.SerializerMethodField()
    meta = serializers.SerializerMethodField()

    class Meta:
        model = BookingStatusHistory
        fields = (
            "id", "from_status", "to_status", "event",
            "changed_by", "changed_by_name", "note", "meta", "created_at",
        )
        read_only_fields = fields

    def get_note(self, obj) -> str:
        if can_view_promo(self.context):
            return obj.note
        return _mask_promo_in_note(obj.note)

    def get_meta(self, obj) -> dict:
        meta = obj.meta or {}
        if "code" in meta and not can_view_promo(self.context):
            return {**meta, "code": PROMO_MASK}
        return meta


class BookingSerializer(serializers.ModelSerializer):
    """Read serializer with denormalised labels for the dashboard."""

    customer_name = serializers.CharField(source="customer.full_name", read_only=True, default=None)
    customer_email = serializers.CharField(source="customer.email", read_only=True, default=None)
    customer_label = serializers.SerializerMethodField()
    facility_category_name = serializers.CharField(source="facility_category.name", read_only=True, default=None)
    facility_type_name = serializers.CharField(source="facility_type.name", read_only=True, default=None)
    # The activity's own photo, so a booking can be recognised at a glance
    # instead of read. `ImageField` resolves an absolute URL from the request
    # in the serializer context, which the viewset already supplies, and the
    # listing queryset already `select_related`s `facility_type`, so a page of
    # rows costs no extra queries.
    facility_type_image = serializers.ImageField(
        source="facility_type.image", read_only=True, default=None)
    assigned_to_name = serializers.CharField(source="assigned_to.full_name", read_only=True, default=None)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    updated_by_name = serializers.CharField(source="updated_by.full_name", read_only=True, default=None)
    club_name = serializers.CharField(source="club.name", read_only=True, default=None)
    promo_code_label = serializers.SerializerMethodField()
    tax_inclusive = serializers.BooleanField(source="facility_type.tax_inclusive", read_only=True, default=False)
    source_display = serializers.CharField(source="get_source_display", read_only=True, default=None)
    facility_name = serializers.CharField(source="facility.name", read_only=True, default=None)
    add_on_names = serializers.SerializerMethodField()
    status_history = BookingStatusHistorySerializer(many=True, read_only=True)
    cancellation = serializers.SerializerMethodField()
    can_modify = serializers.SerializerMethodField()
    can_delete = serializers.SerializerMethodField()
    membership_coverage = serializers.SerializerMethodField()
    eligible_subscription = serializers.SerializerMethodField()
    coverage_state = serializers.SerializerMethodField()
    amount_paid = serializers.SerializerMethodField()
    outstanding = serializers.SerializerMethodField()
    paid_invoice_number = serializers.SerializerMethodField()
    price_breakdown = serializers.SerializerMethodField()
    # Cheap enough for a list row with `select_related("order")`; the full
    # sibling list below costs a query each, so it is detail-only.
    order_reference = serializers.CharField(
        source="order.reference", read_only=True, default=None)
    order_summary = serializers.SerializerMethodField()
    customer_verified = serializers.BooleanField(source="customer.is_verified", read_only=True, default=None)

    class Meta:
        model = Booking
        fields = (
            "id", "reference",
            "customer", "customer_name", "customer_email", "customer_label",
            "walk_in_name", "walk_in_phone", "walk_in_email",
            "facility_category", "facility_category_name",
            "facility_type", "facility_type_name", "facility_type_image",
            "add_ons", "add_on_names",
            "booking_type", "source", "source_display", "priority", "status",
            "customer_was_new", "customer_info_updated", "customer_verified",
            # `end_time` is derived and clamped server-side; the calendar view
            # positions blocks with it rather than re-deriving the wrap itself.
            "scheduled_date", "scheduled_time", "end_time", "duration_minutes",
            "club", "club_name", "facility", "facility_name",
            "assigned_to", "assigned_to_name",
            "currency", "base_amount", "addons_amount", "discount_amount",
            "surcharge_amount", "tax_amount", "tax_inclusive", "total_amount",
            "total_raw", "total_extended", "rounding_difference",
            "applied_rules", "calculated_at", "price_breakdown",
            "promo_code", "promo_code_label", "promo_discount",
            "loyalty_discount", "loyalty_points_redeemed", "loyalty_points_earned",
            "payment_status", "payment_method",
            "amount_paid", "outstanding", "paid_invoice_number",
            "recurrence", "parent_booking",
            "order", "order_reference", "order_summary",
            "customer_notes", "internal_notes", "special_instructions",
            "completed_at", "cancelled_at", "cancellation_reason",
            "status_history", "cancellation", "can_modify", "can_delete",
            "membership_coverage", "coverage_snapshot", "subscription_opt_out",
            "eligible_subscription", "coverage_state",
            "created_by", "created_by_name", "updated_by", "updated_by_name",
            "created_at", "updated_at",
        )
        read_only_fields = fields

    def get_order_summary(self, obj) -> dict:
        """The other slots bought in the same checkout, when there are any.

        A multi-slot order is N ordinary bookings, which is what keeps the
        calendar, capacity and refunds working. The cost of that choice is that
        a single booking looks unrelated to its siblings, so the one screen
        that can say otherwise has to.
        """
        if not obj.order_id or not self.context.get("with_coverage"):
            return None
        order = obj.order
        siblings = list(order.bookings.order_by("scheduled_date", "scheduled_time"))
        return {
            "reference": order.reference,
            "slot_count": len(siblings),
            "currency": order.currency,
            "total_amount": str(order.total_amount),
            "slots": [{
                "id": row.id,
                "reference": row.reference,
                "scheduled_date": row.scheduled_date.isoformat() if row.scheduled_date else "",
                "scheduled_time": row.scheduled_time.strftime("%H:%M") if row.scheduled_time else "",
                "end_time": row.end_time.strftime("%H:%M") if row.end_time else "",
                "status": row.status,
                "payment_status": row.payment_status,
                "total_amount": str(row.total_amount),
                "is_this_one": row.id == obj.id,
            } for row in siblings],
        }

    def get_price_breakdown(self, obj) -> dict:
        """Per-line VAT breakdown (facility_category + each add-on) for the detail view: each
        line's own discount + VAT, reconciling to the booking total — the same data
        the line-by-line invoice uses. Detail-only (context flag) to avoid per-row
        list cost."""
        if not self.context.get("with_coverage"):
            return None
        if not (obj.facility_type_id or obj.facility_category_id):
            return None
        from apps.bookings.services import booking_line_breakdown
        return [
            {"label": ln["label"], "quantity": ln["quantity"],
             "gross": str(ln["gross"]), "discount": str(ln["discount"]),
             "net": str(ln["net"]), "tax": str(ln["tax"]), "total": str(ln["total"]),
             "tax_inclusive": ln["tax_inclusive"]}
            for ln in booking_line_breakdown(obj)
        ]

    def get_membership_coverage(self, obj) -> dict:
        """What the customer's membership covers on this booking ("Covered by
        Membership"). Computed only for detail views (context flag) to avoid
        per-row cost on lists."""
        if not self.context.get("with_coverage") or not obj.customer_id:
            return None
        from apps.payments.services import coverage_for_booking
        cov = coverage_for_booking(obj)
        if not cov or not cov["covered_lines"]:
            return None
        m = cov["membership"]
        return {
            "membership_number": m.number,
            "plan_name": m.plan.name,
            "covered": [{"kind": line["kind"], "label": line["label"]}
                        for line in cov["covered_lines"]],
        }

    def get_eligible_subscription(self, obj) -> dict:
        """A membership that COULD cover this booking but isn't applied yet — drives
        the "Eligible subscription available" banner + the Redeem action. Detail-only;
        None once coverage is already applied, or once the booking is payment-locked
        (so the UI never offers a Redeem the backend would refuse)."""
        if not self.context.get("with_coverage") or not obj.customer_id:
            return None
        if obj.coverage_snapshot:          # already covered → nothing to redeem
            return None
        from apps.bookings.services import coverage_change_locked
        if coverage_change_locked(obj):    # paid/finalised → coverage frozen
            return None
        from apps.payments.services import coverage_for_booking
        # Holds are soft: a free unit (consumption availability) makes this booking
        # eligible to redeem even if another booking is holding the unit.
        cov = coverage_for_booking(obj, ignore_opt_out=True, for_consumption=True)
        if not cov or not cov["covered_lines"]:
            return None
        m = cov["membership"]
        from apps.payments.services import reservation_holders
        return {
            "membership_number": m.number,
            "plan_name": m.plan.name,
            "covered": [{"kind": line["kind"], "label": line["label"]}
                        for line in cov["covered_lines"]],
            "opted_out": bool(obj.subscription_opt_out),
            "held_by": reservation_holders(m, exclude_booking_id=obj.id),
        }

    def get_coverage_state(self, obj) -> dict:
        """A single clear subscription state for this booking (detail-only):
        consumed / held / at_risk / released / eligible / chargeable / none."""
        from apps.bookings.models import BookingStatus
        if not self.context.get("with_coverage") or not obj.customer_id:
            return None
        if obj.coverage_snapshot:
            if obj.status in (BookingStatus.COMPLETED, BookingStatus.CLOSED):
                return "consumed"            # finally used
            from apps.payments.services import coverage_for_booking
            avail = coverage_for_booking(obj, for_consumption=True)
            return "held" if (avail and avail["covered_lines"]) else "at_risk"
        if obj.subscription_opt_out:
            return "released"
        # A payment-locked (paid/finalised) booking can't redeem — never show it as
        # "eligible", even if a free unit exists.
        from apps.bookings.services import coverage_change_locked
        if coverage_change_locked(obj):
            return "chargeable"
        from apps.payments.services import coverage_for_booking
        avail = coverage_for_booking(obj, ignore_opt_out=True, for_consumption=True)
        return "eligible" if (avail and avail["covered_lines"]) else "chargeable"

    # The money-collected figures aggregate this booking's payments and invoices,
    # which is a query per booking. Only the detail page reads them, so they
    # follow the same detail-only gate as the coverage fields rather than
    # costing every row of a 100-row listing page.
    def get_amount_paid(self, obj) -> str:
        if not self.context.get("with_coverage"):
            return None
        from apps.bookings.services import booking_amount_paid
        return str(booking_amount_paid(obj))

    def get_outstanding(self, obj) -> str:
        if not self.context.get("with_coverage"):
            return None
        from apps.bookings.services import booking_outstanding
        return str(booking_outstanding(obj))

    def get_paid_invoice_number(self, obj) -> str:
        """The booking's latest live invoice number — for the 'Payment already
        received against Invoice #…' message. Detail views only."""
        if not self.context.get("with_coverage"):
            return None
        from apps.payments.models import Invoice, InvoiceStatus
        return (Invoice.objects.filter(booking=obj)
                .exclude(status__in=[InvoiceStatus.CANCELLED, InvoiceStatus.REFUNDED])
                .order_by("-issued_at")
                .values_list("number", flat=True).first())

    def get_promo_code_label(self, obj) -> str:
        """The applied promo code — masked for users without promotions.view."""
        if not obj.promo_code_id:
            return None
        return obj.promo_code.code if can_view_promo(self.context) else PROMO_MASK

    def get_add_on_names(self, obj) -> list[str]:
        return [a.name for a in obj.add_ons.all()]

    def get_customer_label(self, obj) -> str:
        if obj.customer_id:
            return obj.customer.full_name
        return obj.walk_in_name or "Walk-in"

    def get_cancellation(self, obj) -> dict:
        """When the customer's own cancellation window closes. Staff ignore it.

        Resolving the policy is a query per booking, and only the detail page
        shows this, so it is gated like the other per-booking lookups.
        """
        if not self.context.get("with_coverage"):
            return None
        from apps.bookings.services import cancellation_state
        return cancellation_state(obj)

    def get_can_modify(self, obj) -> bool:
        """Whether the requesting staff user may edit/delete this booking —
        mirrors the viewset's `_guard_modify` (modify_all OR owns it) so the UI
        only offers Edit/Delete where the action would actually succeed."""
        from apps.accounts import access
        from apps.accounts.models import Role
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated or user.role == Role.CUSTOMER:
            return False
        return (access.can_modify_all(user, "bookings")
                or obj.created_by_id == user.id or obj.assigned_to_id == user.id)

    def get_can_delete(self, obj) -> bool:
        """Delete is offered only on a non-terminal booking with no money/records
        attached — mirrors the viewset's destroy guard, so the UI never shows a
        Delete that would fail (a completed/closed or paid booking is permanent)."""
        if not self.get_can_modify(obj):
            return False
        if obj.status in COMPLETED_STATUSES:
            return False
        if obj.payment_status in PAID_PAYMENT_STATUSES:
            return False
        # The listing queryset annotates both, so a page of rows needs no extra
        # queries. Fall back for a serializer used outside that queryset (a
        # freshly created booking, for instance).
        has_payments = getattr(obj, "_has_payments", None)
        has_invoices = getattr(obj, "_has_invoices", None)
        if has_payments is None or has_invoices is None:
            return not (obj.payments.exists() or obj.invoices.exists())
        return not (has_payments or has_invoices)


class BookingCreateSerializer(serializers.ModelSerializer):
    """Create / update a booking; pricing + duration are computed server-side."""

    promo_code_input = serializers.CharField(write_only=True, required=False, allow_blank=True)
    # Declared explicitly so DRF does not mark it REQUIRED on the strength of the
    # model's partial unique constraint on (facility, date, start). The client
    # books a facility TYPE; the server allocates the unit (see `_finalize`).
    facility = serializers.PrimaryKeyRelatedField(
        queryset=Facility.objects.all(), required=False, allow_null=True)
    # A one-way flag rather than a writable `status`: a client may say "I have
    # not finished this", and nothing else about the lifecycle. It is only
    # honoured on creation, so an existing booking can never be turned back
    # into an unfinished form and quietly give up its court.
    save_as_draft = serializers.BooleanField(
        write_only=True, required=False, default=False)

    class Meta:
        model = Booking
        fields = (
            "id",
            "customer",
            "walk_in_name", "walk_in_phone", "walk_in_email",
            "facility_category", "facility_type", "add_ons",
            "booking_type", "source", "priority",
            "scheduled_date", "scheduled_time",
            "club", "facility",
            "assigned_to",
            "payment_status", "payment_method",
            "promo_code_input",
            "recurrence",
            "customer_notes", "internal_notes", "special_instructions",
            "save_as_draft",
        )
        read_only_fields = ("id",)

    def get_unique_together_validators(self):
        """Drop the validator DRF infers from the model's partial unique
        constraint on (facility, date, start).

        That constraint exists purely as a database-level backstop against a
        double-allocation race. Letting DRF turn it into a serializer validator
        would make `facility` a REQUIRED request field, which is exactly wrong:
        the client books a facility TYPE and the server allocates the unit.
        Clashes are reported by `allocate_facility` with a usable message.
        """
        return []

    # A CLOSED booking is locked — only these may still be edited (no reopen needed).
    CLOSED_EDITABLE_FIELDS = {"customer_notes", "internal_notes"}

    @staticmethod
    def _closed_error():
        return serializers.ValidationError(
            "This booking is closed - reopen it to make changes. Only the Customer Notes "
            "and Internal Notes can be edited while closed.")

    def validate(self, attrs):
        eff = lambda f: attrs.get(f, getattr(self.instance, f, None))  # noqa: E731

        # A CLOSED booking is locked first — only customer/internal notes may change
        # (checked before any other rule so the message is always clear).
        if self.instance is not None and self.instance.status == BookingStatus.CLOSED:
            for field, value in attrs.items():
                if field in self.CLOSED_EDITABLE_FIELDS:
                    continue
                if field == "add_ons":
                    if set(a.id for a in (value or [])) != set(
                            self.instance.add_ons.values_list("id", flat=True)):
                        raise self._closed_error()
                elif getattr(self.instance, field, None) != value:
                    raise self._closed_error()

        # Exactly one bookable target: a facility type or a facility category.
        #
        # A draft is exempt, and only a draft. It is an unfinished form, so
        # "you have not said what you are booking yet" is its normal state
        # rather than an error; the same check runs again in `finish_draft`,
        # when the booking actually has to mean something.
        as_draft = bool(attrs.get("save_as_draft"))
        if (not as_draft
                and sum(bool(eff(f)) for f in ("facility_type", "facility_category")) != 1):
            raise serializers.ValidationError(
                "Provide exactly one of `facility_type` or `facility_category`."
            )

        is_walk_in = eff("booking_type") == "walk_in"
        customer = eff("customer")
        club = eff("club")
        facility = eff("facility")

        # Customer required unless walk-in (which captures a name snapshot),
        # or unless this is a draft: an unfinished form is allowed not to know
        # yet. `finish_draft` asks again before the booking becomes real.
        if not is_walk_in and not customer and not as_draft:
            raise serializers.ValidationError(
                {"customer": "Select a customer, or set booking type to walk-in."}
            )
        # A pinned facility must belong to the booking's club...
        if facility and club and facility.club_id != club.id:
            raise serializers.ValidationError(
                {"facility": "This facility does not belong to the selected club."}
            )
        # ...and must be able to host the chosen facility type.
        facility_type = eff("facility_type")
        if facility and facility_type and not facility.serves(facility_type):
            raise serializers.ValidationError(
                {"facility": f"{facility.name} cannot be booked as {facility_type.name}."}
            )

        # Contact rules (Booking Configuration) — enforced on CREATE for the admin
        # and walk-in channels. Website bookings are validated in the public view
        # (with its OTP reuse flow) before this serializer runs, so skip them here.
        if self.instance is None and eff("source") != BookingSource.WEBSITE:
            from apps.bookings import contacts
            if is_walk_in:
                rules = contacts.rules_for("walkin")
                email = (eff("walk_in_email") or "").strip()
                phone = (eff("walk_in_phone") or "").strip()
                miss = contacts.missing_required(rules, email=email, phone=phone)
                errs = {}
                if "email" in miss:
                    errs["walk_in_email"] = "Email is required for walk-in bookings."
                if "phone" in miss:
                    errs["walk_in_phone"] = "Mobile number is required for walk-in bookings."
                if errs:
                    raise serializers.ValidationError(errs)
                if phone and not contacts.phone_is_valid(phone):
                    raise serializers.ValidationError(
                        {"walk_in_phone": "Enter a valid mobile number with its country code."})
                if email and not contacts.email_looks_real(email):
                    raise serializers.ValidationError({"walk_in_email": "Enter a valid email."})
                conflict = contacts.find_conflict(rules, email=email, phone=phone)
                if conflict:
                    label = "mobile number" if conflict["field"] == "phone" else "email"
                    field = "walk_in_phone" if conflict["field"] == "phone" else "walk_in_email"
                    if conflict["source"] == "customer":
                        msg = (f"This {label} already belongs to a registered customer - "
                               "select that customer instead of booking a walk-in.")
                    else:
                        msg = f"This {label} was already used for a previous walk-in booking."
                    raise serializers.ValidationError({field: msg})
            elif customer is not None:
                rules = contacts.rules_for("admin")
                if rules["email_required"] and not (customer.email or "").strip():
                    raise serializers.ValidationError(
                        {"customer": "This customer has no email, which is required for admin bookings."})
                if rules["phone_required"] and not (customer.mobile_number or "").strip():
                    raise serializers.ValidationError(
                        {"customer": "This customer has no mobile number, which is required for admin bookings."})
        return attrs

    def _finalize(self, booking, add_ons):
        """Set add-ons, recompute pricing + duration, allocate a facility, persist."""
        if add_ons is not None:
            booking.add_ons.set(add_ons)
        booking.compute_duration()
        # A draft is an unfinished form the admin means to come back to, so
        # neither the club's booking rules nor a court are applied to it yet.
        # It holds nothing, and everything skipped here is enforced when it is
        # finished, which is the moment it stops being a draft and becomes a
        # real booking. Pricing still runs: an admin returning to a draft
        # wants to see what it would cost.
        if booking.status != BookingStatus.DRAFT:
            self._enforce_rules(booking)
            # Allocation happens AFTER the duration is known: a 90-minute
            # booking must be given a facility free for the whole 90 minutes.
            self._allocate_facility(booking)
        booking.compute_pricing()
        from apps.bookings.services import booking_amount_paid, sync_booking_payment_status
        if booking_amount_paid(booking) > 0:
            # Money already collected — re-derive from the ledger so adding services
            # drops the booking to PARTIALLY_PAID (only the delta is owed), never
            # silently staying 'paid'. Captures the add-on delta case.
            sync_booking_payment_status(booking, save=False)
        else:
            booking.sync_payment_status()   # 0 payable + coverage → covered / no-payment
        booking.save()
        return booking

    @staticmethod
    def _enforce_rules(booking):
        """Apply the club's booking policy to an admin-created booking.

        Staff are exempt unless the policy sets `enforce_for_staff` - reception
        must still be able to take a walk-in for the next ten minutes.
        """
        from apps.bookings.services import BookingRuleViolation, enforce_booking_rules
        try:
            enforce_booking_rules(
                club=booking.club, on_date=booking.scheduled_date,
                at_time=booking.scheduled_time, customer=booking.customer,
                staff_booking=True, exclude_booking_id=booking.pk)
        except BookingRuleViolation as exc:
            raise serializers.ValidationError({"scheduled_date": exc.reasons})

    def _allocate_facility(self, booking):
        """Pin the booking to a free facility, or fail with a clear field error.

        `exclude_hold_id` in the context is the reservation this booking is
        being created from. It must not block its own booking, and passing it
        through the context rather than the payload keeps it out of reach of
        the client: a caller cannot ask to ignore somebody else's hold.
        """
        from apps.bookings.services import FacilityUnavailable, allocate_facility
        try:
            allocate_facility(booking, commit=False,
                              exclude_hold_id=self.context.get("exclude_hold_id"))
        except FacilityUnavailable as exc:
            raise serializers.ValidationError({"scheduled_time": str(exc)})

    def create(self, validated_data):
        from apps.settings_app.currency import get_default_currency
        as_draft = validated_data.pop("save_as_draft", False)
        add_ons = validated_data.pop("add_ons", [])
        promo_input = (validated_data.pop("promo_code_input", "") or "").strip()
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            validated_data["created_by"] = request.user
        validated_data.setdefault("currency", get_default_currency())
        if as_draft:
            validated_data["status"] = BookingStatus.DRAFT
        booking = Booking(**validated_data)
        try:
            booking.full_clean(exclude=["reference", "duration_minutes"])
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.message_dict if hasattr(exc, "message_dict") else exc.messages)
        booking.save()
        booking = self._finalize(booking, add_ons)
        if promo_input:
            self._apply_promo(booking, promo_input, request)
        return booking

    def _apply_promo(self, booking, code, request):
        """Validate + attach a promo at creation; raise a field error if invalid."""
        from apps.promotions import services as promo_services
        try:
            promo = promo_services.get_active_promo(code)
            subtotal = booking.total_amount - booking.tax_amount + booking.promo_discount
            category_ids = (list(booking.facility_type.categories.values_list("id", flat=True))
                            if booking.facility_type_id else [])
            promo_services.validate_for_booking(
                promo, subtotal=subtotal, customer_id=booking.customer_id,
                facility_type_id=booking.facility_type_id, category_ids=category_ids,
                addon_ids=list(booking.add_ons.values_list("id", flat=True)),
            )
        except promo_services.PromoError as exc:
            raise serializers.ValidationError({"promo_code_input": str(exc)})
        booking.promo_code = promo
        booking.compute_pricing()
        booking.sync_payment_status()
        booking.save()
        user = request.user if request and request.user.is_authenticated else None
        promo_services.record_redemption(promo, booking, booking.promo_discount, user=user)

    def update(self, instance, validated_data):
        # Creation-only. Editing a draft leaves it a draft, and editing a real
        # booking must never be able to demote it back into one: that would
        # hand its court to somebody else without cancelling anything. The
        # only way out of draft is `services.finish_draft`.
        validated_data.pop("save_as_draft", None)
        add_ons = validated_data.pop("add_ons", None)
        # Snapshot the catalogue selection BEFORE the edit so we can log exactly what
        # changed (who added/removed which item/add-on, and the price impact).
        before = {
            "addons": set(instance.add_ons.values_list("name", flat=True)),
            "item": instance.facility_type.name if instance.facility_type_id else None,
            "total": instance.total_amount,
        }
        for field, value in validated_data.items():
            setattr(instance, field, value)
        request = self.context.get("request")
        actor = request.user if (request and request.user.is_authenticated) else None
        if actor:
            instance.updated_by = actor
        booking = self._finalize(instance, add_ons)
        self._log_service_change(booking, before, actor)
        return booking

    @staticmethod
    def _log_service_change(booking, before, actor):
        """Record a Booking Log entry when the facility type / add-ons change on an
        edit - so it's clear what was added/removed, by whom, and the impact."""
        from apps.bookings.services import record_booking_event
        now_addons = set(booking.add_ons.values_list("name", flat=True))
        now_item = booking.facility_type.name if booking.facility_type_id else None
        added = sorted(now_addons - before["addons"])
        removed = sorted(before["addons"] - now_addons)
        item_changed = now_item != before["item"]
        if not (added or removed or item_changed):
            return
        parts = []
        if item_changed:
            parts.append(f"facility type set to {now_item or '-'}")
        if added:
            parts.append("added " + ", ".join(added))
        if removed:
            parts.append("removed " + ", ".join(removed))
        record_booking_event(
            booking, "Booking updated - " + "; ".join(parts), actor=actor,
            event="booking_items_updated",
            meta={"added": added, "removed": removed,
                  "facility_type": now_item if item_changed else None,
                  "from_amount": str(before["total"]), "to_amount": str(booking.total_amount),
                  "currency": booking.currency})

    def to_representation(self, instance):
        return BookingSerializer(instance, context=self.context).data


class BookingPolicySerializer(serializers.ModelSerializer):
    club_name = serializers.CharField(source="club.name", read_only=True, default=None)
    facility_name = serializers.CharField(
        source="facility.name", read_only=True, default=None)
    scope = serializers.SerializerMethodField()
    # What actually applies here once inheritance is worked out, so the editor
    # can show a placeholder value for anything this row leaves empty instead
    # of making the operator guess what "inherit" means.
    effective = serializers.SerializerMethodField()

    class Meta:
        model = BookingPolicy
        fields = (
            "id", "club", "club_name", "facility", "facility_name",
            "is_default", "scope", "effective",
            "min_lead_minutes", "max_advance_days",
            "max_active_bookings_per_customer", "max_bookings_per_customer_per_day",
            "cancellation_cutoff_hours", "enforce_for_staff",
            "allow_multiple_slots", "allow_multiple_dates",
            "require_consecutive_slots",
            "min_slots_per_booking", "max_slots_per_booking",
            "updated_at",
        )
        read_only_fields = (
            "id", "club_name", "facility_name", "scope", "effective", "updated_at")

    def get_scope(self, obj) -> str:
        return obj.scope_label

    def get_effective(self, obj) -> dict:
        from apps.bookings.services import resolve_slot_rules
        return resolve_slot_rules(club=obj.club, facility=obj.facility)

    def validate(self, attrs):
        def eff(field):
            return attrs.get(field, getattr(self.instance, field, None))

        is_default, club, facility = eff("is_default"), eff("club"), eff("facility")
        named = [bool(is_default), bool(club), bool(facility)]
        if sum(named) > 1:
            raise serializers.ValidationError(
                "A booking policy belongs to one scope: the organization, a club, "
                "or a facility.")
        if not any(named):
            raise serializers.ValidationError(
                {"club": "Choose a club or a facility, or mark this as the "
                         "organization default."})

        # One row per scope - report it as a field error rather than a 500.
        qs = BookingPolicy.objects.all()
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if is_default and qs.filter(is_default=True).exists():
            raise serializers.ValidationError(
                {"is_default": "An organization default policy already exists."})
        if club and qs.filter(club=club).exists():
            raise serializers.ValidationError(
                {"club": "This club already has its own policy."})
        if facility and qs.filter(facility=facility).exists():
            raise serializers.ValidationError(
                {"facility": "This facility already has its own policy."})

        # A floor above the ceiling would make every booking impossible.
        lowest = eff("min_slots_per_booking")
        highest = eff("max_slots_per_booking")
        if lowest and highest and lowest > highest:
            raise serializers.ValidationError(
                {"max_slots_per_booking":
                    "The maximum must be at least the minimum."})
        return attrs


class StatusActionSerializer(serializers.Serializer):
    """Payload for the `transition` / `cancel` actions."""

    status = serializers.ChoiceField(choices=BookingStatus.choices, required=False)
    note = serializers.CharField(required=False, allow_blank=True, max_length=255)


class AssignSerializer(serializers.Serializer):
    assigned_to = serializers.IntegerField()
    facility = serializers.IntegerField(required=False, allow_null=True)
    # Force the assignment past shift/facility availability checks (gated by the
    # bookings.assign_override capability; recorded as an override in the audit).
    override = serializers.BooleanField(required=False, default=False)


class RecurrenceSerializer(serializers.Serializer):
    occurrences = serializers.IntegerField(min_value=1, max_value=52)


class CompleteBookingSerializer(serializers.Serializer):
    """Payload for the completion + payment wizard. Payment fields are optional
    when the booking is already paid (or has nothing to pay)."""

    method = serializers.ChoiceField(choices=PaymentMethodChoices.choices, required=False)
    amount = serializers.DecimalField(max_digits=13, decimal_places=3,
                                      required=False, min_value=Decimal("0"))
    reference = serializers.CharField(required=False, allow_blank=True, max_length=120)
    paid_at = serializers.DateTimeField(required=False)
    notes = serializers.CharField(required=False, allow_blank=True, max_length=500)
