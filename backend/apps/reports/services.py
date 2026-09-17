"""Reporting aggregations.

Pure read-side ORM aggregations over bookings, payments, customers, and staff.
No models of its own — reports are computed on demand. Date ranges default to
the last 30 days when not supplied.
"""

from datetime import timedelta
from decimal import Decimal

from django.db.models import Avg, Count, DecimalField, F, Q, Sum
from django.db.models.functions import Coalesce, TruncDate
from django.utils import timezone

from apps.bookings.models import (
    ACTIVE_STATUSES, COMPLETED_STATUSES, Booking,
)
from apps.customers.models import Customer
from apps.payments.models import Payment, PaymentStatus
from apps.settings_app.currency import quantize_money
from apps.staff.models import StaffProfile

ZERO = Decimal("0.00")


def _default_range(date_from=None, date_to=None):
    today = timezone.localdate()
    end = date_to or today
    start = date_from or (end - timedelta(days=29))
    return start, end


def _paid_qs(start, end, owner=None, club=None, scope_clubs=None):
    qs = Payment.objects.filter(
        status__in=[PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED],
        created_at__date__gte=start,
        created_at__date__lte=end,
    )
    # `owner` set -> "my own activity" view (no reports.view_all).
    if owner is not None:
        qs = qs.filter(created_by=owner)
    # `scope_clubs` set -> club limit, but keep club-less / booking-less rows
    # (mobile jobs + manual payments) visible, mirroring bookings/payments scoping.
    if scope_clubs is not None:
        qs = qs.filter(
            Q(booking__club_id__in=scope_clubs)
            | Q(booking__isnull=True)
            | Q(booking__club__isnull=True)
        )
    if club:  # explicit club filter is exact.
        qs = qs.filter(booking__club_id=club)
    return qs


def revenue_report(date_from=None, date_to=None, owner=None, club=None, scope_clubs=None) -> dict:
    """Net revenue (paid minus refunds) per day, plus the per-club split."""
    start, end = _default_range(date_from, date_to)
    qs = _paid_qs(start, end, owner, club, scope_clubs)

    by_day = (
        qs.annotate(day=TruncDate("created_at"))
        .values("day")
        .annotate(
            gross=Coalesce(Sum("amount"), ZERO),
            refunded=Coalesce(Sum("refunded_amount"), ZERO),
        )
        .order_by("day")
    )
    series = [
        {
            "date": row["day"].isoformat(),
            "gross": str(row["gross"]),
            "net": str(row["gross"] - row["refunded"]),
        }
        for row in by_day
    ]

    by_club = (
        qs.filter(booking__club__isnull=False)
        .values("booking__club_id", "booking__club__name")
        .annotate(net=Coalesce(Sum(F("amount") - F("refunded_amount")), ZERO))
        .order_by("-net")
    )
    club_split = [
        {"club": row["booking__club_id"], "name": row["booking__club__name"], "net": str(row["net"])}
        for row in by_club
    ]

    totals = qs.aggregate(
        gross=Coalesce(Sum("amount"), ZERO),
        refunded=Coalesce(Sum("refunded_amount"), ZERO),
    )
    return {
        "date_from": start.isoformat(),
        "date_to": end.isoformat(),
        "gross_revenue": str(totals["gross"]),
        "refunded": str(totals["refunded"]),
        "net_revenue": str(totals["gross"] - totals["refunded"]),
        "series": series,
        "by_club": club_split,
    }


def bookings_report(date_from=None, date_to=None, owner=None, club=None, scope_clubs=None) -> dict:
    """Booking counts by status and club over the window."""
    start, end = _default_range(date_from, date_to)
    qs = Booking.objects.filter(scheduled_date__gte=start, scheduled_date__lte=end)
    if owner is not None:
        qs = qs.filter(Q(created_by=owner) | Q(assigned_to=owner))
    if scope_clubs is not None:
        qs = qs.filter(Q(club_id__in=scope_clubs) | Q(club__isnull=True))
    if club:
        qs = qs.filter(club_id=club)

    by_status = dict(
        qs.values_list("status").annotate(n=Count("id")).values_list("status", "n")
    )
    by_club = [
        {"club": row[0], "name": row[1], "count": row[2]}
        for row in (qs.filter(club__isnull=False)
                    .values_list("club_id", "club__name")
                    .annotate(n=Count("id")).order_by("-n")
                    .values_list("club_id", "club__name", "n"))
    ]
    return {
        "date_from": start.isoformat(),
        "date_to": end.isoformat(),
        "total": qs.count(),
        "by_status": by_status,
        "by_club": by_club,
    }


