import django_filters

from .models import Booking


class BookingFilter(django_filters.FilterSet):
    """Filtering for the bookings list, including scheduled-date ranges."""

    date_from = django_filters.DateFilter(field_name="scheduled_date", lookup_expr="gte")
    date_to = django_filters.DateFilter(field_name="scheduled_date", lookup_expr="lte")

    class Meta:
        model = Booking
        fields = {
            "status": ["exact"],
            # The bookings toolbar offers a source dropdown; without this the
            # parameter was accepted and silently ignored.
            "source": ["exact"],
            "booking_type": ["exact"],
            "payment_status": ["exact"],
            "club": ["exact"],
            "facility": ["exact"],
            "facility_type": ["exact"],
            "facility_category": ["exact"],
            "customer": ["exact"],
            "assigned_to": ["exact"],
            "scheduled_date": ["exact"],
            "recurrence": ["exact"],
        }
