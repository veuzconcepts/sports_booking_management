"""Filters for the admin user-management API."""

from django.db.models import Q
from django.utils import timezone
from django_filters import rest_framework as filters

from .models import User


class UserFilter(filters.FilterSet):
    """Adds a `locked` filter that matches the `User.is_locked` property exactly
    (locked_until in the future, evaluated per request). An expired-but-unreset
    lock reads as NOT locked in both the filter and the badge.
    """

    locked = filters.BooleanFilter(method="filter_locked")
    club = filters.NumberFilter(method="filter_club")

    class Meta:
        model = User
        fields = ["role", "is_active", "mfa_enabled", "is_deleted"]

    def filter_club(self, queryset, name, value):
        # Staff assigned to this club, plus club-agnostic staff (no
        # assignment / unrestricted) who serve every club.
        return queryset.filter(
            Q(assigned_clubs__id=value) | Q(assigned_clubs__isnull=True)
        ).distinct()

    def filter_locked(self, queryset, name, value):
        now = timezone.now()
        if value is True:
            return queryset.filter(locked_until__gt=now)
        if value is False:
            return queryset.filter(Q(locked_until__isnull=True) | Q(locked_until__lte=now))
        return queryset
