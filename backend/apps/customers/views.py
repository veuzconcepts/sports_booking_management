"""Customer / address / loyalty endpoints."""

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import APIException, PermissionDenied
from rest_framework.response import Response


class _CannotDelete(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "This record cannot be deleted."
    default_code = "conflict"

from apps.accounts import access
from apps.accounts.models import Role, STAFF_ROLES
from apps.auditlogs.services import log_event

from .models import Address, Customer, LoyaltyLedger, LoyaltyTxnType

User = get_user_model()
from .permissions import AddressObjectPermission, CustomerObjectPermission
from .serializers import (
    AddressSerializer,
    CustomerCreateSerializer,
    CustomerSerializer,
    LoyaltyLedgerSerializer,
)


class CustomerViewSet(viewsets.ModelViewSet):
    queryset = (
        Customer.objects
        .select_related("linked_user")
        .prefetch_related("addresses")
        .all()
    )
    permission_classes = [permissions.IsAuthenticated, CustomerObjectPermission]
    filterset_fields = ["loyalty_tier", "is_corporate", "source", "customer_type", "status"]
    search_fields = ["full_name", "email", "mobile_number", "customer_code"]
    ordering_fields = ["created_at", "lifetime_value", "loyalty_points"]

    def get_queryset(self):
        qs = super().get_queryset()
        user = self.request.user
        if user.role not in STAFF_ROLES:
            # Customers may only see their own record (portal/mobile use).
            return qs.filter(linked_user=user)
        # Staff: without customers.view_all see only customers they registered.
        if not access.can_view_all(user, "customers"):
            qs = qs.filter(created_by=user)
        return qs

    def get_serializer_class(self):
        if self.action == "create":
            return CustomerCreateSerializer
        return CustomerSerializer

    def perform_create(self, serializer):
        customer = serializer.save()
        if customer.created_by_id is None:
            customer.created_by = self.request.user
            customer.save(update_fields=["created_by"])

    @action(detail=False, methods=["get"])
    def lookup(self, request):
        """Find an existing customer by email/phone for the booking/customer forms,
        so staff can reuse a record instead of creating a duplicate. Honours the
        Admin channel's uniqueness rules to decide which fields to match on."""
        from apps.bookings import contacts
        email = request.query_params.get("email") or ""
        phone = request.query_params.get("phone") or ""
        rules = contacts.rules_for("admin")
        source, obj, field = contacts.find_match(
            email=email, phone=phone,
            check_email=bool(rules.get("email_unique")),
            check_phone=bool(rules.get("phone_unique")),
        )
        if source != "customer" or obj is None:
            return Response({"match": None})
        return Response({"match": {
            "id": obj.id,
            "code": obj.customer_code,
            "name": obj.full_name,
            "email": obj.email,
            "phone": obj.mobile_number,
            "field": field,
        }})

    @action(detail=True, methods=["get"])
    def activity(self, request, pk=None):
        """Per-customer Activity Log — audit entries whose subject is this customer
        (profile updates from website bookings, etc.). Gated by `customers.view`
        and scoped via get_object() so ownership rules still apply."""
        from apps.auditlogs.models import AuditLog
        from apps.auditlogs.serializers import AuditLogSerializer

        customer = self.get_object()
        qs = (AuditLog.objects
              .filter(subject_type="customer", subject_id=str(customer.id))
              .select_related("actor")
              .order_by("-created_at"))
        page = self.paginate_queryset(qs)
        data = AuditLogSerializer(page if page is not None else qs, many=True,
                                  context={"request": request}).data
        return self.get_paginated_response(data) if page is not None else Response(data)

    @action(detail=True, methods=["get"])
    def duplicates(self, request, pk=None):
        """Other customer records that share this one's email or mobile number —
        candidates for a merge. Scoped via get_object() so ownership rules apply."""
        from .services import duplicate_customers_qs, duplicate_match_field
        customer = self.get_object()
        dups = duplicate_customers_qs(customer)
        return Response([{
            "id": d.id,
            "code": d.customer_code,
            "name": d.full_name,
            "email": d.email,
            "phone": d.mobile_number,
            "match": duplicate_match_field(customer, d),
            "created_at": d.created_at,
            "bookings": d.bookings.count() if hasattr(d, "bookings") else 0,
        } for d in dups])

    @action(detail=True, methods=["post"])
    def merge(self, request, pk=None):
        """Merge one or more duplicate records INTO this one (the survivor). All
        related data is re-mapped onto the survivor with no orphans; the sources
        are deleted.

        Strictly gated by the dedicated `customers.merge` capability (not Edit or
        Delete), plus modify rights (ownership / Modify All) on every record
        involved."""
        target = self.get_object()
        if not request.user.has_perm_code("customers.merge"):
            return Response(
                {"detail": access.denial_message("customers", "merge")},
                status=status.HTTP_403_FORBIDDEN)
        self._guard_modify(target)
        source_ids = request.data.get("source_ids") or []
        if not isinstance(source_ids, list) or not source_ids:
            return Response({"detail": "Select at least one record to merge into this customer."},
                            status=status.HTTP_400_BAD_REQUEST)
        sources = list(Customer.objects.filter(pk__in=source_ids).exclude(pk=target.pk))
        if not sources:
            return Response({"detail": "No matching records were found to merge."},
                            status=status.HTTP_400_BAD_REQUEST)
        for s in sources:
            self._guard_modify(s)
        from .services import merge_customers
        merge_customers(target, sources, request=request)
        target.refresh_from_db()
        return Response(CustomerSerializer(target, context={"request": request}).data)

    @action(detail=True, methods=["post"])
    def verify(self, request, pk=None):
        """Manually mark a customer as verified (trusted identity/contact).

        Gated by the dedicated `customers.verify` capability + modify rights. The
        booking flow verifies customers automatically (on confirmation / online
        payment) without this permission — this is the manual master-page action."""
        customer = self.get_object()
        if not request.user.has_perm_code("customers.verify"):
            return Response({"detail": access.denial_message("customers", "verify")},
                            status=status.HTTP_403_FORBIDDEN)
        self._guard_modify(customer)
        if customer.is_verified:
            return Response({"detail": "This customer is already verified."},
                            status=status.HTTP_400_BAD_REQUEST)
        from .models import VerificationMethod
        from .services import verify_customer
        verify_customer(customer, method=VerificationMethod.MANUAL,
                        actor=request.user, request=request)
        return self._ok(customer)

    def _guard_modify(self, obj):
        """Editing/deleting OTHERS' customers needs customers.modify_all."""
        u = self.request.user
        if access.can_modify_all(u, "customers") or obj.created_by_id == u.id:
            return
        raise PermissionDenied("You can only modify customers you registered. Ask for Modify All access.")

    def perform_update(self, serializer):
        self._guard_modify(serializer.instance)
        serializer.save()

    def perform_destroy(self, instance):
        # Only UNVERIFIED customers may be deleted (junk/fake cleanup). A verified
        # customer has trusted history and is protected — block the delete.
        if instance.is_verified:
            raise _CannotDelete(
                "This customer is verified and cannot be deleted. Only unverified "
                "customers can be removed.")
        self._guard_modify(instance)
        instance.delete()

    @action(detail=False, methods=["get"], url_path="me")
    def me(self, request):
        """Convenience endpoint for the customer's own profile."""
        try:
            customer = Customer.objects.select_related("linked_user").get(linked_user=request.user)
        except Customer.DoesNotExist:
            return Response({"detail": "No customer profile."},
                            status=status.HTTP_404_NOT_FOUND)
        return Response(CustomerSerializer(customer).data)

    @action(detail=True, methods=["post"], url_path="adjust-loyalty")
    def adjust_loyalty(self, request, pk=None):
        """Add/subtract loyalty points with a rich ledger entry + tier recompute
        (requires `loyalty.adjust`)."""
        if not request.user.has_perm_code("loyalty.adjust"):
            return Response({"detail": access.denial_message("loyalty", "adjust")},
                            status=status.HTTP_403_FORBIDDEN)
        customer = self.get_object()
        try:
            points = int(request.data.get("points", 0))
        except (TypeError, ValueError):
            return Response({"detail": "Points must be a whole number."},
                            status=status.HTTP_400_BAD_REQUEST)
        if points == 0:
            return Response({"detail": "Points cannot be zero."},
                            status=status.HTTP_400_BAD_REQUEST)
        from apps.loyalty.services import LoyaltyError, adjust_points
        try:
            customer = adjust_points(customer, points, note=request.data.get("note", ""),
                                     actor=request.user, request=request)
        except LoyaltyError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(CustomerSerializer(customer, context={"request": request}).data)

    @action(detail=True, methods=["get"])
    def loyalty(self, request, pk=None):
        """Per-customer loyalty summary: tier (+ progress to next), balance and
        lifetime earned/redeemed/expired. Requires `loyalty.view`."""
        if not request.user.has_perm_code("loyalty.view"):
            return Response({"detail": access.denial_message("loyalty", "view")},
                            status=status.HTTP_403_FORBIDDEN)
        from decimal import Decimal
        from apps.loyalty.models import LoyaltyTier
        c = self.get_object()
        tiers = list(LoyaltyTier.objects.filter(is_active=True).order_by("rank"))
        cur = next((t for t in tiers if t.slug == c.loyalty_tier), None)
        nxt = next((t for t in tiers if (cur is None or t.rank > cur.rank)), None)
        progress = None
        if nxt:
            progress = {
                "next_tier": nxt.name,
                "next_min_points": nxt.min_points,
                "next_min_spend": str(nxt.min_spend) if nxt.min_spend is not None else None,
                "points_to_go": max(0, (nxt.min_points or 0) - (c.loyalty_points or 0)) if nxt.min_points else 0,
                "spend_to_go": str(max(Decimal("0"), (nxt.min_spend or Decimal("0")) - Decimal(str(c.loyalty_spend or 0)))) if nxt.min_spend else None,
            }
        return Response({
            "tier": c.loyalty_tier,
            "tier_name": cur.name if cur else c.loyalty_tier,
            "tier_since": c.tier_since,
            "balance": c.loyalty_points,
            "earned": c.loyalty_points_earned,
            "redeemed": c.loyalty_points_redeemed,
            "expired": c.loyalty_points_expired,
            "spend": str(c.loyalty_spend or 0),
            "progress": progress,
        })

    # ----------------------------------------------------------------- #
    # Login management (mobile-app login only — there is no customer web portal).
    # Staff actions; a customer login can never reach the admin panel.
    # ----------------------------------------------------------------- #
    def _staff_guard(self, customer):
        # Provisioning/disabling a customer login is a customer edit.
        if not self.request.user.has_perm_code("customers.edit"):
            raise PermissionDenied("You don't have permission to edit customers.")
        self._guard_modify(customer)

    def _ok(self, customer):
        return Response(CustomerSerializer(customer, context={"request": self.request}).data)

    @action(detail=True, methods=["post"], url_path="create-login")
    def create_login(self, request, pk=None):
        """Provision a customer-only mobile login + link it to this customer."""
        customer = self.get_object()
        self._staff_guard(customer)
        if customer.linked_user_id:
            return Response({"detail": "This customer already has a login."},
                            status=status.HTTP_400_BAD_REQUEST)
        email = (request.data.get("email") or customer.email or "").strip().lower()
        if not email:
            return Response({"detail": "An email is required to create a login."},
                            status=status.HTTP_400_BAD_REQUEST)
        if User.objects.filter(email__iexact=email).exists():
            return Response({"detail": "A user with this email already exists."},
                            status=status.HTTP_400_BAD_REQUEST)
        from apps.accounts.security import generate_password
        first, _, last = (customer.full_name or "").partition(" ")
        user = User.objects.create_user(
            email=email, password=generate_password(),
            first_name=first or (customer.full_name or email), last_name=last,
            phone=customer.mobile_number or "", role=Role.CUSTOMER,
        )
        customer.linked_user = user
        customer.login_invited_at = None
        if not customer.email:
            customer.email = email
        customer.updated_by = request.user
        customer.save(update_fields=["linked_user", "login_invited_at", "email", "updated_by", "updated_at"])
        log_event(request, "customer_login_created",
                  {"customer": customer.customer_code, "email": email})
        return self._ok(customer)

    @action(detail=True, methods=["post"], url_path="invite-login")
    def invite_login(self, request, pk=None):
        """Mark the customer as invited to set up a mobile login (delivery TBD)."""
        customer = self.get_object()
        self._staff_guard(customer)
        if customer.linked_user_id:
            return Response({"detail": "This customer already has a login."},
                            status=status.HTTP_400_BAD_REQUEST)
        customer.login_invited_at = timezone.now()
        customer.updated_by = request.user
        customer.save(update_fields=["login_invited_at", "updated_by", "updated_at"])
        log_event(request, "customer_login_invited", {"customer": customer.customer_code})
        return self._ok(customer)

    @action(detail=True, methods=["post"], url_path="link-user")
    def link_user(self, request, pk=None):
        """Link an existing customer-role User account to this customer."""
        customer = self.get_object()
        self._staff_guard(customer)
        if customer.linked_user_id:
            return Response({"detail": "This customer already has a login."},
                            status=status.HTTP_400_BAD_REQUEST)
        user = User.objects.filter(pk=request.data.get("user")).first()
        if not user:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)
        if user.role != Role.CUSTOMER:
            return Response({"detail": "Only customer-role users can be linked to a customer."},
                            status=status.HTTP_400_BAD_REQUEST)
        if hasattr(user, "customer_profile"):
            return Response({"detail": "That user is already linked to another customer."},
                            status=status.HTTP_400_BAD_REQUEST)
        customer.linked_user = user
        customer.login_invited_at = None
        customer.updated_by = request.user
        customer.save(update_fields=["linked_user", "login_invited_at", "updated_by", "updated_at"])
        log_event(request, "customer_login_linked",
                  {"customer": customer.customer_code, "user": user.email})
        return self._ok(customer)

    @action(detail=True, methods=["post"], url_path="disable-login")
    def disable_login(self, request, pk=None):
        customer = self.get_object()
        self._staff_guard(customer)
        if not customer.linked_user_id:
            return Response({"detail": "This customer has no login."},
                            status=status.HTTP_400_BAD_REQUEST)
        u = customer.linked_user
        u.is_active = False
        u.save(update_fields=["is_active"])
        log_event(request, "customer_login_disabled",
                  {"customer": customer.customer_code, "user": u.email})
        return self._ok(customer)

    @action(detail=True, methods=["post"], url_path="enable-login")
    def enable_login(self, request, pk=None):
        customer = self.get_object()
        self._staff_guard(customer)
        if not customer.linked_user_id:
            return Response({"detail": "This customer has no login."},
                            status=status.HTTP_400_BAD_REQUEST)
        u = customer.linked_user
        u.is_active = True
        u.save(update_fields=["is_active"])
        log_event(request, "customer_login_enabled",
                  {"customer": customer.customer_code, "user": u.email})
        return self._ok(customer)


