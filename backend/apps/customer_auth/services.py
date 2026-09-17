"""Customer mobile-auth business logic.

All flows here produce / authenticate **customer-role** users only and issue
JWTs in the response body (client-agnostic - the calling client stores them; there
are no cookies and no web portal). Staff/admin accounts can never be created or
authenticated through here, and a customer token never grants admin access
(customers hold no admin capabilities).
"""

import secrets
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts.models import Role
from apps.accounts.security import generate_password
from apps.customers.models import Customer

from .models import OTP_LENGTH, OTP_MAX_ATTEMPTS, OTP_TTL_MINUTES, OtpChannel, OtpCode
from .otp_delivery import send_otp

User = get_user_model()


class CustomerAuthError(Exception):
    """Raised for any recoverable customer-auth failure (mapped to HTTP 400)."""


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _norm(channel: str, identifier: str) -> str:
    identifier = (identifier or "").strip()
    return identifier.lower() if channel == OtpChannel.EMAIL else identifier


def _login_email(channel, identifier, customer) -> str:
    """A real email when we have one; otherwise a synthetic phone-based address
    (the User model is email-keyed, but phone-only customers still need a login)."""
    if customer and customer.email:
        return customer.email.lower()
    if channel == OtpChannel.EMAIL:
        return identifier.lower()
    digits = "".join(ch for ch in (identifier or "") if ch.isalnum())
    return f"{digits}@phone.invalid"


def issue_tokens(user) -> dict:
    refresh = RefreshToken.for_user(user)
    return {"access": str(refresh.access_token), "refresh": str(refresh)}


def _get_or_create_customer(channel, identifier, full_name):
    field = "mobile_number" if channel == OtpChannel.PHONE else "email"
    customer = Customer.objects.filter(**{field: identifier}).first()
    if customer:
        if full_name and not customer.full_name:
            customer.full_name = full_name
            customer.save(update_fields=["full_name", "updated_at"])
        return customer
    return Customer.objects.create(full_name=full_name or "", **{field: identifier})


def _ensure_customer_user(customer, channel, identifier):
    """Return the customer's login User, creating + linking one if absent."""
    if customer.linked_user_id:
        return customer.linked_user
    email = _login_email(channel, identifier, customer)
    if User.objects.filter(email__iexact=email).exists():
        raise CustomerAuthError("An account already exists for this contact. Please log in.")
    first = (customer.full_name or "Customer").split(" ")[0]
    user = User.objects.create_user(
        email=email, password=generate_password(),
        first_name=first, last_name="",
        phone=customer.mobile_number or "", role=Role.CUSTOMER,
    )
    customer.linked_user = user
    customer.login_invited_at = None
    if channel == OtpChannel.EMAIL and not customer.email:
        customer.email = identifier
    customer.save(update_fields=["linked_user", "login_invited_at", "email", "updated_at"])
    return user


# --------------------------------------------------------------------------- #
# Flows
# --------------------------------------------------------------------------- #
def request_otp(channel, identifier):
    identifier = _norm(channel, identifier)
    if not identifier:
        raise CustomerAuthError("A phone number or email is required.")
    code = f"{secrets.randbelow(10 ** OTP_LENGTH):0{OTP_LENGTH}d}"
    OtpCode.objects.create(
        channel=channel, identifier=identifier, code_hash=make_password(code),
        expires_at=timezone.now() + timedelta(minutes=OTP_TTL_MINUTES),
    )
    send_otp(channel, identifier, code)
    return True


@transaction.atomic
def consume_otp(channel, identifier, code):
    """Verify + consume the latest OTP for this contact. Raises on failure.

    Returns the normalized identifier. Does NOT create any User/Customer — that
    is the caller's choice (login flow vs guest checkout)."""
    identifier = _norm(channel, identifier)
    otp = (OtpCode.objects
           .filter(channel=channel, identifier=identifier, consumed_at__isnull=True)
           .order_by("-created_at").first())
    if not otp or otp.is_expired:
        raise CustomerAuthError("Code expired or not found. Request a new one.")
    if otp.attempts >= OTP_MAX_ATTEMPTS:
        raise CustomerAuthError("Too many attempts. Request a new code.")
    if not otp.check_code((code or "").strip()):
        otp.attempts += 1
        otp.save(update_fields=["attempts"])
        raise CustomerAuthError("Invalid code.")
    otp.consumed_at = timezone.now()
    otp.save(update_fields=["consumed_at"])
    return identifier


@transaction.atomic
def verify_otp(channel, identifier, code, full_name=""):
    """OTP login flow: verify, then find/create the Customer + provision a login.

    Returns (customer, user). (Guest checkout uses `consume_otp` instead, which
    creates no login.)"""
    identifier = consume_otp(channel, identifier, code)
    customer = _get_or_create_customer(channel, identifier, full_name)
    user = _ensure_customer_user(customer, channel, identifier)
    if not user.api_login_enabled:
        raise CustomerAuthError(
            "API access is disabled for this account. Please contact support.")
    return customer, user


def get_or_create_guest_customer(channel, identifier, full_name=""):
    """Find/create a Customer with NO login (guest checkout)."""
    return _get_or_create_customer(channel, _norm(channel, identifier), full_name)


@transaction.atomic
def signup(full_name, email="", mobile="", password=None):
    email = (email or "").strip().lower()
    mobile = (mobile or "").strip()
    if not (email or mobile):
        raise CustomerAuthError("Email or mobile number is required.")

    # Enforce the configured password policy (length/common/numeric) when the
    # customer sets a password — same strength rules as staff accounts.
    if password:
        from django.contrib.auth.password_validation import validate_password
        from django.core.exceptions import ValidationError as DjValidationError
        try:
            validate_password(password)
        except DjValidationError as exc:
            raise CustomerAuthError(" ".join(exc.messages))

    existing = None
    if mobile:
        existing = Customer.objects.filter(mobile_number=mobile).first()
    if not existing and email:
        existing = Customer.objects.filter(email__iexact=email).first()
    if existing and existing.linked_user_id:
        raise CustomerAuthError("An account already exists. Please log in.")

    customer = existing or Customer.objects.create(
        full_name=full_name or "", email=email, mobile_number=mobile,
    )
    if full_name and not customer.full_name:
        customer.full_name = full_name
        customer.save(update_fields=["full_name", "updated_at"])

    login_email = email or _login_email(OtpChannel.PHONE, mobile, customer)
    if User.objects.filter(email__iexact=login_email).exists():
        raise CustomerAuthError("An account already exists. Please log in.")
    first = (full_name or "Customer").split(" ")[0]
    user = User.objects.create_user(
        email=login_email, password=password or generate_password(),
        first_name=first, last_name="", phone=mobile, role=Role.CUSTOMER,
    )
    customer.linked_user = user
    customer.login_invited_at = None
    customer.save(update_fields=["linked_user", "login_invited_at", "updated_at"])
    return customer, user


def login(identifier, password):
    identifier = (identifier or "").strip().lower()
    user = User.objects.filter(email__iexact=identifier).first()
    if not user:
        c = Customer.objects.filter(mobile_number=identifier).first()
        user = c.linked_user if (c and c.linked_user_id) else None
    if not user or not user.is_active or not user.check_password(password or ""):
        raise CustomerAuthError("Invalid credentials.")
    if user.role != Role.CUSTOMER:
        raise CustomerAuthError("This is a staff account - use the admin panel to sign in.")
    if not user.api_login_enabled:
        raise CustomerAuthError(
            "API access is disabled for this account. Please contact support.")
    return user
