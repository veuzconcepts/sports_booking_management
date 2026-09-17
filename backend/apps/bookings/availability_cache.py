"""Short-lived caching for calendar date-availability summaries.

A month of availability is expensive to compute and is asked for by every
customer who opens the booking calendar, so the answer is cached briefly. It
must also be correct: a slot booked ten seconds ago has to disappear.

Both are achieved with a VERSION counter rather than by tracking keys. The key
space is (club, facility type, facility, date range) and enumerating it to
delete would be guesswork; instead every cached entry carries the version it
was built under, and any write that could change availability bumps the
version, which orphans every entry at once. The orphans expire on their own.

Caching here is only ever a UX optimisation. Nothing is booked from a cached
summary: the slot list is recomputed when a date is chosen, and the booking is
revalidated in full when it is saved.
"""

from django.core.cache import cache

# Short enough that a stale entry surviving a missed invalidation is measured
# in seconds, long enough to absorb a customer paging through months.
TTL_SECONDS = 60

_VERSION_KEY = "bookings:availability:version"
_PREFIX = "bookings:availability:summary"


def version() -> int:
    """The current generation. Anything cached under an older one is ignored."""
    current = cache.get(_VERSION_KEY)
    if current is None:
        cache.set(_VERSION_KEY, 1, None)
        return 1
    return int(current)


def invalidate() -> None:
    """Retire every cached summary.

    Called whenever something that feeds availability is written: a booking,
    a maintenance block, a schedule, a special date, a facility or a booking
    policy. Cheap by design, so it can be wired to a signal without thought.
    """
    try:
        cache.incr(_VERSION_KEY)
    except ValueError:
        # No counter yet (or it expired). Starting a fresh one is equally
        # effective: nothing cached under the old generation can be read.
        cache.set(_VERSION_KEY, 1, None)


def _key(first, last, *, club, facility_type, facility) -> str:
    # Plain ids joined with dashes: a tuple's repr carries spaces and brackets,
    # which are not legal in a memcached key and would make this cache silently
    # unusable the day the backend changes from local memory.
    scope = "-".join(str(getattr(obj, "id", None) or 0)
                     for obj in (club, facility_type, facility))
    return f"{_PREFIX}:{version()}:{scope}:{first.isoformat()}:{last.isoformat()}"


def get(first, last, *, club=None, facility_type=None, facility=None):
    return cache.get(_key(first, last, club=club, facility_type=facility_type,
                          facility=facility))


def set(first, last, summary, *, club=None, facility_type=None, facility=None):
    cache.set(_key(first, last, club=club, facility_type=facility_type,
                   facility=facility), summary, TTL_SECONDS)
