from django.urls import path
from rest_framework.routers import DefaultRouter

from .ai.views import AiAskView, AiCapabilitiesView, AiExportView, AiSessionView
from .views import ReportViewSet

router = DefaultRouter()
router.register("", ReportViewSet, basename="report")

urlpatterns = [
    # AI Insights. Declared before the router so the router's catch-all detail
    # route does not swallow them.
    path("ai/capabilities/", AiCapabilitiesView.as_view(), name="ai-capabilities"),
    path("ai/ask/", AiAskView.as_view(), name="ai-ask"),
    path("ai/session/", AiSessionView.as_view(), name="ai-session"),
    path("ai/export/", AiExportView.as_view(), name="ai-export"),
    *router.urls,
]
