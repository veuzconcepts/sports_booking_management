from django.urls import path

from .views import GuestBookingView, LoginView, OtpRequestView, OtpVerifyView, SignupView

urlpatterns = [
    path("otp/request/", OtpRequestView.as_view(), name="customer_otp_request"),
    path("otp/verify/", OtpVerifyView.as_view(), name="customer_otp_verify"),
    path("signup/", SignupView.as_view(), name="customer_signup"),
    path("login/", LoginView.as_view(), name="customer_login"),
    path("guest-booking/", GuestBookingView.as_view(), name="customer_guest_booking"),
]
