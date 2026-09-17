"""Turning a question into a verified, structured report.

The division of labour is the point of the whole feature:

    the model    decides which report answers the question, and writes the
                 sentence a manager reads
    this code    runs the report, and owns every number in it

The model never computes a total, a percentage or a growth rate. It receives
figures that were already calculated from the database and explains them. That
is why a wrong answer here looks like "I don't have that data" rather than a
plausible invented number.
"""

from __future__ import annotations

import json
import logging

from django.conf import settings
from django.utils import timezone

from . import cache as report_cache
from . import client, tools

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 3          # enough for "compare two periods", not a loop

SYSTEM_PROMPT = """You are the reporting assistant for a club and facility \
booking system. You answer questions about the operator's own data.

How you work:
- Call the report tools to get figures. Never state a number that did not come \
from a tool result in this conversation.
- If the tools cannot answer, say so plainly and say what is missing. Do not \
estimate, extrapolate or fill gaps.
- Percentages, totals and growth rates are already calculated for you. Do not \
recalculate them and do not round them differently.
- Do not narrow a question the user asked broadly. If they did not name a \
period, a club or a facility, do not invent one. Never substitute "today" for \
"in general". The default reporting window already covers recent history and \
the bookings still to come, so a general question needs no dates at all.
- Write for a manager: two or three sentences, specific, no preamble, no \
headings, no restating the question, no advice that the data does not support.
- Write plain prose. No Markdown, no asterisks for emphasis, no bullet lists \
and no tables: the figures already appear as charts and tables beside your \
answer, and your text is displayed exactly as written.
- Describe what changed, not why, unless the data shows the reason.

You have no ability to change anything. If asked to create, edit, cancel, \
approve, refund or delete, say that you can only read and report."""


def _safe_arguments(raw) -> dict:
    """Tool arguments arrive as a JSON string from the provider."""
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def _tool_message(call_id: str, name: str, payload: dict) -> dict:
    return {
        "role": "tool",
        "tool_call_id": call_id,
        "name": name,
        "content": json.dumps(payload, default=str),
    }


def suggestions(scope: tools.ReportScope) -> list[str]:
    """Example questions, limited to what this user may actually see.

    A manager with no finance capability is never shown a revenue prompt,
    because asking it would only produce a refusal.
    """
    prompts = [
        "How many bookings were made this month?",
        "Compare this month with last month.",
        "What are our busiest booking hours?",
        "Show cancelled bookings by facility.",
    ]
    if scope.can_view_finance:
        prompts = [
            "Give me a management summary for this month.",
            "Which facilities generated the highest revenue?",
            "Compare revenue by club.",
        ] + prompts
    if scope.can_view_staff:
        prompts.append("How is each staff member performing this month?")
    return prompts[:6]


def _run_tools(calls, scope) -> tuple[list[dict], list[dict]]:
    """Execute the tools the model asked for. Returns (messages, results).

    A tool that refuses returns its refusal to the model as an ordinary result,
    so the assistant can explain the limit instead of the request failing.
    """
    messages, results = [], []
    for call in calls:
        function = call.get("function") or {}
        name = function.get("name", "")
        arguments = _safe_arguments(function.get("arguments"))
        try:
            result = tools.call(name, scope, arguments)
            results.append(result)
            messages.append(_tool_message(call.get("id", ""), name, result))
        except tools.ToolError as exc:
            messages.append(_tool_message(call.get("id", ""), name, {"error": str(exc)}))
        except Exception:                        # noqa: BLE001
            # A bug in a report must not surface as a stack trace in a chat.
            logger.exception("AI report tool %s failed", name)
            messages.append(_tool_message(
                call.get("id", ""), name,
                {"error": "That report could not be produced."}))
    return messages, results