def top_services(date_from=None, date_to=None, owner=None, club=None, scope_clubs=None, limit=10) -> list[dict]:
    """Most-booked facility types in the window, with their net revenue."""
    start, end = _default_range(date_from, date_to)
    bqs = Booking.objects.filter(
        scheduled_date__gte=start, scheduled_date__lte=end, facility_type__isnull=False)
    if owner is not None:
        bqs = bqs.filter(Q(created_by=owner) | Q(assigned_to=owner))
    if scope_clubs is not None:
        bqs = bqs.filter(Q(club_id__in=scope_clubs) | Q(club__isnull=True))
    if club:
        bqs = bqs.filter(club_id=club)

    counts = list(
        bqs.values_list("facility_type_id", "facility_type__name")
        .annotate(n=Count("id")).order_by("-n")
        .values_list("facility_type_id", "facility_type__name", "n")
    )
    nets = dict(
        _paid_qs(start, end, owner, club, scope_clubs)
        .filter(booking__facility_type__isnull=False)
        .values_list("booking__facility_type_id")
        .annotate(net=Coalesce(Sum(F("amount") - F("refunded_amount")), ZERO))
        .values_list("booking__facility_type_id", "net")
    )
    return [
        {"facility_type": sid, "name": name, "bookings": n, "net": str(nets.get(sid, ZERO))}
        for sid, name, n in counts[:limit]
    ]


def performance_report(date_from=None, date_to=None, owner=None) -> list[dict]:
    """Per-staff completed-booking counts and average rating in the window."""
    start, end = _default_range(date_from, date_to)
    staff_qs = StaffProfile.objects.select_related("user").all()
    if owner is not None:
        staff_qs = staff_qs.filter(user=owner)     # own row only
    rows = []
    for staff in staff_qs:
        completed = Booking.objects.filter(
            assigned_to=staff.user,
            status__in=COMPLETED_STATUSES,
            scheduled_date__gte=start,
            scheduled_date__lte=end,
        ).count()
        rows.append({
            "staff_id": staff.id,
            "employee_id": staff.employee_id,
            "name": staff.full_name,
            "role": staff.role,
            "jobs_completed": completed,
            "rating": str(staff.rating),
        })
    rows.sort(key=lambda r: r["jobs_completed"], reverse=True)
    return rows


def dashboard_summary(owner=None, scope_clubs=None) -> dict:
    """Headline metrics for the admin dashboard (scoped to `owner`/clubs when set)."""
    today = timezone.localdate()
    last_14 = today - timedelta(days=13)

    paid = Payment.objects.filter(
        status__in=[PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED]
    )
    bookings = Booking.objects.all()
    customers = Customer.objects.all()
    if owner is not None:
        paid = paid.filter(created_by=owner)
        bookings = bookings.filter(Q(created_by=owner) | Q(assigned_to=owner))
        customers = customers.filter(created_by=owner)
    if scope_clubs is not None:   # Club-restricted user: limit to their clubs.
        paid = paid.filter(
            Q(booking__club_id__in=scope_clubs)
            | Q(booking__isnull=True)
            | Q(booking__club__isnull=True)
        )
        bookings = bookings.filter(Q(club_id__in=scope_clubs) | Q(club__isnull=True))

    # Aggregate at the money columns' precision (3 dp) so 3-dp currencies aren't
    # truncated; the API/exports/frontend then format to the currency's decimals.
    net_expr = Coalesce(Sum(F("amount") - F("refunded_amount")), ZERO,
                        output_field=DecimalField(max_digits=15, decimal_places=3))
    total_net = paid.aggregate(net=net_expr)["net"]

    active_bookings = bookings.filter(status__in=ACTIVE_STATUSES).count()
    completed = bookings.filter(status__in=COMPLETED_STATUSES).count()

    aov = paid.aggregate(v=Coalesce(Avg("amount"), ZERO))["v"]

    # Repeat rate: customers with 2+ bookings / customers with 1+.
    cust_counts = (
        customers.annotate(n=Count("bookings"))
        .aggregate(
            with_any=Count("id", filter=Q(n__gte=1)),
            repeat=Count("id", filter=Q(n__gte=2)),
        )
    )
    repeat_rate = (
        round(100 * cust_counts["repeat"] / cust_counts["with_any"], 1)
        if cust_counts["with_any"] else 0.0
    )

    # 14-day net revenue sparkline.
    by_day = dict(
        paid.filter(created_at__date__gte=last_14)
        .annotate(day=TruncDate("created_at"))
        .values_list("day")
        .annotate(net=net_expr)
        .values_list("day", "net")
    )
    revenue_series = []
    for i in range(14):
        d = last_14 + timedelta(days=i)
        revenue_series.append({"date": d.isoformat(), "net": str(by_day.get(d, ZERO))})

    return {
        "net_revenue": str(total_net),
        "total_bookings": bookings.count(),
        "active_bookings": active_bookings,
        "completed_bookings": completed,
        "total_customers": Customer.objects.count(),
        "average_order_value": str(quantize_money(aov)),
        "repeat_rate_percent": repeat_rate,
        "revenue_series": revenue_series,
    }