class AddressViewSet(viewsets.ModelViewSet):
    queryset = Address.objects.select_related("customer", "customer__linked_user").all()
    serializer_class = AddressSerializer
    permission_classes = [permissions.IsAuthenticated, AddressObjectPermission]
    filterset_fields = ["customer", "label", "is_default"]

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.user.role in STAFF_ROLES:
            return qs
        return qs.filter(customer__linked_user=self.request.user)


class LoyaltyLedgerViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = LoyaltyLedger.objects.select_related("customer", "created_by").all()
    serializer_class = LoyaltyLedgerSerializer
    permission_classes = [permissions.IsAuthenticated]
    filterset_fields = ["customer", "txn_type", "source"]

    def get_queryset(self):
        qs = super().get_queryset()
        user = self.request.user
        if user.role not in STAFF_ROLES:
            return qs.filter(customer__linked_user=user)
        # Staff need the dedicated ledger-view capability.
        if not user.has_perm_code("loyalty.view_ledger"):
            return qs.none()
        return qs

    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        """Reverse a single ledger entry (writes the opposite). Requires
        `loyalty.reverse`."""
        if not request.user.has_perm_code("loyalty.reverse"):
            return Response({"detail": access.denial_message("loyalty", "reverse")},
                            status=status.HTTP_403_FORBIDDEN)
        entry = self.get_object()
        from apps.loyalty.services import reverse_ledger_entry
        reverse_ledger_entry(entry, actor=request.user, request=request)
        return Response({"ok": True})
