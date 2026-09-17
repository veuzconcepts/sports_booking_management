"""Customer duplicate detection + safe merge.

A merge re-maps EVERY record that points at the merged ("source") customer onto
the survivor ("target"), resolving conflicts in the survivor's favour, so nothing
is left behind and no row is orphaned. The source is then deleted; the survivor
keeps its customer number.
"""

from django.db import transaction
from django.db.models import Q

# Survivor's blank profile fields are backfilled from the source (no data loss);
# never overwrites a value the survivor already has. Email/mobile are included so a
# survivor missing one inherits it — but the survivor's own values always win.
# `notes` is handled separately (appended, not fill-only) so no note is ever lost.
_PROFILE_FILL_FIELDS = (
    "full_name", "email", "mobile_number", "whatsapp_number", "trn",
    "address", "city", "area", "gender", "nationality", "preferred_language",
    "date_of_birth", "customer_type", "source",
)

# Human-friendly labels for the audit trail's "fields populated" list.
_FIELD_LABELS = {
    "full_name": "Name", "email": "Email", "mobile_number": "Mobile number",
    "whatsapp_number": "WhatsApp number", "trn": "TRN", "address": "Address",
    "city": "City", "area": "Area", "gender": "Gender", "nationality": "Nationality",
    "preferred_language": "Preferred language", "date_of_birth": "Date of birth",
    "customer_type": "Customer type", "source": "Source", "notes": "Notes",
}


def verify_customer(customer, *, method, actor=None, request=None):
    """Mark a customer verified (idempotent) and record who/when/how in the audit
    trail. `method` is a VerificationMethod value. Safe to call from the booking
    flow (system-driven) or the manual Verify action. Returns True if this call
    flipped the customer to verified, False if already verified."""
    from django.utils import timezone

    from .models import VerificationMethod  # noqa: F401 (kept for callers/validation)

    if customer.is_verified:
        return False
    customer.is_verified = True
    customer.verified_at = timezone.now()
    customer.verified_by = actor
    customer.verification_method = method
    customer.save(update_fields=["is_verified", "verified_at", "verified_by",
                                 "verification_method", "updated_at"])

    # str() the choice label — choices values are lazy gettext proxies that aren't
    # JSON-serializable when written to the audit payload.
    label = str(dict(VerificationMethod.choices).get(method, method))
    summary = {"changes": {"Verification": {"from": "Unverified", "to": label}},
               "method": str(method)}
    try:
        if request is not None:
            from apps.auditlogs.services import log_event
            log_event(request, "customer_verified", summary, actor=actor,
                      subject=("customer", customer.id))
        else:
            from apps.auditlogs.services import log_system_event
            log_system_event("customer_verified", summary, actor=actor,
                             subject=("customer", customer.id))
    except Exception:  # pragma: no cover - auditing must never break the flow
        pass
    return True


def duplicate_customers_qs(customer):
    """Other customers sharing this one's email (case-insensitive) or mobile."""
    from .models import Customer
    q = Q()
    email = (customer.email or "").strip()
    phone = (customer.mobile_number or "").strip()
    if email:
        q |= Q(email__iexact=email)
    if phone:
        q |= Q(mobile_number=phone)
    if not q:
        return Customer.objects.none()
    return Customer.objects.filter(q).exclude(pk=customer.pk).order_by("id")


def duplicate_match_field(target, other) -> str:
    """Which field links `other` to `target` ('email' / 'phone' / 'email & phone')."""
    bits = []
    if (target.email or "").strip() and (other.email or "").strip().lower() == (target.email or "").strip().lower():
        bits.append("email")
    if (target.mobile_number or "").strip() and (other.mobile_number or "").strip() == (target.mobile_number or "").strip():
        bits.append("phone")
    return " & ".join(bits) if bits else "-"


