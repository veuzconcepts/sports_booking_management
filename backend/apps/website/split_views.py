"""Public endpoints for demo card payment and split payment.

Everything here is unauthenticated by design: a friend paying their share of a
football booking should not have to create an account. Authorisation therefore
comes entirely from the bearer token in the URL, and each view is careful to
return the minimum the payer needs.

What a payload must never contain, and why:

* the organizer's email or phone, and the other participants' contact details -
  a share link may be forwarded, so it has to be safe in the hands of a stranger;
* internal or staff notes, assigned staff, the booking's internal id, or its
  pricing breakdown beyond the one figure the payer owes;
* the raw card details of any payment, or any token other than the one the
  caller already holds.

Scope isolation comes for free: every read starts from the token, resolves to
one share, and reaches the booking only through that share. There is no path
from a token to a booking it does not belong to, so a manipulated token cannot
cross into another organization's data - it simply fails to resolve.
"""

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.payments import split as split_service
from apps.payments.gateway import CardDetails, public_payment_config
from apps.payments.models import SplitStatus


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #
def read_card(data) -> CardDetails | None:
    """Build transient card input from a request body.

    Returns None when no card was submitted. The values are used for one
    authorisation attempt and then dropped: nothing here is persisted, and the
    dataclass redacts itself so a traceback cannot leak the number.
    """
    raw = (data or {}).get("card") or {}
    if not isinstance(raw, dict):
        return None
    number = str(raw.get("number") or "").strip()
    if not number:
        return None
    expiry = str(raw.get("expiry") or "").strip()
    month, year = raw.get("expiry_month"), raw.get("expiry_year")
    if expiry and "/" in expiry:
        left, _, right = expiry.partition("/")
        month, year = left.strip(), right.strip()
    def _int(value):
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return 0
    return CardDetails(
        number=number,
        holder=str(raw.get("holder") or raw.get("name") or "").strip()[:120],
        expiry_month=_int(month),
        expiry_year=_int(year),
        cvv=str(raw.get("cvv") or raw.get("cvc") or "").strip(),
    )


def booking_summary(booking) -> dict:
    """The few booking facts a payer legitimately needs to recognise the booking."""
    return {
        "reference": booking.reference,
        "club": booking.club.name if booking.club_id else "",
        "club_city": getattr(booking.club, "city", "") if booking.club_id else "",
        "facility": booking.facility_type.name if booking.facility_type_id else "",
        "date": booking.scheduled_date.isoformat() if booking.scheduled_date else "",
        "time": booking.scheduled_time.strftime("%H:%M") if booking.scheduled_time else "",
        "end_time": booking.end_time.strftime("%H:%M") if booking.end_time else "",
        "duration_minutes": booking.duration_minutes,
        "currency": booking.currency,
    }


def share_payload(share, *, link=None) -> dict:
    """One participant, as the ORGANIZER may see them.

    Contact details are echoed back here because the organizer typed them in the
    first place; the view a FRIEND gets (`PublicSplitShareView`) never includes
    anyone's contact details, including their own organizer's.
    """
    return {
        "id": share.id,
        "name": share.display_name,
        "email": share.participant_email,
        "phone": share.participant_phone,
        "is_organizer": share.is_organizer,
        "amount": str(share.amount),
        "status": share.status,
        "paid_at": share.paid_at.isoformat() if share.paid_at else None,
        "payable": share.is_payable,
        "reminders_sent": share.reminder_count,
        "link": link,
    }


def split_payload(split, *, links=None) -> dict:
    """Payment progress for the organizer."""
    from apps.bookings.services import booking_amount_paid, booking_outstanding

    links = links or {}
    booking = split.booking
    shares = list(split.shares.all())
    paid = booking_amount_paid(booking)
    outstanding = booking_outstanding(booking)
    total = paid + outstanding
    return {
        "status": SplitStatus.EXPIRED if split.is_expired else split.status,
        "currency": split.currency,
        "expires_at": split.expires_at.isoformat(),
        "booking": booking_summary(booking),
        "total": str(total),
        "paid": str(paid),
        "outstanding": str(outstanding),
        # Guarded so a zero-total booking cannot divide by zero in the progress bar.
        "percent_paid": int((paid / total) * 100) if total > 0 else 100,
        "shares": [share_payload(s, link=links.get(s.id)) for s in shares],
    }


