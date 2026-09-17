"""Shared listing behaviour for every admin list endpoint.

The admin UI drives all of its listing pages through one table component, so the
endpoints behind them answer one consistent query contract::

    ?search=      free text over the viewset's `search_fields`
    ?ordering=    a field from `ordering_fields`, `-` prefixed for descending
    ?page=        1-based page number
    ?page_size=   rows per page (25 / 50 / 100), capped
    ?<filter>=    whatever the viewset's filterset declares
    ?group_by=    return group buckets with counts instead of rows

Search, filtering and ordering already come from DRF's own backends, which every
viewset here configures. This module adds the two pieces that were missing: a
client-selectable page size, and grouping.
"""

from django.db.models import Count
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response


class StandardPagination(PageNumberPagination):
    """Page-number pagination that lets the client choose the page size.

    The project default was `PageNumberPagination` with no `page_size_query_param`,
    which silently ignored `?page_size=`: a caller asking for 500 rows got 20 and
    no indication that the rest existed. The cap keeps a single request bounded.
    """

    page_size_query_param = "page_size"
    max_page_size = 500


# --------------------------------------------------------------------------- #
# Grouping
# --------------------------------------------------------------------------- #
class GroupingNotAllowed(Exception):
    """`group_by` named a field the viewset does not expose."""


class GroupedListMixin:
    """`?group_by=<key>` returns group buckets instead of a page of rows.

    Declare what may be grouped, mapping the key the UI sends to the ORM path
    used for the value and its label::

        group_by_fields = {
            "club":   {"field": "club_id", "label": "club__name"},
            "status": {"field": "status"},
        }

    The response is the group headers only::

        {"group_by": "club",
         "groups": [{"key": 1, "label": "Riverside Club", "count": 24}, ...]}

    Rows are NOT included. The table fetches a group's rows on expand, as an
    ordinary filtered page, so opening one group never drags the whole dataset
    into the browser and paging inside a group keeps working.

    Counting happens in the database over the same filtered queryset the list
    would have returned, so a group count always agrees with what expanding it
    shows.
    """

    group_by_fields: dict = {}

    def _group_spec(self, key):
        spec = (self.group_by_fields or {}).get(key)
        if spec is None:
            raise GroupingNotAllowed(key)
        return spec

    def grouped_response(self, queryset, key):
        spec = self._group_spec(key)
        field = spec["field"]
        label_field = spec.get("label")

        values = [field] + ([label_field] if label_field else [])
        rows = (queryset.order_by()
                .values(*values)
                .annotate(_count=Count("id"))
                .order_by("-_count", field))

        # Display maps so the UI shows "Confirmed" rather than "confirmed", and
        # "Active / Inactive" rather than "True / False", without the frontend
        # needing to know any model's choices.
        choices = dict(spec.get("choices") or [])
        labels = spec.get("labels") or {}

        groups = []
        for row in rows:
            raw = row[field]
            if label_field:
                label = row.get(label_field)
            elif raw in labels:
                label = labels[raw]
            elif isinstance(raw, bool):
                # A boolean group reads as a state, not as a Python literal.
                label = spec.get("true_label", "Yes") if raw else spec.get(
                    "empty_label", "No")
            else:
                label = choices.get(raw, raw)
            groups.append({
                "key": raw,
                "label": (str(label) if label not in (None, "") else spec.get(
                    "empty_label", "Not set")),
                "count": row["_count"],
            })
        return {
            "group_by": key,
            # The parameter the table sends back to fetch one group's rows.
            "filter_param": spec.get("filter_param", key),
            "groups": groups,
        }

    def list(self, request, *args, **kwargs):
        group_by = request.query_params.get("group_by")
        if not group_by:
            return super().list(request, *args, **kwargs)

        queryset = self.filter_queryset(self.get_queryset())
        try:
            payload = self.grouped_response(queryset, group_by)
        except GroupingNotAllowed:
            allowed = ", ".join(sorted(self.group_by_fields or {})) or "none"
            return Response(
                {"detail": f"Cannot group by '{group_by}'. Available: {allowed}."},
                status=400)
        return Response(payload)
