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


def _live_queryset(now=None):
    """Published, enabled, not archived, and inside its window right now.

    The comparison is made against an aware `now`, so the window means what the
    organization meant by it rather than whatever the visitor's device says.
    """
    now = now or timezone.now()
    return (
        WebsiteCampaign.objects
        .filter(is_published=True, is_enabled=True, is_archived=False,
                starts_at__lte=now, ends_at__gte=now)
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
        rows = list(_live_queryset(now))
        cache.set(CACHE_KEY, rows, CACHE_TTL_SECONDS)

    # A cached row could have aged past its end between requests, so the window
    # is re-checked here rather than trusted from the cache alone.
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