def _refused(exc):
    """A split refusal as a client error the website can display verbatim."""
    return Response({"detail": str(exc), "code": getattr(exc, "code", "")},
                    status=status.HTTP_400_BAD_REQUEST)


class _PublicView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_scope = "public_booking"


# --------------------------------------------------------------------------- #
# Payment configuration
# --------------------------------------------------------------------------- #
class PublicPaymentConfigView(_PublicView):
    """What payment methods the checkout may offer, decided by the backend.

    The website never decides for itself whether card payment works. When no
    provider is configured this reports `card_enabled: false` and the checkout
    offers cash only, which is what stops a misconfigured production site from
    collecting money that never reaches a gateway. Demo test cards appear here
    only while the demo adapter is genuinely active.
    """

    throttle_scope = None

    def get(self, request):
        from django.conf import settings

        config = public_payment_config()
        config["split_enabled"] = True
        config["split_minutes"] = int(getattr(settings, "SPLIT_PAYMENT_MINUTES", 60))
        config["split_max_shares"] = int(getattr(settings, "SPLIT_PAYMENT_MAX_SHARES", 20))
        return Response(config)


# --------------------------------------------------------------------------- #
# A participant's link
# --------------------------------------------------------------------------- #
class PublicSplitShareView(_PublicView):
    """What a friend sees when they open their payment link."""

    def get(self, request, token):
        share = split_service.resolve_share(token)
        if share is None:
            return Response({"detail": "This payment link is not valid.",
                             "code": "invalid_link"},
                            status=status.HTTP_404_NOT_FOUND)
        from apps.bookings.services import booking_outstanding

        split = share.split
        outstanding = booking_outstanding(split.booking)
        # An old link whose balance somebody else has already covered must say so
        # plainly rather than presenting a Pay button that would be refused.
        no_longer_required = outstanding <= 0 or split.status == SplitStatus.COMPLETED
        return Response({
            "booking": booking_summary(split.booking),
            "amount": str(share.amount),
            "currency": split.currency,
            "name": share.participant_name,
            "status": share.status,
            "payable": share.is_payable and not no_longer_required,
            "no_longer_required": no_longer_required,
            "expires_at": split.expires_at.isoformat(),
            "split_status": SplitStatus.EXPIRED if split.is_expired else split.status,
            "payment": public_payment_config(),
        })

    def post(self, request, token):
        """Pay this share. The amount is decided by the backend, never sent in."""
        card = read_card(request.data)
        try:
            share, payment = split_service.pay_share(
                token, card=card, method="card", request=request)
        except split_service.SplitError as exc:
            return _refused(exc)
        return Response({
            "status": share.status,
            "amount": str(share.amount),
            "currency": share.split.currency,
            "reference": payment.reference,
            "card_brand": payment.card_brand,
            "card_last4": payment.card_last4,
        })