def _widgets(results: list[dict]) -> list[dict]:
    """Choose visualisations from the shape of the data, not from the model.

    The frontend renders a fixed set of trusted components, so the model cannot
    inject markup or scripts by describing a chart.
    """
    widgets = []
    for result in results:
        name, report = result.get("tool"), result.get("report") or {}

        if name == "get_revenue_summary":
            widgets.append({"type": "kpi", "title": "Revenue", "items": [
                {"label": "Net revenue", "value": report.get("net_revenue"), "format": "money"},
                {"label": "Gross", "value": report.get("gross_revenue"), "format": "money"},
                {"label": "Refunded", "value": report.get("refunded"), "format": "money"},
            ]})
            if report.get("series"):
                widgets.append({
                    "type": "line", "title": "Net revenue per day",
                    "x": "date", "y": "net", "rows": report["series"],
                })
            if report.get("by_club"):
                widgets.append({
                    "type": "bar", "title": "Revenue by club",
                    "x": "name", "y": "net", "rows": report["by_club"],
                })

        elif name == "get_booking_summary":
            widgets.append({"type": "kpi", "title": "Bookings", "items": [
                {"label": "Total bookings", "value": report.get("total"), "format": "number"},
            ]})
            if report.get("by_status"):
                widgets.append({
                    "type": "donut", "title": "By status", "x": "status", "y": "count",
                    "rows": [{"status": k, "count": v} for k, v in report["by_status"].items()],
                })

        elif name == "get_booking_trends" and report.get("series"):
            widgets.append({
                "type": "line", "title": "Bookings per day",
                "x": "date", "y": "bookings", "rows": report["series"],
            })

        elif name == "get_time_slot_statistics" and report.get("by_hour"):
            widgets.append({
                "type": "bar", "title": "Bookings by hour",
                "x": "hour", "y": "bookings", "rows": report["by_hour"],
            })

        elif name == "get_facility_performance" and report.get("rows"):
            widgets.append({
                "type": "table", "title": "Facility performance",
                "columns": [
                    {"key": "name", "label": "Facility type"},
                    {"key": "bookings", "label": "Bookings", "align": "right"},
                    {"key": "net", "label": "Net revenue", "align": "right", "format": "money"},
                ],
                "rows": report["rows"],
            })

        elif name == "get_club_performance" and report.get("rows"):
            columns = [
                {"key": "name", "label": "Club"},
                {"key": "bookings", "label": "Bookings", "align": "right"},
            ]
            if report.get("includes_revenue"):
                columns.append({"key": "net_revenue", "label": "Net revenue",
                                "align": "right", "format": "money"})
            widgets.append({"type": "table", "title": "Club performance",
                            "columns": columns, "rows": report["rows"]})

        elif name == "get_cancellation_statistics":
            widgets.append({"type": "kpi", "title": "Cancellations", "items": [
                {"label": "Cancelled", "value": report.get("cancelled"), "format": "number"},
                {"label": "No-shows", "value": report.get("no_show"), "format": "number"},
                {"label": "Lost rate", "value": report.get("lost_rate_percent"), "format": "percent"},
            ]})
            if report.get("by_facility_type"):
                widgets.append({
                    "type": "bar", "title": "Lost bookings by facility type",
                    "x": "name", "y": "lost", "rows": report["by_facility_type"],
                })

        elif name == "get_staff_performance" and report.get("rows"):
            widgets.append({
                "type": "table", "title": "Staff performance",
                "columns": [
                    {"key": "name", "label": "Staff"},
                    {"key": "completed", "label": "Completed", "align": "right"},
                    {"key": "avg_rating", "label": "Avg rating", "align": "right"},
                ],
                "rows": report["rows"],
            })

        elif name == "get_business_snapshot":
            widgets.append({"type": "kpi", "title": "Snapshot", "items": [
                {"label": "Net revenue", "value": report.get("net_revenue"), "format": "money"},
                {"label": "Active bookings", "value": report.get("active_bookings"), "format": "number"},
                {"label": "Customers", "value": report.get("customers"), "format": "number"},
            ]})

    return widgets


def ask(user, question: str, session_id: str, *, refresh: bool = False) -> dict:
    """Answer one question. The single entry point for the panel."""
    scope = tools.ReportScope.for_user(user)
    signature = scope.signature()
    key = report_cache.answer_key(user.id, signature, question, None)

    if refresh:
        report_cache.invalidate_answer(key)
    else:
        cached = report_cache.get_answer(key)
        if cached:
            # Reused verbatim, but labelled: a reader can tell a reused answer
            # from a freshly queried one.
            return {**cached, "cached": True}

    if not client.is_configured():
        raise client.AiUnavailable("AI Insights is not configured.")

    session = report_cache.get_session(user.id, session_id)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages += session.get("messages", [])
    messages.append({
        "role": "user",
        # The date is given rather than assumed: "this month" has to resolve
        # against the organization's today, not the model's training data.
        "content": f"Today is {timezone.localdate().isoformat()}.\n\n{question}",
    })

    schema = tools.schema(scope)
    results: list[dict] = []

    for _round in range(MAX_TOOL_ROUNDS):
        response = client.chat(messages, tools=schema)
        choice = (response.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        calls = message.get("tool_calls") or []

        messages.append({
            "role": "assistant",
            "content": message.get("content") or "",
            **({"tool_calls": calls} if calls else {}),
        })

        if not calls:
            answer = (message.get("content") or "").strip()
            widgets = _widgets(results)
            report_id = report_cache.store_report(user.id, signature, {
                "question": question,
                "answer": answer,
                "results": results,
                "widgets": widgets,
            }) if results else None

            payload = {
                "answer": answer or "I could not produce an answer for that.",
                "widgets": widgets,
                "report_id": report_id,
                "meta": [r.get("meta") for r in results],
                "tools_used": [r.get("tool") for r in results],
                "export_supported": bool(results),
                "generated_at": timezone.now().isoformat(),
                "cached": False,
                "usage": client.usage_of(response),
            }
            report_cache.set_answer(key, payload)

            session["messages"] = session.get("messages", []) + [
                {"role": "user", "content": question},
                {"role": "assistant", "content": answer},
            ]
            report_cache.save_session(user.id, session_id, session)
            return payload

        tool_messages, round_results = _run_tools(calls, scope)
        messages.extend(tool_messages)
        results.extend(round_results)

    # The model kept asking for data without concluding. Rather than loop, the
    # verified figures are returned with an honest note.
    widgets = _widgets(results)
    return {
        "answer": "I gathered the data but could not summarise it. The figures are below.",
        "widgets": widgets,
        "report_id": report_cache.store_report(user.id, signature, {
            "question": question, "answer": "", "results": results, "widgets": widgets,
        }) if results else None,
        "meta": [r.get("meta") for r in results],
        "tools_used": [r.get("tool") for r in results],
        "export_supported": bool(results),
        "generated_at": timezone.now().isoformat(),
        "cached": False,
        "usage": {},
    }


def capabilities(user) -> dict:
    """What the panel needs to render itself before any question is asked."""
    scope = tools.ReportScope.for_user(user)
    return {
        "enabled": client.is_configured(),
        "suggestions": suggestions(scope),
        "catalogue": tools.catalogue(scope),
        "max_date_range_days": settings.AI_REPORT_MAX_DATE_RANGE_DAYS,
    }
