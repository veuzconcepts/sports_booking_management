"""Shared contact (email / phone) rules for the three booking channels.

A single source of truth for: required-field enforcement, hard uniqueness
(no duplicate record allowed for a contact configured unique), duplicate lookup
(across registered Customers AND past walk-in snapshots), the dummy OTP check,
and the "prepopulate the existing record" payload. Used by the public website
booking, the admin booking serializer and the admin customer form so the rules
are enforced server-side everywhere and cannot be bypassed.
"""

import re

from django.core import signing
from django.core.exceptions import ValidationError as DjValidationError
from django.core.validators import validate_email

# Dummy OTP until the real SMS/email OTP is wired in. Reusing an existing record
# on the public website requires this code.
DUMMY_OTP = "1111"

# Signed, short-lived proof that the OTP was verified for a specific contact. The
# booking endpoint trusts THIS (not a raw OTP), so reuse can't be replayed for an
# arbitrary contact and a changed unique field invalidates it automatically.
_OTP_SALT = "bookings.contact.otp.v1"
OTP_TOKEN_MAX_AGE = 15 * 60   # seconds

_PHONE_RE = re.compile(r"\+[1-9]\d{7,14}")

# Obvious throwaway / placeholder email domains (kept in sync with the public club).
_JUNK_EMAIL_DOMAINS = frozenset({
    "test.com", "test.test", "example.com", "example.org", "example.net", "domain.com",
    "mailinator.com", "tempmail.com", "temp-mail.org", "10minutemail.com", "guerrillamail.com",
    "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com",
    "maildrop.cc", "fakeinbox.com", "throwawaymail.com", "mailnesia.com", "tempmail.net", "mintemail.com",
})

CHANNELS = ("website", "admin", "walkin")


def _clean(v) -> str:
    return (v or "").strip()


# --------------------------------------------------------------------------- #
# Format validation
# --------------------------------------------------------------------------- #
def phone_is_valid(phone) -> bool:
    """E.164: a leading + then country code and 7–14 more digits."""
    return bool(_PHONE_RE.fullmatch(_clean(phone)))


def email_looks_real(email) -> bool:
    """Reject malformed and obvious throwaway/test emails. Blank passes (callers
    enforce 'required' separately)."""
    value = _clean(email).lower()
    if not value:
        return True
    try:
        validate_email(value)
    except DjValidationError:
        return False
    domain = value.rsplit("@", 1)[-1]
    if domain in _JUNK_EMAIL_DOMAINS:
        return False
    return not domain.startswith(("test.", "example.", "sample.", "demo."))


def otp_is_valid(otp) -> bool:
    return _clean(otp) == DUMMY_OTP


def normalize_field(field, value) -> str:
    """Canonical comparison form for a contact value: email lower-cased; phone
    reduced to digits (so formatting/+ differences never matter)."""
    if field == "email":
        return _clean(value).lower()
    return re.sub(r"\D", "", _clean(value))


def issue_verification_token(*, customer_id, field, value) -> str:
    """A signed token proving OTP verification for ONE field ('email' or 'phone').
    `customer_id` may be None when the match was a walk-in snapshot (no Customer
    record yet)."""
    return signing.dumps(
        {"customer_id": customer_id, "field": field,
         "value": normalize_field(field, value)},
        salt=_OTP_SALT,
    )


def read_verification_token(token, *, email, phone):
    """Validate a verification token against the SUBMITTED contact. Returns the
    payload {customer_id, field, value} only if the signature is valid, unexpired,
    and the token's verified field still matches what's submitted (so changing the
    verified email/phone invalidates it). Returns None otherwise."""
    if not _clean(token):
        return None
    try:
        data = signing.loads(token, salt=_OTP_SALT, max_age=OTP_TOKEN_MAX_AGE)
    except signing.BadSignature:
        return None
    field = data.get("field")
    submitted = email if field == "email" else phone
    if data.get("value") != normalize_field(field, submitted):
        return None
    return data


# --------------------------------------------------------------------------- #
# Config access
# --------------------------------------------------------------------------- #
def rules_for(channel: str) -> dict:
    from apps.settings_app.models import BookingConfiguration
    return BookingConfiguration.get_solo().rules_for(channel)


