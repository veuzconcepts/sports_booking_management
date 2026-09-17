"""Not asking the model the same question twice.

Two separate jobs live here.

`answer cache`  keyed by who is asking, what they may see, and what they asked.
                A repeat of an equivalent question reuses the answer instead of
                spending another provider call.

`report store`  the resolved dataset behind an answer, kept so Export produces
                a file from the figures the user actually saw. Exporting never
                calls the model.

The key always includes the scope signature, so two users share an entry only
when their permissions are identical. A permission change produces a different
signature and therefore a different key: a cached answer can never outlive the
access that produced it.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

_ANSWER_PREFIX = "ai_report:answer"
_REPORT_PREFIX = "ai_report:data"
_SESSION_PREFIX = "ai_report:session"

# Filler that changes the wording without changing the question, so
# "show me bookings this month again please" reuses "bookings this month".
_FILLER = re.compile(
    r"\b(please|kindly|again|can you|could you|i want|i need|i would like|"
    r"show|display|list|give|get|tell|me|us|just|really|actually|now|"
    r"the|a|an|of|for)\b")
_PUNCTUATION = re.compile(r"[^\w\s]")
_SPACES = re.compile(r"\s+")


def normalise_question(text: str) -> str:
    """Reduce a question to its intent, so equivalent phrasings share a key."""
    lowered = _PUNCTUATION.sub(" ", (text or "").lower())
    lowered = _FILLER.sub(" ", lowered)
    return _SPACES.sub(" ", lowered).strip()


def _digest(*parts) -> str:
    joined = "".join(str(p) for p in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:32]


def answer_key(user_id, scope_signature: str, question: str, context: dict | None) -> str:
    """Identity of an answer: who, what they may see, what they asked, in what
    conversational context."""
    # Only the parts of the session that change the answer take part in the key.
    context_parts = json.dumps(
        {k: context.get(k) for k in ("date_from", "date_to", "club")} if context else {},
        sort_keys=True)
    return f"{_ANSWER_PREFIX}:{_digest(user_id, scope_signature, normalise_question(question), context_parts)}"


def get_answer(key: str) -> dict | None:
    return cache.get(key)


def set_answer(key: str, payload: dict) -> None:
    cache.set(key, payload, settings.AI_REPORT_CACHE_TTL_SECONDS)


def invalidate_answer(key: str) -> None:
    """Used by Refresh: the next ask goes to the data again."""
    cache.delete(key)


# --------------------------------------------------------------------------- #
# The dataset behind an answer                                                 #
# --------------------------------------------------------------------------- #
def store_report(user_id, scope_signature: str, payload: dict) -> str:
    """Keep a resolved report so Export can reuse it. Returns its id.

    The owner and scope are stored with it and checked on read: an id is not
    a capability, so guessing one gets you nothing.
    """
    report_id = uuid.uuid4().hex
    cache.set(
        f"{_REPORT_PREFIX}:{report_id}",
        {
            "user_id": user_id,
            "scope_signature": scope_signature,
            "stored_at": timezone.now().isoformat(),
            **payload,
        },
        settings.AI_REPORT_CACHE_TTL_SECONDS,
    )
    return report_id


def load_report(report_id: str, user_id, scope_signature: str) -> dict | None:
    """Read a stored report back, for this user and this scope only."""
    entry = cache.get(f"{_REPORT_PREFIX}:{report_id}")
    if not entry:
        return None
    # Re-checked rather than trusted: the user's permissions may have changed
    # since the report was generated.
    if entry.get("user_id") != user_id or entry.get("scope_signature") != scope_signature:
        return None
    return entry


# --------------------------------------------------------------------------- #
# Conversation state                                                           #
# --------------------------------------------------------------------------- #
def session_key(user_id, session_id: str) -> str:
    return f"{_SESSION_PREFIX}:{user_id}:{session_id}"


def get_session(user_id, session_id: str) -> dict:
    return cache.get(session_key(user_id, session_id)) or {"messages": [], "context": {}}


def save_session(user_id, session_id: str, session: dict) -> None:
    """Keep the conversation short on purpose.

    Only the last few turns are kept, and only the text: the figures live in
    the stored report, so a long conversation does not mean a large prompt or a
    growing pile of business data in the cache.
    """
    limit = settings.AI_CHAT_HISTORY_MAX_MESSAGES
    session = {**session, "messages": session.get("messages", [])[-limit:]}
    cache.set(session_key(user_id, session_id), session,
              settings.AI_CHAT_SESSION_TTL_SECONDS)


def clear_session(user_id, session_id: str) -> None:
    cache.delete(session_key(user_id, session_id))
