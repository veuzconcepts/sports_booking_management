"""The only place this project talks to a model provider.

Written on `urllib.request` rather than a new dependency: the call is one POST
of JSON, and adding an SDK to make it would be a larger change than the feature
needs.

The API key never leaves this module. It is read from settings, put in a
header, and never logged, echoed in an error, or returned to a client. The
error types below are deliberately opaque for the same reason: whatever the
provider says, the caller gets a message it is safe to show a user.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

from django.conf import settings

logger = logging.getLogger(__name__)

# Whether the configured model wants `reasoning_effort` alongside function
# tools. Learned from the provider's first refusal and kept for the life of the
# process, so the negotiation costs one extra request once, not per question.
_NEEDS_REASONING_EFFORT: dict[str, bool] = {}


class AiUnavailable(Exception):
    """The assistant cannot answer right now.

    Always safe to show. The Reports page keeps working without it, so this is
    a degraded feature rather than a failure.
    """


def is_configured() -> bool:
    """Whether the assistant can run at all: switched on, and given a key."""
    return bool(settings.AI_REPORT_ENABLED and settings.OPENAI_API_KEY)


def _error_of(exc: urllib.error.HTTPError) -> dict:
    """The provider's structured error, or an empty dict if it sent none."""
    try:
        return json.loads(exc.read().decode("utf-8")).get("error") or {}
    except Exception:                       # noqa: BLE001 - any shape is possible
        return {}


def _post(path: str, payload: dict) -> dict:
    url = f"{settings.OPENAI_BASE_URL.rstrip('/')}/{path.lstrip('/')}"
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
        },
        method="POST",
    )
    with urllib.request.urlopen(
        request, timeout=settings.AI_REQUEST_TIMEOUT_SECONDS
    ) as response:
        return json.loads(response.read().decode("utf-8"))


def chat(messages: list[dict], tools: list[dict] | None = None,
         response_format: dict | None = None) -> dict:
    """One chat completion.

    Retries only what is worth retrying: a timeout or a 5xx from the provider.
    A 4xx means the request itself is wrong, and repeating it would just spend
    the budget again, so it fails immediately. There is no loop here that can
    run away with credits.
    """
    if not is_configured():
        raise AiUnavailable("AI Insights is not configured.")

    payload = {
        "model": settings.OPENAI_REPORT_MODEL,
        "messages": messages,
        "max_completion_tokens": settings.AI_MAX_OUTPUT_TOKENS,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    if response_format:
        payload["response_format"] = response_format

    model = payload["model"]
    # A reasoning model needs this to use function tools at all; a
    # non-reasoning one rejects the parameter. Only sent once we have been told.
    if tools and _NEEDS_REASONING_EFFORT.get(model):
        payload["reasoning_effort"] = "none"

    attempts = max(1, settings.AI_MAX_RETRIES + 1)
    for attempt in range(attempts):
        try:
            return _post("chat/completions", payload)
        except urllib.error.HTTPError as exc:
            error = _error_of(exc)
            # One bounded renegotiation, not a retry loop: the provider has
            # told us exactly which parameter it wants changed.
            if exc.code == 400 and error.get("param") == "reasoning_effort":
                wanted = "reasoning_effort" not in payload
                _NEEDS_REASONING_EFFORT[model] = wanted
                if wanted:
                    payload["reasoning_effort"] = "none"
                else:
                    payload.pop("reasoning_effort", None)
                logger.info("Adjusting reasoning_effort for %s and retrying once", model)
                try:
                    return _post("chat/completions", payload)
                except urllib.error.HTTPError as retry_exc:
                    logger.warning("AI provider still refused after adjustment: %s",
                                   _error_of(retry_exc).get("message", "")[:200])
                    raise AiUnavailable(
                        "AI Insights is temporarily unavailable.") from retry_exc

            retryable = exc.code >= 500 or exc.code == 429
            # The provider's body can quote the request, so it is logged at a
            # level operators see and never returned to the browser.
            logger.warning("AI provider returned %s on attempt %s/%s: %s",
                           exc.code, attempt + 1, attempts,
                           str(error.get("message", ""))[:200])
            if not retryable or attempt == attempts - 1:
                raise AiUnavailable(
                    "AI Insights is temporarily unavailable.") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            logger.warning("AI provider unreachable on attempt %s/%s: %s",
                           attempt + 1, attempts, type(exc).__name__)
            if attempt == attempts - 1:
                raise AiUnavailable(
                    "AI Insights is temporarily unavailable.") from exc

    raise AiUnavailable("AI Insights is temporarily unavailable.")


def usage_of(response: dict) -> dict:
    """Token counts, for the cost figures in the audit trail."""
    usage = response.get("usage") or {}
    return {
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "total_tokens": usage.get("total_tokens"),
    }