# --------------------------------------------------------------------------- #
# The organizer's management link
# --------------------------------------------------------------------------- #
class PublicSplitManageView(_PublicView):
    """Payment progress, and the organizer's actions on their own split."""

    def get(self, request, token):
        split = split_service.resolve_split(token)
        if split is None:
            return Response({"detail": "This link is not valid.", "code": "invalid_link"},
                            status=status.HTTP_404_NOT_FOUND)
        return Response(split_payload(split))

    def post(self, request, token):
        """One endpoint, an explicit `action`, so every organizer action shares
        the same token check rather than repeating it across seven routes."""
        split = split_service.resolve_split(token)
        if split is None:
            return Response({"detail": "This link is not valid.", "code": "invalid_link"},
                            status=status.HTTP_404_NOT_FOUND)

        action = str(request.data.get("action") or "").strip()
        handler = {
            "pay_remaining": self._pay_remaining,
            "add_shares": self._add_shares,
            "cancel_share": self._cancel_share,
            "reissue_link": self._reissue_link,
            "remind": self._remind,
            "cancel": self._cancel,
        }.get(action)
        if handler is None:
            return Response({"detail": "Unknown action.", "code": "unknown_action"},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            return handler(request, split)
        except split_service.SplitError as exc:
            return _refused(exc)

    # -- actions ---------------------------------------------------------- #
    def _pay_remaining(self, request, split):
        card = read_card(request.data)
        payment = split_service.pay_remaining(
            split, card=card, method="card", request=request)
        split.refresh_from_db()
        payload = split_payload(split)
        payload["reference"] = payment.reference
        return Response(payload)

    def _add_shares(self, request, split):
        created, links = split_service.add_shares(
            split, request.data.get("participants"), request=request)
        split.refresh_from_db()
        return Response({
            **split_payload(split, links=links),
            "new_links": {str(s.id): split_service.share_link(links[s.id])
                          for s in created},
        })

    def _cancel_share(self, request, split):
        split_service.cancel_share(split, request.data.get("share"), request=request)
        split.refresh_from_db()
        return Response(split_payload(split))

    def _reissue_link(self, request, split):
        share, raw = split_service.regenerate_share_token(
            split, request.data.get("share"), request=request)
        return Response({"share": share.id, "link": split_service.share_link(raw)})

    def _remind(self, request, split):
        """Record a reminder and hand back the link to send.

        The project has email templates and an in-app feed but no customer-facing
        SMS or WhatsApp sender, so building an invitation dispatcher here would
        mean inventing notification infrastructure this task explicitly says not
        to duplicate. Instead the organizer shares the link themselves, and the
        rate limit still applies so a friend cannot be pestered.
        """
        share = split_service.record_reminder(split, request.data.get("share"))
        return Response({
            "share": share.id,
            "reminders_sent": share.reminder_count,
            "remaining": max(0, split_service.MAX_REMINDERS - share.reminder_count),
        })

    def _cancel(self, request, split):
        split_service.cancel_split(split, request=request)
        split.refresh_from_db()
        payload = split_payload(split)
        # Money already collected is deliberately left alone: refunding it is a
        # finance decision with its own approval path, not something a customer
        # action should trigger silently.
        payload["collected_not_refunded"] = str(split.paid_total)
        return Response(payload)


# --------------------------------------------------------------------------- #
# Paying a booking after checkout
# --------------------------------------------------------------------------- #
class PublicBookingPayView(_PublicView):
    """Settle the outstanding balance of a booking made in this checkout session.

    Exists so a customer whose card was declined can try another one without
    re-posting the booking, which the duplicate-booking guard would reject. The
    signed checkout token is the authorisation; it names one booking, expires
    with the session, and can only ever pay what that booking still owes.
    """

    def post(self, request):
        from apps.bookings.public_booking import read_checkout_token
        from apps.bookings.services import (
            PaymentDeclined, booking_outstanding, settle_booking_payment,
        )
        from apps.payments.gateway import card_payment_available

        booking = read_checkout_token(request.data.get("checkout_token"))
        if booking is None:
            return Response(
                {"detail": "This payment session has expired. Please contact the club.",
                 "code": "invalid_session"},
                status=status.HTTP_400_BAD_REQUEST)

        outstanding = booking_outstanding(booking)
        if outstanding <= 0:
            return Response({"detail": "This booking is already paid in full.",
                             "code": "nothing_due"},
                            status=status.HTTP_400_BAD_REQUEST)
        if not card_payment_available():
            return Response(
                {"detail": "Online payment is not available at the moment.",
                 "code": "payment_unavailable"},
                status=status.HTTP_400_BAD_REQUEST)

        card = read_card(request.data)
        if card is None:
            return Response({"detail": "Enter your card details to pay.",
                             "code": "missing_card"},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            payment, invoice = settle_booking_payment(
                booking, method="card", amount=outstanding, request=request, card=card)
        except PaymentDeclined as exc:
            return Response({"detail": str(exc), "code": "declined"},
                            status=status.HTTP_400_BAD_REQUEST)
        booking.refresh_from_db()
        return Response({
            "status": "paid",
            "amount": str(payment.amount),
            "reference": payment.reference,
            "invoice": invoice.number,
            "card_brand": payment.card_brand,
            "card_last4": payment.card_last4,
            "payment_status": booking.payment_status,
            "outstanding": str(booking_outstanding(booking)),
        })
