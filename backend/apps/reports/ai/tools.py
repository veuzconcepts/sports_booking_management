"""The read-only tool registry: the only thing the assistant can reach.

Three rules hold this together.

1. Every tool is a thin wrapper over an existing function in
   `apps.reports.services`. There is no query written here, and no write path
   exists anywhere in this module, so "the model must not modify data" is a
   property of the code rather than an instruction in a prompt.

2. Scope is never taken from the model. The assistant may say `club=7`, but the
   club it gets is whatever `ReportScope` decides the signed-in user is allowed
   to see. An id outside that set is refused, not silently ignored, so an
   attempt shows up rather than returning someone else's numbers.

3. Nothing unbounded. Date ranges, row counts and group sizes are clamped
   before they reach the database, so a question cannot turn into a scan of
   every booking ever taken.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date as date_cls, timedelta

from django.conf import settings
from django.utils import timezone

from apps.accounts import access

from .. import services


class ToolError(Exception):
    """A tool call that cannot be answered as asked.

    Raised for a bad argument or an out-of-scope filter. The message is shown
    to the model so it can correct itself or tell the user, and is written for
    a person to read.
    """


# --------------------------------------------------------------------------- #
# Scope                                                                        #
# --------------------------------------------------------------------------- #
@dataclass
class ReportScope:
    """What this user is allowed to see, resolved once from the request.

    Built from the user and nothing else. Two people asking the same question
    get different answers if their permissions differ, and neither can widen
    their own scope by asking differently.
    """

    user: object
    owner: object | None                 # None means "may see everyone's"
    club_ids: list[int] | None           # None means "every club"
    can_view_finance: bool
    can_view_customers: bool
    can_view_staff: bool

    @classmethod
    def for_user(cls, user) -> "ReportScope":
        return cls(
            user=user,
            # Without reports.view_all a user sees only their own activity,
            # exactly as the non-AI report endpoints already behave.
            owner=None if access.can_view_all(user, "reports") else user,
            club_ids=user.scoped_club_ids(),
            # Revenue and payment figures follow the finance capabilities, not
            # the reports one: seeing booking counts is not seeing money.
            can_view_finance=(user.has_perm_code("payments.view")
                              or user.has_perm_code("invoicing.view")),
            can_view_customers=user.has_perm_code("customers.view"),
            can_view_staff=user.has_perm_code("staff.view"),
        )

    def resolve_club(self, club_id) -> int | None:
        """Validate a club the model asked for against what the user may see."""
        if club_id in (None, "", 0):
            return None
        try:
            club_id = int(club_id)
        except (TypeError, ValueError) as exc:
            raise ToolError("The club filter must be a club id.") from exc
        if self.club_ids is not None and club_id not in self.club_ids:
            raise ToolError(
                "That club is outside the clubs you have access to.")
        return club_id

    def signature(self) -> str:
        """Identifies this scope for caching.

        Two users share a cached report only when their scope is identical, so
        a permission change or a different club assignment can never surface
        someone else's figures.
        """
        clubs = "all" if self.club_ids is None else ",".join(
            str(c) for c in sorted(self.club_ids))
        owner = "self" if self.owner is not None else "all"
        flags = f"{int(self.can_view_finance)}{int(self.can_view_customers)}{int(self.can_view_staff)}"
        return f"{owner}|{clubs}|{flags}"


# --------------------------------------------------------------------------- #
# Argument handling                                                            #
# --------------------------------------------------------------------------- #
def _parse_date(value, name):
    if value in (None, ""):
        return None
    if isinstance(value, date_cls):
        return value
    try:
        return date_cls.fromisoformat(str(value)[:10])
    except ValueError as exc:
        raise ToolError(f"{name} must be a date like 2026-03-01.") from exc


# The operational horizon a manager means by "our bookings": recent history
# plus what is already on the books. A booking is scheduled for a future date,
# so a backward-only default reports a fraction of the business.
DEFAULT_DAYS_BACK = 30
DEFAULT_DAYS_FORWARD = 90


def resolve_period(date_from=None, date_to=None) -> tuple[date_cls, date_cls]:
    """A validated, bounded reporting window.

    With no dates given it spans recent history and the forward book, because
    that is what a question about "bookings" means in a booking system. The
    bounds stop one question from aggregating years of rows.
    """
    today = timezone.localdate()
    end = _parse_date(date_to, "date_to") or (today + timedelta(days=DEFAULT_DAYS_FORWARD))
    start = _parse_date(date_from, "date_from") or (
        min(end, today) - timedelta(days=DEFAULT_DAYS_BACK - 1))
    if start > end:
        raise ToolError("The start of the period is after its end.")

    limit = settings.AI_REPORT_MAX_DATE_RANGE_DAYS
    if (end - start).days > limit:
        raise ToolError(
            f"That period covers more than {limit} days. Ask for a shorter "
            "range, or a yearly summary.")
    return start, end


def _limit(value, default, ceiling):
    try:
        n = int(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        n = default
    return max(1, min(n, ceiling))


# --------------------------------------------------------------------------- #
# The tools                                                                    #
# --------------------------------------------------------------------------- #
@dataclass
class Tool:
    """One thing the assistant may ask for."""

    name: str
    description: str
    parameters: dict
    run: object
    # Capability the signed-in user needs before this tool is even offered.
    requires: str | None = None
    # Categories drive the catalogue shown in the panel.
    category: str = "general"


def _meta(start, end, scope, extra=None) -> dict:
    """Provenance attached to every result, so a figure can be traced back."""
    meta = {
        "date_from": start.isoformat(),
        "date_to": end.isoformat(),
        "scope": "all clubs" if scope.club_ids is None else f"{len(scope.club_ids)} club(s)",
        "own_activity_only": scope.owner is not None,
        "generated_at": timezone.now().isoformat(),
    }
    if extra:
        meta.update(extra)
    return meta


def _booking_summary(scope: ReportScope, date_from=None, date_to=None, club=None, **_):
    start, end = resolve_period(date_from, date_to)
    data = services.bookings_report(
        start, end, owner=scope.owner, club=scope.resolve_club(club),
        scope_clubs=scope.club_ids)
    return {"report": data, "meta": _meta(start, end, scope, {"rows": len(data["by_club"])})}


def _revenue_summary(scope: ReportScope, date_from=None, date_to=None, club=None, **_):
    start, end = resolve_period(date_from, date_to)
    data = services.revenue_report(
        start, end, owner=scope.owner, club=scope.resolve_club(club),
        scope_clubs=scope.club_ids)
    # A long daily series is the one place these reports can get large.
    series = data["series"][-settings.AI_REPORT_MAX_ROWS:]
    data = {**data, "series": series}
    return {"report": data, "meta": _meta(start, end, scope, {"rows": len(series)})}


def _facility_performance(scope: ReportScope, date_from=None, date_to=None,
                          club=None, limit=10, **_):
    start, end = resolve_period(date_from, date_to)
    rows = services.top_services(
        start, end, owner=scope.owner, club=scope.resolve_club(club),
        scope_clubs=scope.club_ids, limit=_limit(limit, 10, 50))
    return {"report": {"rows": rows}, "meta": _meta(start, end, scope, {"rows": len(rows)})}


def _club_performance(scope: ReportScope, date_from=None, date_to=None, **_):
    """Bookings and revenue side by side, per club.

    Composed from the two existing reports rather than a third query, so the
    numbers here are the same ones the Reports page shows.
    """
    start, end = resolve_period(date_from, date_to)
    bookings = services.bookings_report(
        start, end, owner=scope.owner, scope_clubs=scope.club_ids)
    rows = {r["club"]: {"club": r["club"], "name": r["name"], "bookings": r["count"],
                        "net_revenue": None} for r in bookings["by_club"]}

    if scope.can_view_finance:
        revenue = services.revenue_report(
            start, end, owner=scope.owner, scope_clubs=scope.club_ids)
        for row in revenue["by_club"]:
            entry = rows.setdefault(row["club"], {
                "club": row["club"], "name": row["name"], "bookings": 0, "net_revenue": None})
            entry["net_revenue"] = row["net"]

    ordered = sorted(rows.values(), key=lambda r: r["bookings"], reverse=True)
    return {
        "report": {"rows": ordered, "includes_revenue": scope.can_view_finance},
        "meta": _meta(start, end, scope, {"rows": len(ordered)}),
    }


def _booking_trends(scope: ReportScope, date_from=None, date_to=None, club=None, **_):
    start, end = resolve_period(date_from, date_to)
    data = services.booking_trends(
        start, end, owner=scope.owner, club=scope.resolve_club(club),
        scope_clubs=scope.club_ids, limit=settings.AI_REPORT_MAX_ROWS)
    return {"report": data, "meta": _meta(start, end, scope, {"rows": len(data["series"])})}


def _time_slot_statistics(scope: ReportScope, date_from=None, date_to=None, club=None, **_):
    start, end = resolve_period(date_from, date_to)
    data = services.booking_hours(
        start, end, owner=scope.owner, club=scope.resolve_club(club),
        scope_clubs=scope.club_ids)
    return {"report": data, "meta": _meta(start, end, scope, {"rows": len(data["by_hour"])})}


def _cancellation_statistics(scope: ReportScope, date_from=None, date_to=None, club=None, **_):
    start, end = resolve_period(date_from, date_to)
    data = services.cancellations_report(
        start, end, owner=scope.owner, club=scope.resolve_club(club),
        scope_clubs=scope.club_ids, limit=settings.AI_REPORT_MAX_ROWS)
    return {"report": data, "meta": _meta(start, end, scope, {"rows": len(data["by_facility_type"])})}


def _staff_performance(scope: ReportScope, date_from=None, date_to=None, **_):
    start, end = resolve_period(date_from, date_to)
    rows = services.performance_report(start, end, owner=scope.owner)
    rows = rows[:settings.AI_REPORT_MAX_ROWS]
    return {"report": {"rows": rows}, "meta": _meta(start, end, scope, {"rows": len(rows)})}


def _membership_summary(scope: ReportScope, date_from=None, date_to=None, **_):
    start, end = resolve_period(date_from, date_to)
    data = services.memberships_report(start, end, scope_clubs=scope.club_ids)
    return {"report": data, "meta": _meta(start, end, scope)}


def _business_snapshot(scope: ReportScope, **_):
    """The headline figures, matching the dashboard exactly."""
    data = services.dashboard_summary(owner=scope.owner, scope_clubs=scope.club_ids)
    today = timezone.localdate()
    return {"report": data, "meta": _meta(today, today, scope, {"kind": "all-time snapshot"})}


_PERIOD_PARAMS = {
    "date_from": {
        "type": "string",
        "description": (
            "Start of the period, YYYY-MM-DD. OMIT THIS unless the user named a "
            "period: omitting both dates uses the default window, which covers "
            "the last 30 days and the next 90 days of scheduled bookings."),
    },
    "date_to": {
        "type": "string",
        "description": (
            "End of the period, YYYY-MM-DD. OMIT THIS unless the user named a "
            "period. Bookings are scheduled for future dates, so an end date in "
            "the past excludes everything still upcoming."),
    },
}
_CLUB_PARAM = {
    "club": {
        "type": "integer",
        "description": (
            "A single club to narrow to. OMIT THIS unless the user named a club: "
            "leaving it out reports every club they have access to. Refused if "
            "the club is outside their access."),
    },
}


REGISTRY: list[Tool] = [
    Tool(
        name="get_booking_summary",
        description="Booking counts for a period, broken down by status and by club.",
        parameters={**_PERIOD_PARAMS, **_CLUB_PARAM},
        run=_booking_summary,
        category="booking",
    ),
    Tool(
        name="get_revenue_summary",
        description=("Net revenue for a period (paid minus refunds), the daily "
                     "series, and the split by club."),
        parameters={**_PERIOD_PARAMS, **_CLUB_PARAM},
        run=_revenue_summary,
        requires="finance",
        category="revenue",
    ),
    Tool(
        name="get_facility_performance",
        description="Most-booked facility types in a period, with their net revenue.",
        parameters={
            **_PERIOD_PARAMS, **_CLUB_PARAM,
            "limit": {"type": "integer", "description": "How many to return, 1 to 50. Default 10."},
        },
        run=_facility_performance,
        category="facility",
    ),
    Tool(
        name="get_club_performance",
        description=("Bookings per club, with net revenue alongside when the "
                     "user may see financial data."),
        parameters=_PERIOD_PARAMS,
        run=_club_performance,
        category="club",
    ),
    Tool(
        name="get_booking_trends",
        description="Bookings per day over a period, for trend and comparison questions.",
        parameters={**_PERIOD_PARAMS, **_CLUB_PARAM},
        run=_booking_trends,
        category="booking",
    ),
    Tool(
        name="get_time_slot_statistics",
        description="Which hours of the day customers book, and the busiest weekdays.",
        parameters={**_PERIOD_PARAMS, **_CLUB_PARAM},
        run=_time_slot_statistics,
        category="booking",
    ),
    Tool(
        name="get_cancellation_statistics",
        description="Cancellations and no-shows for a period, with the rate and the facility types affected.",
        parameters={**_PERIOD_PARAMS, **_CLUB_PARAM},
        run=_cancellation_statistics,
        category="cancellation",
    ),
    Tool(
        name="get_staff_performance",
        description="Completed bookings and average rating per staff member.",
        parameters=_PERIOD_PARAMS,
        run=_staff_performance,
        requires="staff",
        category="staff",
    ),
    Tool(
        name="get_membership_summary",
        description="Membership counts, revenue and entitlement usage for a period.",
        parameters=_PERIOD_PARAMS,
        run=_membership_summary,
        requires="finance",
        category="membership",
    ),
    Tool(
        name="get_business_snapshot",
        description=("All-time headline figures: revenue, active bookings, "
                     "customers and repeat rate. Use for 'how are we doing'."),
        parameters={},
        run=_business_snapshot,
        category="general",
    ),
]

BY_NAME = {tool.name: tool for tool in REGISTRY}

_CAPABILITY = {
    "finance": lambda scope: scope.can_view_finance,
    "customers": lambda scope: scope.can_view_customers,
    "staff": lambda scope: scope.can_view_staff,
}


def available(scope: ReportScope) -> list[Tool]:
    """The tools this user may actually use.

    A tool the user has no permission for is not offered to the model at all,
    so it cannot be asked for and cannot appear in a suggestion.
    """
    return [
        tool for tool in REGISTRY
        if tool.requires is None or _CAPABILITY[tool.requires](scope)
    ]


def call(name: str, scope: ReportScope, arguments: dict | None = None) -> dict:
    """Run one approved tool. The only way data reaches the assistant."""
    tool = BY_NAME.get(name)
    if tool is None:
        raise ToolError(f"There is no report called {name!r}.")
    if tool not in available(scope):
        raise ToolError("You do not have permission to see that report.")

    result = tool.run(scope, **(arguments or {}))
    result["tool"] = tool.name
    return result


def schema(scope: ReportScope) -> list[dict]:
    """The registry in the shape a model provider expects for tool calling."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": {
                    "type": "object",
                    "properties": tool.parameters,
                    "required": [],
                    "additionalProperties": False,
                },
            },
        }
        for tool in available(scope)
    ]


def catalogue(scope: ReportScope) -> list[dict]:
    """What the panel shows as available capabilities."""
    return [
        {"name": tool.name, "category": tool.category, "description": tool.description}
        for tool in available(scope)
    ]
