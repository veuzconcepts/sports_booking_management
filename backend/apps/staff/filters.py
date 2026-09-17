import django_filters

from .models import Shift


class ShiftFilter(django_filters.FilterSet):
    """Shift filtering, including date ranges for roster views."""

    date_from = django_filters.DateFilter(field_name="date", lookup_expr="gte")
    date_to = django_filters.DateFilter(field_name="date", lookup_expr="lte")

    class Meta:
        model = Shift
        fields = {
            "staff": ["exact"],
            "date": ["exact"],
            "is_active": ["exact"],
        }
