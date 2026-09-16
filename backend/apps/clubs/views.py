"""Club (venue) endpoints: clubs and their weekday opening hours."""

from rest_framework import permissions, status, viewsets
from rest_framework.exceptions import APIException

from apps.accounts.permissions import ClubPermission

from .models import Club
from .serializers import ClubSerializer


class InUse(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "This record is still in use."


def _club_blockers(club):
    """Human-readable reasons a club can't be deleted (would orphan data)."""
    reasons = []
    if club.bookings.exists():
        reasons.append("bookings")
    if club.assigned_users.exists():
        reasons.append("assigned users")
    if (club.facility_categories.exists() or club.facility_types.exists()
            or club.addons.exists() or club.pricing_rules.exists()):
        reasons.append("catalogue / pricing availability")
    used = [f.name for f in club.facilities.all()
            if f.bookings.exists() or f.assigned_users.exists()]
    if used:
        reasons.append("in-use facilities (" + ", ".join(used) + ")")
    return reasons


class ClubViewSet(viewsets.ModelViewSet):
    queryset = Club.objects.prefetch_related("facilities").all()
    serializer_class = ClubSerializer
    permission_classes = [permissions.IsAuthenticated, ClubPermission]
    filterset_fields = ["is_active", "city"]
    search_fields = ["name", "code", "city"]
    ordering_fields = ["name", "created_at"]

    def get_queryset(self):
        qs = super().get_queryset()
        club_ids = self.request.user.scoped_club_ids()
        return qs if club_ids is None else qs.filter(id__in=club_ids)

    def perform_destroy(self, instance):
        reasons = _club_blockers(instance)
        if reasons:
            raise InUse(f"This club is still in use: {', '.join(reasons)}. "
                        "Remove those links first, then delete it.")
        instance.delete()   # cascades only the club's own facilities + hours

