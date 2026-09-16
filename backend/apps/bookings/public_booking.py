"""Shared public/self-service booking creation.

The single source of truth for creating a booking from the customer-facing
website. It performs field + contact validation, a slot re-check, OTP-token
gating (guest) OR trusted logged-in customer, race-safe customer resolution, and
pricing via the same `BookingCreateSerializer` the admin uses. Returns
`(status_code, payload)` so the calling view just wraps it in a `Response`.
"""

from datetime import date as date_cls, time as time_cls
from decimal import Decimal, InvalidOperation

from django.db import transaction

from apps.auditlogs.services import log_event

_COORD_BOUNDS = {"latitude": Decimal("90"), "longitude": Decimal("180")}


def _coord(value, kind):
    """Parse a latitude/longitude into a bounded Decimal, or None. Raises ValueError
    on an out-of-range / unparseable value so the caller can 400."""
    if value in (None, ""):
        return None
    try:
        dec = Decimal(str(value))
    except (InvalidOperation, TypeError):
        raise ValueError(kind)
    if abs(dec) > _COORD_BOUNDS[kind]:
        raise ValueError(kind)
    return dec


def _haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in km - good enough to rank clubs by nearness."""
    from math import asin, cos, radians, sin, sqrt
    lat1, lon1, lat2, lon2 = map(lambda v: radians(float(v)), (lat1, lon1, lat2, lon2))
    h = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371 * asin(sqrt(h))


def _resolve_club(d, latitude, longitude):
    """The club a booking belongs to, as `(club, error_response)`.

    Every booking is filed against a club - it scopes facility capacity, opening
    hours, club pricing rules and every club report. Normally the customer picks
    it, but the server can fill in the obvious answer:

      1. an explicit `club`, when the client sent one;
      2. the only active club, when the organization runs one (the common case);
      3. the club nearest the supplied coordinates;
      4. otherwise ask - several clubs and no coordinates is genuinely ambiguous.

    Staff can always reassign afterwards; this only picks the sensible default.
    """
    from apps.clubs.models import Club

    if str(d.get("club") or "").strip():
        club = Club.objects.filter(pk=d.get("club"), is_active=True).first()
        if not club:
            return None, (404, {"detail": "Club not found"})
        return club, None

    clubs = list(Club.objects.filter(is_active=True))
    if not clubs:
        return None, (404, {"detail": "Club not found"})
    if len(clubs) == 1:
        return clubs[0], None

    if latitude is not None and longitude is not None:
        located = [c for c in clubs if c.latitude is not None and c.longitude is not None]
        if located:
            return min(located, key=lambda c: _haversine_km(
                latitude, longitude, c.latitude, c.longitude)), None

    return None, (400, {"detail": "Please choose a club for this booking"})


def _update_reused_customer(request, customer, *, name, via, by_label):
    """A returning customer may edit their display name on a self-service booking.
    Persist it + record in the Customer Activity Log. Email/mobile are the record's
    identity and are NEVER changed here (admin-only). Returns True if it changed."""
    new_name = (name or "").strip()
    if not new_name or new_name == (customer.full_name or ""):
        return False
    changes = {"full_name": {"from": customer.full_name or "", "to": new_name}}
    customer.full_name = new_name
    customer.save(update_fields=["full_name", "updated_at"])
    log_event(request, "customer_updated",
              {"changes": changes, "via": via, "by_label": by_label},
              subject=("customer", customer.id))
    return True


def create_public_booking(data, *, request, source="website",
                          authenticated_customer=None, customer_source="web",
                          update_via="website_booking", update_by_label="Customer (website)"):
    """Create a booking from a self-service channel.

    - Guest (authenticated_customer=None): a configured-unique contact that already
      exists must be proven by a signed `verification_token` (issued after OTP).
    - Logged-in (authenticated_customer set): the trusted customer is used directly;
      no OTP/uniqueness gate. Missing name/phone/email default from their profile.

    `source` tags `Booking.source`. Returns `(status_code, payload_dict)`."""
    from apps.bookings import contacts, services as booking_services
    from apps.bookings.models import ACTIVE_STATUSES, Booking
    from apps.bookings.serializers import BookingCreateSerializer
    from apps.customers.models import Customer
    from apps.facilities.models import FacilityType
    from apps.settings_app.models import BookingConfiguration

    d = data

    # Optional map coordinates (used only to pick the nearest club).
    try:
        latitude = _coord(d.get("latitude"), "latitude")
        longitude = _coord(d.get("longitude"), "longitude")
    except ValueError as exc:
        return 400, {"detail": f"Invalid {exc} value"}

    # Effective contact/name - default from the logged-in profile when omitted.
    name = str(d.get("name") or (authenticated_customer.full_name if authenticated_customer else "")).strip()
    phone = str(d.get("phone") or (authenticated_customer.mobile_number if authenticated_customer else "")).strip()
    email = str(d.get("email") or (authenticated_customer.email if authenticated_customer else "")).strip()

    required = ["facility_type", "club", "date", "time", "name"]
    eff = {**{k: d.get(k) for k in required}, "name": name}
    missing = [k for k in required if not str(eff.get(k, "") or "").strip()]
    if missing:
        return 400, {"detail": f"Please fill in: {', '.join(missing)}"}

    try:
        on_date = date_cls.fromisoformat(str(d["date"]))
        at_time = time_cls.fromisoformat(str(d["time"]))
    except (ValueError, TypeError):
        return 400, {"detail": "Invalid date or time"}

    item = FacilityType.objects.filter(
        pk=d.get("facility_type"), is_active=True, online_booking_enabled=True).first()
    if not item:
        return 404, {"detail": "This facility isn't available for booking"}
    club, club_error = _resolve_club(d, latitude, longitude)
    if club_error:
        return club_error
    # Booking policy (lead time, horizon, per-customer caps) before anything is
    # written. Self-service always binds; the customer is known only for a
    # logged-in booking, so guest caps are checked again after resolution below.
    rule_errors = booking_services.check_booking_rules(
        club=club, on_date=on_date, at_time=at_time,
        customer=authenticated_customer, staff_booking=False)
    if rule_errors:
        return 400, {"detail": " ".join(rule_errors), "rules": rule_errors}

    if not booking_services.slot_is_available(
            on_date, at_time, club=club, facility_type=item):
        return 409, {"detail": "That time slot was just taken - please pick another"}

    rules = contacts.rules_for("website")
    contact_errs = contacts.missing_required(rules, email=email, phone=phone)
    if contact_errs:
        labels = []
        if "phone" in contact_errs:
            labels.append("mobile number")
        if "email" in contact_errs:
            labels.append("email")
        return 400, {"detail": f"Please provide your {' and '.join(labels)}", "fields": contact_errs}
    if phone and not contacts.phone_is_valid(phone):
        return 400, {"detail": "Enter a valid phone number with its country code"}
    if email and not contacts.email_looks_real(email):
        return 400, {"detail": "Please enter a valid email, or leave it blank"}

    token = str(d.get("verification_token") or "").strip()
    token_data = contacts.read_verification_token(token, email=email, phone=phone)

    valid_addon_ids = set(item.add_ons.filter(is_active=True).values_list("id", flat=True))
    addon_ids = [int(x) for x in (d.get("add_ons") or [])
                 if str(x).isdigit() and int(x) in valid_addon_ids]
    coupon = str(d.get("coupon") or d.get("promo") or "").strip()

    with transaction.atomic():
        # Serialise the customer-resolution critical section across concurrent
        # self-service bookings (lock the single config row).
        BookingConfiguration.objects.select_for_update().first()

        if authenticated_customer is not None:
            # Trusted, logged-in customer - no OTP/uniqueness gate.
            customer = Customer.objects.select_for_update().get(pk=authenticated_customer.pk)
            customer_was_new = False
            customer_info_updated = _update_reused_customer(
                request, customer, name=name, via=update_via, by_label=update_by_label)
        else:
            # Guest: a unique-contact conflict must be covered by a verification token
            # for the SAME field (email priority).
            conflict = contacts.find_conflict(rules, email=email, phone=phone)
            covered = bool(token_data) and token_data.get("field") == (conflict or {}).get("field")
            if conflict and not covered:
                label = "mobile number" if conflict["field"] == "phone" else "email"
                return 409, {
                    "detail": f"This {label} is already registered. Verify the code to continue with your existing details.",
                    "duplicate": {"field": conflict["field"], "masked": conflict["masked"]},
                    "needs_otp": True,
                }
            customer = None
            if conflict and conflict["source"] == "customer" and conflict["customer_id"]:
                customer = Customer.objects.select_for_update().filter(pk=conflict["customer_id"]).first()
            if customer is None and phone:
                customer = Customer.objects.select_for_update().filter(mobile_number=phone).first()
            if customer is None and email:
                customer = Customer.objects.select_for_update().filter(email__iexact=email).first()
            customer_was_new = customer is None
            customer_info_updated = False
            if customer is None:
                customer = Customer.objects.create(
                    full_name=name, mobile_number=phone, email=email, source=customer_source)
            else:
                customer_info_updated = _update_reused_customer(
                    request, customer, name=name, via=update_via, by_label=update_by_label)

        # Idempotency: same customer can't double-book the same club + slot.
        if Booking.objects.filter(
            customer=customer, club=club, scheduled_date=on_date,
            scheduled_time=at_time, status__in=ACTIVE_STATUSES,
        ).exists():
            return 409, {"detail": "You already have a booking for this club and time"}

        # Per-customer caps, now that a guest's Customer row exists: a returning
        # guest who books under an existing record must respect their limits.
        cap_errors = booking_services.check_booking_rules(
            club=club, on_date=on_date, at_time=at_time,
            customer=customer, staff_booking=False)
        if cap_errors:
            return 400, {"detail": " ".join(cap_errors), "rules": cap_errors}

        payload = {
            "booking_type": "advance", "source": source,
            "customer": customer.id,
            "facility_type": item.id, "club": club.id, "add_ons": addon_ids,
            "scheduled_date": on_date.isoformat(), "scheduled_time": at_time.strftime("%H:%M"),
            "customer_notes": str(d.get("notes") or "").strip(),
        }
        if coupon:
            payload["promo_code_input"] = coupon
        ser = BookingCreateSerializer(data=payload, context={"request": request})
        ser.is_valid(raise_exception=True)
        booking = ser.save()
        booking.customer_was_new = customer_was_new
        booking.customer_info_updated = customer_info_updated
        booking.save(update_fields=["customer_was_new", "customer_info_updated", "updated_at"])

    # Self-service bookings stay PENDING (Booked) until staff confirm them.
    from apps.notifications.services import notify_booking_created
    notify_booking_created(booking)

    return 201, {
        "reference": booking.reference,
        "status": booking.status,
        "scheduled_date": booking.scheduled_date.isoformat(),
        "scheduled_time": booking.scheduled_time.strftime("%H:%M"),
        "total_amount": str(booking.total_amount),
        "promo_discount": str(booking.promo_discount),
        "promo_applied": bool(booking.promo_code_id),
        "currency": booking.currency,
        "booking_id": booking.id,
    }
