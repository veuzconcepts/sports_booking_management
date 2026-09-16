"""Customer / address / loyalty serializers."""

from django.contrib.auth import get_user_model
from rest_framework import serializers

from apps.accounts.serializers import UserSerializer

from .models import Address, Customer, LoyaltyLedger

User = get_user_model()


class AddressSerializer(serializers.ModelSerializer):
    class Meta:
        model = Address
        fields = (
            "id",
            "customer",
            "label",
            "line1", "line2",
            "city", "state", "country", "postal_code",
            "parking_bay",
            "latitude", "longitude",
            "is_default",
            "created_at", "updated_at",
        )
        read_only_fields = ("id", "created_at", "updated_at")


class LoyaltyLedgerSerializer(serializers.ModelSerializer):
    txn_type_display = serializers.CharField(source="get_txn_type_display", read_only=True)
    source_display = serializers.CharField(source="get_source_display", read_only=True)
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        model = LoyaltyLedger
        fields = (
            "id", "customer", "txn_type", "txn_type_display", "points",
            "balance_before", "balance_after", "source", "source_display", "note",
            "related_booking_id", "related_invoice_ref", "created_by_name", "created_at",
        )
        read_only_fields = fields

    def get_created_by_name(self, obj) -> str:
        return obj.created_by.full_name if obj.created_by_id else ""


class CustomerSerializer(serializers.ModelSerializer):
    linked_user = UserSerializer(read_only=True)
    addresses = AddressSerializer(many=True, read_only=True)
    phone = serializers.CharField(read_only=True)   # alias of mobile_number
    login_status = serializers.SerializerMethodField()
    duplicate_count = serializers.SerializerMethodField()
    verification_method_display = serializers.SerializerMethodField()
    verified_by_name = serializers.SerializerMethodField()

    class Meta:
        model = Customer
        fields = (
            "id",
            "linked_user", "login_status", "login_invited_at",
            "customer_code", "customer_type",
            "full_name", "email", "phone",
            "mobile_number", "whatsapp_number",
            "gender", "date_of_birth", "nationality", "preferred_language",
            "address", "city", "area", "trn",
            "status", "is_vip", "is_member", "is_group",
            "is_verified", "verified_at", "verification_method",
            "verification_method_display", "verified_by_name",
            "source",
            "loyalty_points", "loyalty_tier", "lifetime_value",
            "loyalty_points_earned", "loyalty_points_redeemed", "loyalty_points_expired",
            "loyalty_spend", "tier_since",
            "member_since", "is_corporate", "notes",
            "addresses", "duplicate_count",
            "created_at", "updated_at",
        )
        # Profile is editable by staff via the admin form (PATCH). Identity-ish +
        # derived fields stay read-only; login + verification are managed by the
        # dedicated actions / booking flow.
        read_only_fields = (
            "id", "customer_code", "login_invited_at",
            "is_verified", "verified_at", "verification_method",
            "loyalty_points", "loyalty_tier", "lifetime_value",
            "loyalty_points_earned", "loyalty_points_redeemed", "loyalty_points_expired",
            "loyalty_spend", "tier_since",
            "member_since", "created_at", "updated_at",
        )

    def get_verification_method_display(self, obj) -> str:
        from .models import VerificationMethod
        return dict(VerificationMethod.choices).get(obj.verification_method, "")

    def get_verified_by_name(self, obj) -> str:
        return obj.verified_by.full_name if obj.verified_by_id else ""

    def get_login_status(self, obj) -> str:
        if obj.linked_user_id:
            return "Login Enabled" if obj.linked_user.is_active else "Login Disabled"
        if obj.login_invited_at:
            return "Invite Pending"
        return "No Login"

    def get_duplicate_count(self, obj) -> int:
        """How many OTHER records share this one's email or mobile — drives the
        duplicate warning on the list and detail views."""
        if not (obj.email or "").strip() and not (obj.mobile_number or "").strip():
            return 0
        from .services import duplicate_customers_qs
        return duplicate_customers_qs(obj).count()


class CustomerCreateSerializer(serializers.ModelSerializer):
    """Create a CUSTOMER ONLY — no User/login is created here.

    A login is provisioned later via the explicit `create-login` / `invite-login`
    / `link-user` actions (mobile-app login; there is no customer web portal).
    Deduplicates on mobile number, then email.
    """

    class Meta:
        model = Customer
        fields = (
            "id",
            "customer_type", "full_name", "mobile_number", "email", "whatsapp_number",
            "gender", "date_of_birth", "nationality", "preferred_language",
            "address", "city", "area", "trn",
            "source", "is_corporate", "is_vip", "is_member", "is_group", "notes",
        )
        read_only_fields = ("id",)

    def validate(self, attrs):
        from apps.bookings import contacts
        rules = contacts.rules_for("admin")
        full_name = (attrs.get("full_name") or "").strip()
        mobile = (attrs.get("mobile_number") or "").strip()
        email = (attrs.get("email") or "").strip()

        # Required contact fields (per Booking Configuration → Admin).
        errs = {}
        if rules["email_required"] and not email:
            errs["email"] = "Email is required."
        if rules["phone_required"] and not mobile:
            errs["mobile_number"] = "Mobile number is required."
        if errs:
            raise serializers.ValidationError(errs)

        if not (full_name or mobile):
            raise serializers.ValidationError(
                "Provide at least a full name or a mobile number."
            )

        # Format checks when a value is provided.
        if mobile and not contacts.phone_is_valid(mobile):
            raise serializers.ValidationError(
                {"mobile_number": "Enter a valid mobile number with its country code."})
        if email and not contacts.email_looks_real(email):
            raise serializers.ValidationError({"email": "Enter a valid email."})

        # Hard uniqueness (per config): surface the existing record so the admin can
        # open it instead of creating a duplicate.
        conflict = contacts.find_conflict(rules, email=email, phone=mobile)
        if conflict and conflict["source"] == "customer":
            existing = Customer.objects.filter(pk=conflict["customer_id"]).first()
            who = (existing.customer_code or existing.full_name) if existing else "this contact"
            label = "mobile number" if conflict["field"] == "phone" else "email"
            field = "mobile_number" if conflict["field"] == "phone" else "email"
            raise serializers.ValidationError(
                {field: f"A customer with this {label} already exists ({who}). Open that record instead."})
        return attrs

    def to_representation(self, instance):
        return CustomerSerializer(instance, context=self.context).data
