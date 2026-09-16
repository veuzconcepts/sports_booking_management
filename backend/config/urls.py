"""Root URL configuration for the Club & Facility Booking Management System."""

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import (
    SpectacularAPIView,
    SpectacularRedocView,
    SpectacularSwaggerView,
)

api_v1_patterns = [
    path("auth/", include("apps.accounts.urls")),
    path("customers/", include("apps.customers.urls")),
    path("loyalty/", include("apps.loyalty.urls")),
    path("clubs/", include("apps.clubs.urls")),
    path("facilities/", include("apps.facilities.urls")),
    path("bookings/", include("apps.bookings.urls")),
    path("staff/", include("apps.staff.urls")),
    path("payments/", include("apps.payments.urls")),
    path("reports/", include("apps.reports.urls")),
    path("settings/", include("apps.settings_app.urls")),
    path("notifications/", include("apps.notifications.urls")),
    path("auditlogs/", include("apps.auditlogs.urls")),
    path("promotions/", include("apps.promotions.urls")),
    path("customer-auth/", include("apps.customer_auth.urls")),
    path("website/", include("apps.website.urls")),
]

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", include(api_v1_patterns)),
    # Full schema (every endpoint) — Super Admin only, per SPECTACULAR_SETTINGS.
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger"),
    path("api/redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
