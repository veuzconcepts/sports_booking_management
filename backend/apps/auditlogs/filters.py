import django_filters

from .models import AuditLog


class AuditLogFilter(django_filters.FilterSet):
    date_from = django_filters.DateFilter(field_name="created_at", lookup_expr="date__gte")
    date_to = django_filters.DateFilter(field_name="created_at", lookup_expr="date__lte")
    # Filter on the semantic domain event stored inside payload_summary.
    event = django_filters.CharFilter(method="filter_event")

    class Meta:
        model = AuditLog
        fields = {
            "method": ["exact"],
            "actor": ["exact"],
            "status_code": ["exact"],
        }

    def filter_event(self, queryset, name, value):
        return queryset.filter(payload_summary__event=value)