def memberships_report(date_from=None, date_to=None, scope_clubs=None) -> dict:
    """Membership health + revenue + utilisation. Counts are current; revenue +
    units consumed are within the date range. Club-scoped for club-limited
    staff (club-less memberships stay visible)."""
    from django.conf import settings
    from apps.payments.models import (
        Invoice, InvoiceStatus, Membership, MembershipStatus,
        MembershipUsage, MembershipUsageType,
    )
    start, end = _default_range(date_from, date_to)
    today = timezone.localdate()

    m_qs = Membership.objects.all()
    if scope_clubs is not None:
        m_qs = m_qs.filter(Q(club_id__in=scope_clubs) | Q(club__isnull=True))

    active = m_qs.filter(status=MembershipStatus.ACTIVE).count()
    suspended = m_qs.filter(status=MembershipStatus.SUSPENDED).count()
    expired = m_qs.filter(status=MembershipStatus.EXPIRED).count()
    expiring = m_qs.filter(
        status=MembershipStatus.ACTIVE, end_date__gte=today,
        end_date__lte=today + timedelta(days=30)).count()
    expiring_list = list(
        m_qs.filter(status=MembershipStatus.ACTIVE, end_date__gte=today,
                    end_date__lte=today + timedelta(days=30))
        .order_by("end_date")
        .values("number", "customer__linked_user__email", "plan__name", "end_date")[:50])

    # Revenue: membership sale/renewal invoices issued in range.
    inv_qs = Invoice.objects.filter(
        membership__isnull=False, issued_at__date__gte=start, issued_at__date__lte=end,
        status__in=[InvoiceStatus.PAID, InvoiceStatus.PARTIALLY_REFUNDED, InvoiceStatus.REFUNDED])
    if scope_clubs is not None:
        inv_qs = inv_qs.filter(Q(membership__club_id__in=scope_clubs) | Q(membership__club__isnull=True))
    revenue = inv_qs.aggregate(s=Coalesce(Sum("total"), ZERO, output_field=DecimalField()))["s"]

    # Utilisation: net units consumed (consume minus restore/adjust) in range.
    u_qs = MembershipUsage.objects.filter(created_at__date__gte=start, created_at__date__lte=end)
    consumed = u_qs.filter(txn_type=MembershipUsageType.CONSUME).aggregate(s=Coalesce(Sum("quantity"), 0))["s"] or 0
    returned = u_qs.filter(txn_type__in=[MembershipUsageType.RESTORE, MembershipUsageType.ADJUST]).aggregate(s=Coalesce(Sum("quantity"), 0))["s"] or 0

    by_plan = [
        {"plan": r["plan__name"], "active": r["active"]}
        for r in (m_qs.filter(status=MembershipStatus.ACTIVE)
                  .values("plan__name").annotate(active=Count("id")).order_by("-active"))]

    return {
        "date_from": str(start), "date_to": str(end),
        "active": active, "suspended": suspended, "expiring_soon": expiring, "expired": expired,
        "revenue": str(quantize_money(revenue, settings.DEFAULT_CURRENCY)),
        "currency": settings.DEFAULT_CURRENCY,
        "units_consumed": max(0, consumed - returned),
        "by_plan": by_plan,
        "expiring_list": [
            {"number": r["number"], "customer": r["customer__linked_user__email"],
             "plan": r["plan__name"], "end_date": str(r["end_date"])}
            for r in expiring_list],
    }
