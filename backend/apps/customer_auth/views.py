"""Customer mobile-app auth endpoints (no web portal).

All endpoints are public (AllowAny) and return JWTs in the JSON body — the
mobile client stores them and sends `Authorization: Bearer`. Staff/admin accounts
cannot be created or authenticated here.
"""

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.auditlogs.services import log_event
from apps.customers.serializers import CustomerSerializer

from .models import OtpChannel
from .services import (
    CustomerAuthError,
    consume_otp,
    get_or_create_guest_customer,
    issue_tokens,
    login,
    request_otp,
    signup,
    verify_otp,
)


def _customer_payload(customer, user):
    return {**issue_tokens(user), "customer": CustomerSerializer(customer).data}


class _PublicAuthView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []           # never read an existing token here
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "customer_auth"


class OtpRequestView(_PublicAuthView):
    def post(self, request):
        channel = request.data.get("channel")
        if channel not in OtpChannel.values:
            return Response({"detail": "channel must be 'phone' or 'email'."},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            request_otp(channel, request.data.get("identifier"))
        except CustomerAuthError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        # Always respond the same way — don't reveal whether the contact exists.
        return Response({"sent": True})


class OtpVerifyView(_PublicAuthView):
    def post(self, request):
        channel = request.data.get("channel")
        if channel not in OtpChannel.values:
            return Response({"detail": "channel must be 'phone' or 'email'."},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            customer, user = verify_otp(
                channel, request.data.get("identifier"),
                request.data.get("code"), full_name=request.data.get("full_name", ""),
            )
        except CustomerAuthError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        log_event(request, "customer_login_otp", {"customer": customer.customer_code}, actor=user)
        return Response(_customer_payload(customer, user))


class SignupView(_PublicAuthView):
    def post(self, request):
        try:
            customer, user = signup(
                full_name=request.data.get("full_name", ""),
                email=request.data.get("email", ""),
                mobile=request.data.get("mobile", "") or request.data.get("mobile_number", ""),
                password=request.data.get("password"),
            )
        except CustomerAuthError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        log_event(request, "customer_signup", {"customer": customer.customer_code}, actor=user)
        return Response(_customer_payload(customer, user), status=status.HTTP_201_CREATED)


class LoginView(_PublicAuthView):
    throttle_scope = "login"   # share the brute-force throttle scope

    def post(self, request):
        try:
            user = login(request.data.get("identifier"), request.data.get("password"))
        except CustomerAuthError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_401_UNAUTHORIZED)
        customer = getattr(user, "customer_profile", None)
        log_event(request, "customer_login", {"user": user.email}, actor=user)
        return Response(_customer_payload(customer, user) if customer else issue_tokens(user))


class GuestBookingView(_PublicAuthView):
    """OTP-verified guest checkout: no login is created.

    Verifies the guest's phone/email (OTP), finds/creates a Customer WITHOUT a
    login, then creates the booking through the normal engine so club / facility /
    staff-shift / pricing-rule / promo validation all apply (never bypassed).
    """

    def post(self, request):
        from apps.bookings.serializers import BookingCreateSerializer, BookingSerializer

        d = request.data
        channel = d.get("channel")
        if channel not in OtpChannel.values:
            return Response({"detail": "channel must be 'phone' or 'email'."},
                            status=status.HTTP_400_BAD_REQUEST)
        # 1. Prove the guest owns the contact (consumes the OTP; no login made).
        try:
            identifier = consume_otp(channel, d.get("identifier"), d.get("code"))
        except CustomerAuthError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        # 2. Guest Customer (no User).
        customer = get_or_create_guest_customer(channel, identifier, d.get("full_name", ""))

        # 3. Booking via the normal serializer (full validation + pricing + promo).
        booking_data = {
            "customer": customer.id,
            "facility_type": d.get("facility_type"),
            "booking_type": "advance",
            "scheduled_date": d.get("scheduled_date"), "scheduled_time": d.get("scheduled_time"),
            "club": d.get("club"), "facility": d.get("facility"),
            "add_ons": d.get("add_ons", []),
            "promo_code_input": d.get("promo_code_input", ""),
        }
        ser = BookingCreateSerializer(data=booking_data, context={"request": request})
        ser.is_valid(raise_exception=True)
        booking = ser.save()
        log_event(request, "guest_booking_created",
                  {"customer": customer.customer_code, "reference": booking.reference})
        return Response({
            "booking": BookingSerializer(booking, context={"request": request}).data,
            "customer": CustomerSerializer(customer).data,
        }, status=status.HTTP_201_CREATED)
