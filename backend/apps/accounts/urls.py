from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    ChangePasswordView,
    CookieTokenRefreshView,
    CsrfView,
    IdleEventView,
    LoginView,
    LogoutView,
    MeView,
    MfaConfirmView,
    MfaDisableView,
    MfaSetupView,
    PermissionCatalogView,
    RegisterView,
    RoleDetailView,
    RoleDuplicateView,
    RoleListView,
    SessionViewSet,
    UserViewSet,
)

router = DefaultRouter()
router.register("users", UserViewSet, basename="user")
router.register("sessions", SessionViewSet, basename="session")

urlpatterns = [
    path("csrf/", CsrfView.as_view(), name="csrf"),
    path("login/", LoginView.as_view(), name="login"),
    path("logout/", LogoutView.as_view(), name="logout"),
    path("refresh/", CookieTokenRefreshView.as_view(), name="refresh"),
    path("register/", RegisterView.as_view(), name="register"),
    path("me/", MeView.as_view(), name="me"),
    path("change-password/", ChangePasswordView.as_view(), name="change_password"),
    path("idle-event/", IdleEventView.as_view(), name="idle_event"),
    path("permissions-catalog/", PermissionCatalogView.as_view(), name="permissions_catalog"),
    path("roles/", RoleListView.as_view(), name="role_list"),
    path("roles/<str:role>/duplicate/", RoleDuplicateView.as_view(), name="role_duplicate"),
    path("roles/<str:role>/", RoleDetailView.as_view(), name="role_detail"),
    path("mfa/setup/", MfaSetupView.as_view(), name="mfa_setup"),
    path("mfa/confirm/", MfaConfirmView.as_view(), name="mfa_confirm"),
    path("mfa/disable/", MfaDisableView.as_view(), name="mfa_disable"),
    path("", include(router.urls)),
]
