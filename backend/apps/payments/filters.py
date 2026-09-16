import django_filters

from .models import Payment


class PaymentFilter(django_filters.FilterSet):
    date_from = django_filters.DateFilter(field_name="created_at", lookup_expr="date__gte")
    date_to = django_filters.DateFilter(field_name="created_at", lookup_expr="date__lte")

    class Meta:
        model = Payment
        fields = {
            "status": ["exact"],
            "method": ["exact"],
            "customer": ["exact"],
            "booking": ["exact"],
        }
