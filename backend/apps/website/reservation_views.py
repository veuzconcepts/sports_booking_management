"""Public reservation endpoints: holding a court while the customer pays.

Three operations on one resource. Creating a reservation claims the courts,
reading one answers "how long have I got?" after a refresh or on another tab,
and deleting one gives the courts back the moment somebody changes their mind
rather than making the next customer wait out the clock.

The token in the path IS the authorisation, exactly as it is for a split
payment link, so these routes carry no customer id and need no session. It is
returned once, on creation, and only its digest is ever stored.

Nothing here decides anything. The deadline, the ceiling and whether the slots
are free all come from `apps.bookings.reservations`, which is the same engine
the booking flow converts against.
"""

from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.bookings import multi_slot, reservations, services as booking_services


class _PublicView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    # Its OWN scope, not the booking one. A reservation is claimed on reaching
    # checkout and again whenever the customer changes their times, so sharing
    # the booking allowance meant ordinary browsing exhausted it and the
    # booking itself was then refused for the rest of the hour.
    throttle_scope = "public_reservation"


def hold_payload(hold, *, token=None):
    """What the browser is allowed to know about a reservation.

    `expires_at` is absolute and server-issued, and `seconds_remaining` comes
    with it so a countdown never has to trust the device clock. A phone whose
    time is twenty minutes fast would otherwise show a reservation as expired
    while it was perfectly good.
    """
    from apps.settings_app.schedule import resolve_booking_policy

    payload = {
        # Whether the customer is shown the clock. The court is held either
        # way: this is presentation, resolved on the backend like every other
        # club setting, so the browser is never deciding it.
        "show_countdown": bool(
            resolve_booking_policy(hold.club)["show_hold_countdown"]),
        "reference": hold.reference,
        "status": hold.status,
        "expires_at": hold.expires_at.isoformat(),
        "server_time": timezone.now().isoformat(),
        "seconds_remaining": hold.seconds_remaining,
        "slots": [
            {"date": slot.scheduled_date.isoformat(),
             "time": slot.scheduled_time.strftime("%H:%M"),
             "end": slot.end_time.strftime("%H:%M")}
            for slot in hold.slots.all()
        ],
    }
    # Only ever on creation. A reservation that can be read back by its token
    # must not hand that token out again.
    if token is not None:
        payload["token"] = token
    return payload


class PublicReservationCreateView(_PublicView):
    """Claim the chosen courts for a few minutes while the customer checks out.

    Accepts either `slots: [{date, time}]` or a single `date` and `time`, so
    the same endpoint serves both checkout shapes.
    """

    def post(self, request):
        from apps.clubs.models import Club
        from apps.facilities.models import FacilityType

        data = request.data or {}
        club = Club.objects.filter(pk=data.get("club"), is_active=True).first()
        if club is None:
            return Response({"detail": "Choose a club to continue.",
                             "code": "club_required"},
                            status=status.HTTP_400_BAD_REQUEST)
        activity = FacilityType.objects.filter(
            pk=data.get("facility_type"), is_active=True,
            online_booking_enabled=True).first()
        if activity is None:
            return Response({"detail": "This facility isn't available for booking.",
                             "code": "facility_type_required"},
                            status=status.HTTP_404_NOT_FOUND)

        raw = data.get("slots")
        if not raw and data.get("date") and data.get("time"):
            raw = [{"date": data["date"], "time": data["time"]}]
        try:
            slots = multi_slot.parse_slots(raw)
        except multi_slot.SelectionError as exc:
            return Response({"detail": str(exc), "code": exc.code},
                            status=status.HTTP_400_BAD_REQUEST)
        if not slots:
            return Response({"detail": "Choose a time to continue.",
                             "code": "no_slots"},
                            status=status.HTTP_400_BAD_REQUEST)

        # The booking window, the per-customer caps and how many slots may be
        # taken at once, checked BEFORE anything is claimed. A reservation for
        # a slot the customer could never book would hold a court for nothing.
        try:
            multi_slot.validate_selection(
                slots, club=club, facility_type=activity, staff_booking=False)
        except multi_slot.SelectionError as exc:
            return Response(
                {"detail": str(exc), "code": exc.code, "slots": exc.slots},
                status=(status.HTTP_409_CONFLICT if exc.code == "slot_unavailable"
                        else status.HTTP_400_BAD_REQUEST))

        try:
            hold, token = reservations.acquire(
                club=club, facility_type=activity, slots=slots)
        except reservations.SlotUnavailable as exc:
            return Response({"detail": str(exc), "code": exc.code,
                             "slots": exc.slots},
                            status=status.HTTP_409_CONFLICT)

        return Response(hold_payload(hold, token=token),
                        status=status.HTTP_201_CREATED)


class PublicReservationView(_PublicView):
    """Read or give up one reservation, addressed by its token.

    Deliberately not throttled. Reading is how a reload or a language switch
    recovers a countdown, and releasing is how a court goes back on sale the
    moment somebody changes their mind. Rate limiting the operation that FREES
    a resource is backwards: a refused release leaves the court locked until
    the deadline, which hurts the club rather than protecting it. Neither
    operation can create anything, and both need a token that only its owner
    has.
    """

    throttle_scope = None

    def get(self, request, token):
        hold = reservations.resolve(token)
        if hold is None:
            return Response({"detail": "This reservation is not valid.",
                             "code": "invalid_hold"},
                            status=status.HTTP_404_NOT_FOUND)
        # Expiry is enforced on read, not left to the sweep: between ticks a
        # row sits ACTIVE past its deadline, and a countdown that kept running
        # would send somebody to a payment page for a court already resold.
        if hold.status == reservations.HoldStatus.ACTIVE and not hold.is_live:
            reservations.expire(hold)
            hold.refresh_from_db()
        return Response(hold_payload(hold))

    def delete(self, request, token):
        """Give the courts back now rather than at the deadline.

        Idempotent: releasing an already finished reservation is a success,
        because the caller wanted it gone and it is gone.
        """
        hold = reservations.resolve(token)
        if hold is None:
            return Response({"detail": "This reservation is not valid.",
                             "code": "invalid_hold"},
                            status=status.HTTP_404_NOT_FOUND)
        reservations.release(hold)
        hold.refresh_from_db()
        return Response(hold_payload(hold))