@transaction.atomic
def merge_customers(target, sources, *, request=None):
    """Merge each customer in `sources` INTO `target` (the survivor). Re-maps EVERY
    related record (directly, or transitively via bookings/payments/memberships so
    refunds and usage follow), resolves conflicts in the survivor's
    favour, sums balances, backfills blank profile fields, moves the activity log,
    then deletes the sources. Records the whole operation in the audit trail.
    Returns (target, audit_payload)."""
    from apps.auditlogs.models import AuditLog
    from apps.bookings.models import Booking
    from apps.payments.models import CreditNote, Invoice, Membership, Payment, Receipt, Wallet

    from .models import Address, LoyaltyLedger

    sources = [s for s in sources if s and s.pk != target.pk]
    merged = []
    counts = {}          # record type -> rows moved onto the survivor
    fields_filled = set()

    def _bump(key, n):
        if n:
            counts[key] = counts.get(key, 0) + n

    for source in sources:
        # Plain FK re-points (covers PROTECT relations too, so the source can later
        # be deleted cleanly with no orphans). Refunds and membership
        # balances/usage follow Payments/Memberships - no direct customer FK, so
        # they move transitively with their parent.
        _bump("Bookings", Booking.objects.filter(customer=source).update(customer=target))
        _bump("Addresses", Address.objects.filter(customer=source).update(customer=target))
        _bump("Loyalty entries", LoyaltyLedger.objects.filter(customer=source).update(customer=target))
        _bump("Memberships", Membership.objects.filter(customer=source).update(customer=target))
        _bump("Payments", Payment.objects.filter(customer=source).update(customer=target))
        _bump("Invoices", Invoice.objects.filter(customer=source).update(customer=target))
        _bump("Receipts", Receipt.objects.filter(customer=source).update(customer=target))
        _bump("Credit notes", CreditNote.objects.filter(customer=source).update(customer=target))
        try:
            from apps.promotions.models import PromoCodeUsage
            _bump("Promo redemptions", PromoCodeUsage.objects.filter(customer=source).update(customer=target))
        except Exception:  # pragma: no cover - promo usage model optional
            pass

        # Wallet (one-to-one): add balances + move transactions, or move it over.
        src_wallet = Wallet.objects.filter(customer=source).first()
        if src_wallet:
            tgt_wallet = Wallet.objects.filter(customer=target).first()
            if tgt_wallet:
                tgt_wallet.balance = (tgt_wallet.balance or 0) + (src_wallet.balance or 0)
                tgt_wallet.save(update_fields=["balance"])
                _bump("Wallet transactions", src_wallet.transactions.update(wallet=tgt_wallet))
                src_wallet.delete()
            else:
                src_wallet.customer = target
                src_wallet.save(update_fields=["customer"])
                _bump("Wallets", 1)

        # Activity Log: move the source's audit history onto the survivor so the
        # timeline is preserved (these are subject_type/subject_id, not FKs).
        _bump("Activity log entries",
              AuditLog.objects.filter(subject_type="customer", subject_id=str(source.id))
              .update(subject_id=str(target.id)))

        # Carry the login if the survivor has none.
        if source.linked_user_id and not target.linked_user_id:
            target.linked_user = source.linked_user
            source.linked_user = None
            source.save(update_fields=["linked_user"])
            fields_filled.add("Login")

        # Backfill the survivor's blank profile fields (never overwrite existing).
        for f in _PROFILE_FILL_FIELDS:
            if not getattr(target, f, None) and getattr(source, f, None):
                setattr(target, f, getattr(source, f))
                fields_filled.add(_FIELD_LABELS.get(f, f))
        # Notes: append (not fill-only) so a source note is never lost.
        src_notes = (source.notes or "").strip()
        if src_notes and src_notes not in (target.notes or ""):
            target.notes = (f"{target.notes}\n{src_notes}" if (target.notes or "").strip() else src_notes)
            fields_filled.add(_FIELD_LABELS["notes"])
        # Sum balances/points + lifetime loyalty aggregates (history preserved:
        # the source's LoyaltyLedger rows were already re-pointed above).
        target.loyalty_points = (target.loyalty_points or 0) + (source.loyalty_points or 0)
        target.lifetime_value = (target.lifetime_value or 0) + (source.lifetime_value or 0)
        target.loyalty_points_earned = (target.loyalty_points_earned or 0) + (source.loyalty_points_earned or 0)
        target.loyalty_points_redeemed = (target.loyalty_points_redeemed or 0) + (source.loyalty_points_redeemed or 0)
        target.loyalty_points_expired = (target.loyalty_points_expired or 0) + (source.loyalty_points_expired or 0)
        target.loyalty_spend = (target.loyalty_spend or 0) + (source.loyalty_spend or 0)

        merged.append({"id": source.id, "code": source.customer_code, "name": source.full_name})
        source.delete()

    target.save()

    # A MERGED ledger marker on the survivor + tier recompute on the combined totals.
    if merged:
        try:
            from apps.customers.models import LoyaltyLedger, LoyaltySource, LoyaltyTxnType
            LoyaltyLedger.objects.create(
                customer=target, txn_type=LoyaltyTxnType.MERGED, points=0,
                balance_before=target.loyalty_points, balance_after=target.loyalty_points,
                source=LoyaltySource.MERGE,
                note=f"Merged {len(merged)} record(s) into {target.customer_code}",
                created_by=getattr(request, "user", None) if request is not None else None)
            from apps.loyalty.services import recompute_tier
            recompute_tier(target, request=request)
        except Exception:  # pragma: no cover - loyalty must never break a merge
            pass

    records_str = ", ".join(f"{v} {k.lower()}" for k, v in counts.items()) or "none"
    fields_str = ", ".join(sorted(fields_filled)) or "none"
    payload = {
        "keep": {"id": target.id, "code": target.customer_code, "name": target.full_name},
        "merged": merged,
        "records": counts,
        "fields_populated": sorted(fields_filled),
        # `changes` drives the human-readable Activity Log "Details" column.
        "changes": {
            "Merged into": {"from": ", ".join(m["code"] or m["name"] or str(m["id"]) for m in merged),
                            "to": target.customer_code or target.full_name},
            "Records transferred": records_str,
            "Fields populated": fields_str,
        },
    }
    if merged and request is not None:
        from apps.auditlogs.services import log_event
        log_event(request, "customer_merged", payload, subject=("customer", target.id))
    return target, payload
