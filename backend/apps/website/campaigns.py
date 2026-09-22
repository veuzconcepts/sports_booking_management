"""Which campaigns a visitor may be shown, and nothing else.

The browser is never trusted to work this out. It asks what it may show and is
handed a list that has already been filtered by publication, enablement, the
configured window in the organization's own timezone, placement, scope and
audience. What the browser does decide is how OFTEN to show what it was given,
because that depends on what this particular person has already dismissed, which
the server neither knows nor needs to.

A campaign never changes what is bookable. It carries references to a promo code
or a special date so it can name them, and those systems stay authoritative for
discounts and opening hours respectively.
"""

from __future__ import annotations

from django.core.cache import cache
from django.utils import timezone

from .models import WebsiteCampaign

# Eligible campaigns change only when an admin edits one, so this is cached
# briefly to keep a busy homepage off the database. `invalidate()` is called on
# every write, so a disabled campaign disappears at once rather than lingering
# for the life of the cache entry.
CACHE_KEY = "website:campaigns:eligible"
CACHE_TTL_SECONDS = 120

PLACEMENT_ALL = WebsiteCampaign.Placement.ALL


def invalidate() -> None:
    """Drop the cached list. Called whenever a campaign is written."""
    cache.delete(CACHE_KEY)


def _candidates():
    """Every campaign that is switched on, regardless of the clock.

    Deliberately NOT filtered by time. Caching a time-filtered list meant the
    cached answer outlived the boundary it was computed at: a campaign due to
    start at 12:06 stayed invisible until the entry expired, and an explicit
    `now` was ignored entirely whenever the cache was warm. What rarely changes
    is which campaigns are switched on, so that is what gets cached; the window
    is then applied on every call, where it costs nothing.
    """
    return list(
        WebsiteCampaign.objects
        .filter(is_published=True, is_enabled=True, is_archived=False)
        .select_related("image", "mobile_image", "promo_code")
        .prefetch_related("clubs", "facilities")
        .order_by("-priority", "display_order", "-starts_at")
    )


def _matches_placement(campaign, placement: str) -> bool:
    if campaign.placement == PLACEMENT_ALL:
        return True
    return campaign.placement == placement


def _matches_audience(campaign, signed_in: bool) -> bool:
    if campaign.audience == WebsiteCampaign.Audience.EVERYONE:
        return True
    if campaign.audience == WebsiteCampaign.Audience.GUESTS:
        return not signed_in
    return signed_in


def _matches_scope(campaign, club_id) -> bool:
    """A campaign with no clubs selected is organization-wide.

    When it does name clubs, it shows only where one of them applies. A page
    that is not about a particular club (the homepage) therefore does not show
    a club-specific campaign, which is the honest reading of "this venue only".
    """
    club_ids = [club.id for club in campaign.clubs.all()]
    if not club_ids:
        return True
    return club_id is not None and int(club_id) in club_ids


def eligible(*, placement: str, club_id=None, signed_in: bool = False, now=None):
    """The campaigns this visitor may be shown, highest priority first.

    Only the highest-priority campaign should open immediately; the rest are
    returned so the site can queue them rather than stacking popups. That choice
    belongs to the page, which knows what else is on screen.
    """
    rows = cache.get(CACHE_KEY)
    if rows is None:
        rows = _candidates()
        cache.set(CACHE_KEY, rows, CACHE_TTL_SECONDS)

    # The window is applied here, never in the cached query, so a campaign
    # becomes visible the moment it starts rather than whenever the cache
    # happens to expire.
    moment = now or timezone.now()
    return [
        campaign for campaign in rows
        if campaign.starts_at <= moment <= campaign.ends_at
        and _matches_placement(campaign, placement)
        and _matches_audience(campaign, signed_in)
        and _matches_scope(campaign, club_id)
    ]


def record(campaign_id: int, event: str) -> bool:
    """Count an impression, a dismissal or a CTA click.

    A counter rather than a row per view: the question a campaign has to answer
    is whether it worked, and that needs no record of who saw it. The update is
    done in the database so two visitors at once cannot lose a count, and it
    deliberately touches nothing else on the row.
    """
    from django.db.models import F

    field = {
        "impression": "impressions",
        "dismiss": "dismissals",
        "click": "cta_clicks",
    }.get(event)
    if not field:
        return False
    updated = WebsiteCampaign.objects.filter(pk=campaign_id).update(**{field: F(field) + 1})
    return bool(updated)
