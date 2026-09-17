"""Project-wide DRF exception handling.

Rewrites framework-default messages that would otherwise leak technical phrasing
to end users (e.g. "No FacilityType matches the given query.") into clear, professional
sentences. Ownership-scoped lookups intentionally return 404 (not 403) so the
existence of another user's record isn't disclosed — the message therefore covers
both "genuinely missing" and "exists but you can't see it" without distinguishing.
"""

import re

from rest_framework.views import exception_handler as drf_exception_handler

# "No FacilityType matches the given query." -> capture the model class name.
_NO_MATCH = re.compile(r"^No (\w+) matches the given query\.?$")


def _humanize(model_name: str) -> str:
    """`FacilityType` -> `facility type`, `Booking` -> `booking`."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", model_name)
    return spaced.lower()


def api_exception_handler(exc, context):
    """DRF default, with friendlier text for generic not-found responses.

    Keyed on the 404 status of the *response* (not the exception type): a
    record lookup raises Django's ``Http404``, which DRF converts to ``NotFound``
    only inside its own handler, so the ``exc`` we receive is still ``Http404``.
    """
    response = drf_exception_handler(exc, context)
    if response is None or response.status_code != 404:
        return response

    detail = response.data.get("detail") if isinstance(response.data, dict) else None
    text = str(detail) if detail is not None else ""
    match = _NO_MATCH.match(text)
    if match:
        subject = _humanize(match.group(1))
        response.data["detail"] = (
            f"The requested {subject} could not be found, "
            "or you do not have permission to view it."
        )
    elif text in ("", "Not found."):
        response.data["detail"] = (
            "The requested record could not be found, "
            "or you do not have permission to view it."
        )
    return response