# --------------------------------------------------------------------------- #
# Lookups (registered customers + walk-in history)
# --------------------------------------------------------------------------- #
def _customer_by_phone(phone):
    from apps.customers.models import Customer
    p = _clean(phone)
    return Customer.objects.filter(mobile_number=p).order_by("id").first() if p else None


def _customer_by_email(email):
    from apps.customers.models import Customer
    e = _clean(email)
    return Customer.objects.filter(email__iexact=e).order_by("id").first() if e else None


def _walkin_by_phone(phone):
    from apps.bookings.models import Booking
    p = _clean(phone)
    return (Booking.objects.filter(walk_in_phone=p).exclude(walk_in_phone="")
            .order_by("-created_at").first()) if p else None


def _walkin_by_email(email):
    from apps.bookings.models import Booking
    e = _clean(email)
    return (Booking.objects.filter(walk_in_email__iexact=e).exclude(walk_in_email="")
            .order_by("-created_at").first()) if e else None


def find_match(*, email=None, phone=None, check_email=True, check_phone=True):
    """First match for the given contact: returns (source, obj, field) where source
    is 'customer' | 'walkin' and field is 'email' | 'phone'. EMAIL has priority over
    phone (so when both are unique we verify/reuse by email); a registered Customer
    wins over a walk-in snapshot. (None, None, None) if none."""
    if check_email and _clean(email):
        c = _customer_by_email(email)
        if c:
            return ("customer", c, "email")
        b = _walkin_by_email(email)
        if b:
            return ("walkin", b, "email")
    if check_phone and _clean(phone):
        c = _customer_by_phone(phone)
        if c:
            return ("customer", c, "phone")
        b = _walkin_by_phone(phone)
        if b:
            return ("walkin", b, "phone")
    return (None, None, None)


# --------------------------------------------------------------------------- #
# Prefill payloads (used after OTP / when reusing an existing record)
# --------------------------------------------------------------------------- #
def customer_prefill(c) -> dict:
    addr = c.addresses.order_by("-id").first() if hasattr(c, "addresses") else None
    return {
        "customer_id": c.id,
        "name": c.full_name,
        "email": c.email,
        "phone": c.mobile_number,
        "unit": getattr(addr, "line1", "") or "",
        "community": getattr(addr, "line2", "") or "",
        "area": getattr(addr, "city", "") or "",
    }


def walkin_prefill(b) -> dict:
    return {
        "customer_id": None,
        "name": b.walk_in_name,
        "email": b.walk_in_email,
        "phone": b.walk_in_phone,
        "unit": "", "community": "", "area": "",
    }


def match_prefill(source, obj) -> dict:
    return customer_prefill(obj) if source == "customer" else walkin_prefill(obj)


def mask_email(email) -> str:
    value = _clean(email)
    local, _, domain = value.partition("@")
    if not domain:
        return "•••"
    head = local[:1] + "•••" if local else "•••"
    return f"{head}@{domain}"


def mask_phone(phone) -> str:
    p = _clean(phone)
    return f"•••• {p[-4:]}" if len(p) >= 4 else "••••"


# --------------------------------------------------------------------------- #
# Enforcement helpers
# --------------------------------------------------------------------------- #
def missing_required(rules: dict, *, email, phone) -> dict:
    """Field → message for any required contact field that's blank."""
    errs = {}
    if rules.get("email_required") and not _clean(email):
        errs["email"] = "Email is required."
    if rules.get("phone_required") and not _clean(phone):
        errs["phone"] = "Mobile number is required."
    return errs


def find_conflict(rules: dict, *, email, phone, exclude_customer_id=None):
    """The first UNIQUE-field collision for a NEW record under these rules, or None.
    Returns {field, source, customer_id, prefill, masked}. Honours hard uniqueness:
    a configured-unique contact that already exists is a conflict that must be
    resolved by reusing the existing record (never by creating a duplicate)."""
    source, obj, field = find_match(
        email=email, phone=phone,
        check_email=bool(rules.get("email_unique")),
        check_phone=bool(rules.get("phone_unique")),
    )
    if not obj:
        return None
    if source == "customer" and exclude_customer_id and obj.id == exclude_customer_id:
        return None
    prefill = match_prefill(source, obj)
    masked = mask_phone(phone) if field == "phone" else mask_email(email)
    return {
        "field": field,
        "source": source,
        "customer_id": prefill.get("customer_id"),
        "prefill": prefill,
        "masked": masked,
    }
