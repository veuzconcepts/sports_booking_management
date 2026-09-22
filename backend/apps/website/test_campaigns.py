"""Website campaigns: who sees one, when, and what never leaves the server.

The rules that matter here are all about restraint. A campaign is marketing, so
the risks are showing it when it should not be shown, leaking something private
with it, and letting it quietly become a second place that decides discounts or
opening hours. Each of those has a test.
"""

from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone

from apps.website import campaigns as rules
from apps.website.models import MediaAsset, WebsiteCampaign

PUBLIC = "/api/v1/website/public/campaigns/"
ADMIN = "/api/v1/website/campaigns/"


@pytest.fixture(autouse=True)
def clear_cache():
    cache.clear()
    yield
    cache.clear()


def make(**over):
    now = timezone.now()
    defaults = {
        "name": "Ramadan offer",
        "title": "Ramadan nights",
        "starts_at": now - timedelta(days=1),
        "ends_at": now + timedelta(days=1),
        "is_enabled": True,
        "is_published": True,
        "placement": WebsiteCampaign.Placement.HOME,
    }
    defaults.update(over)
    return WebsiteCampaign.objects.create(**defaults)


def names(response):
    return [c["title"] for c in response.json()["campaigns"]]


# --------------------------------------------------------------------------- #
# When a campaign shows
# --------------------------------------------------------------------------- #
def test_an_active_campaign_is_offered(api, db):
    make()
    assert names(api.get(PUBLIC)) == ["Ramadan nights"]


def test_a_future_campaign_does_not_show_early(api, db):
    now = timezone.now()
    make(starts_at=now + timedelta(days=7), ends_at=now + timedelta(days=14))
    assert names(api.get(PUBLIC)) == []


def test_an_expired_campaign_stops_showing(api, db):
    now = timezone.now()
    make(starts_at=now - timedelta(days=14), ends_at=now - timedelta(days=1))
    assert names(api.get(PUBLIC)) == []


def test_a_disabled_campaign_does_not_show(api, db):
    make(is_enabled=False)
    assert names(api.get(PUBLIC)) == []


def test_a_draft_campaign_does_not_show(api, db):
    make(is_published=False)
    assert names(api.get(PUBLIC)) == []


def test_an_archived_campaign_does_not_show(api, db):
    make(is_archived=True)
    assert names(api.get(PUBLIC)) == []


def test_the_window_is_read_in_the_organizations_time_not_the_browsers(api, db):
    """The dates are stored aware and compared against an aware now, so the
    answer cannot change with the visitor's device clock."""
    campaign = make()
    assert campaign.starts_at.tzinfo is not None
    assert campaign.status == WebsiteCampaign.STATUS_ACTIVE


# --------------------------------------------------------------------------- #
# Status is derived, never stored alongside dates that could disagree
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(("over", "expected"), [
    ({"is_published": False}, WebsiteCampaign.STATUS_DRAFT),
    ({"is_enabled": False}, WebsiteCampaign.STATUS_DISABLED),
    ({"starts_at": timezone.now() + timedelta(days=2),
      "ends_at": timezone.now() + timedelta(days=3)}, WebsiteCampaign.STATUS_SCHEDULED),
    ({"starts_at": timezone.now() - timedelta(days=3),
      "ends_at": timezone.now() - timedelta(days=2)}, WebsiteCampaign.STATUS_EXPIRED),
    ({}, WebsiteCampaign.STATUS_ACTIVE),
])
def test_status_follows_the_dates(db, over, expected):
    assert make(**over).status == expected


# --------------------------------------------------------------------------- #
# Targeting
# --------------------------------------------------------------------------- #
def test_a_homepage_campaign_stays_off_the_booking_pages(api, db):
    make(placement=WebsiteCampaign.Placement.HOME)
    assert names(api.get(f"{PUBLIC}?placement=booking")) == []


def test_an_all_pages_campaign_shows_everywhere(api, db):
    make(placement=WebsiteCampaign.Placement.ALL)
    assert names(api.get(f"{PUBLIC}?placement=booking")) == ["Ramadan nights"]
    assert names(api.get(f"{PUBLIC}?placement=home")) == ["Ramadan nights"]


def test_a_club_campaign_only_shows_for_that_club(api, db, club):
    from apps.clubs.models import Club

    other = Club.objects.create(code="north", name="Northside")
    campaign = make(placement=WebsiteCampaign.Placement.ALL)
    campaign.clubs.set([club])

    assert names(api.get(f"{PUBLIC}?placement=all&club={club.id}")) == ["Ramadan nights"]
    assert names(api.get(f"{PUBLIC}?placement=all&club={other.id}")) == []
    # A page that is not about one club does not show a club-only campaign.
    assert names(api.get(f"{PUBLIC}?placement=all")) == []


def test_a_campaign_with_no_clubs_is_organization_wide(api, db, club):
    make(placement=WebsiteCampaign.Placement.ALL)
    assert names(api.get(f"{PUBLIC}?placement=all&club={club.id}")) == ["Ramadan nights"]
    assert names(api.get(f"{PUBLIC}?placement=all")) == ["Ramadan nights"]


def test_a_guests_only_campaign_is_hidden_from_signed_in_customers(api, db):
    make(audience=WebsiteCampaign.Audience.GUESTS)
    assert names(api.get(PUBLIC)) == ["Ramadan nights"]
    assert names(api.get(f"{PUBLIC}?signed_in=true")) == []


# --------------------------------------------------------------------------- #
# Several at once
# --------------------------------------------------------------------------- #
def test_the_highest_priority_campaign_comes_first(api, db):
    make(title="Normal", priority=WebsiteCampaign.Priority.NORMAL)
    make(title="Urgent", name="Urgent", priority=WebsiteCampaign.Priority.HIGH)
    assert names(api.get(PUBLIC))[0] == "Urgent"


def test_every_eligible_campaign_is_returned_so_the_site_can_queue_them(api, db):
    make(title="One")
    make(title="Two", name="Two")
    assert len(names(api.get(PUBLIC))) == 2


# --------------------------------------------------------------------------- #
# What must never reach the public payload
# --------------------------------------------------------------------------- #
def test_internal_notes_never_leave_the_server(api, db):
    make(internal_notes="Negotiated with the sponsor, do not publish this")
    body = api.get(PUBLIC).json()
    assert "internal_notes" not in body["campaigns"][0]
    assert "sponsor" not in api.get(PUBLIC).content.decode()


def test_engagement_figures_and_scope_are_not_public(api, db, club):
    campaign = make(impressions=42)
    campaign.clubs.set([club])
    field_names = set(api.get(f"{PUBLIC}?club={club.id}").json()["campaigns"][0])
    assert not field_names & {"impressions", "dismissals", "cta_clicks", "clubs", "is_published"}


def test_a_linked_promo_is_named_but_its_rules_are_not_exposed(api, db):
    from apps.promotions.models import PromoCode

    promo = PromoCode.objects.create(code="RAMADAN20", discount_type="percent",
                                     discount_value=20)
    make(promo_code=promo)
    payload = api.get(PUBLIC).json()["campaigns"][0]
    assert payload["promo_code"] == "RAMADAN20"
    # The campaign advertises the code; the promo engine still owns the maths.
    assert "discount_value" not in payload
    assert "discount_type" not in payload


# --------------------------------------------------------------------------- #
# Artwork
# --------------------------------------------------------------------------- #
def test_the_desktop_artwork_is_used_when_there_is_no_mobile_version(api, db):
    asset = MediaAsset.objects.create(title="Wide", file="website/media/wide.png",
                                      alt_text="Ramadan lanterns")
    make(image=asset)
    payload = api.get(PUBLIC).json()["campaigns"][0]
    assert payload["image"]["alt"] == "Ramadan lanterns"
    assert payload["mobile_image"] is None


def test_mobile_artwork_is_offered_separately_when_supplied(api, db):
    wide = MediaAsset.objects.create(title="Wide", file="website/media/wide.png")
    tall = MediaAsset.objects.create(title="Tall", file="website/media/tall.png")
    make(image=wide, mobile_image=tall)
    payload = api.get(PUBLIC).json()["campaigns"][0]
    assert payload["image"]["id"] == wide.id
    assert payload["mobile_image"]["id"] == tall.id


# --------------------------------------------------------------------------- #
# Links
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("url", [
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox",
])
def test_an_executable_link_is_refused(auth_api, db, url):
    now = timezone.now()
    resp = auth_api.post(ADMIN, {
        "name": "Bad", "starts_at": now.isoformat(),
        "ends_at": (now + timedelta(days=1)).isoformat(),
        "cta_label": "Go", "cta_url": url,
    }, format="json")
    assert resp.status_code == 400
    assert "cta_url" in resp.json()


@pytest.mark.parametrize("url", ["/book", "https://example.com/offer", "mailto:a@b.com"])
def test_an_ordinary_link_is_accepted(auth_api, db, url):
    now = timezone.now()
    resp = auth_api.post(ADMIN, {
        "name": "Fine", "starts_at": now.isoformat(),
        "ends_at": (now + timedelta(days=1)).isoformat(),
        "cta_label": "Go", "cta_url": url,
    }, format="json")
    assert resp.status_code == 201


def test_a_button_without_a_label_is_refused(auth_api, db):
    now = timezone.now()
    resp = auth_api.post(ADMIN, {
        "name": "Unlabelled", "starts_at": now.isoformat(),
        "ends_at": (now + timedelta(days=1)).isoformat(), "cta_url": "/book",
    }, format="json")
    assert resp.status_code == 400
    assert "cta_label" in resp.json()


def test_an_end_before_the_start_is_refused(auth_api, db):
    now = timezone.now()
    resp = auth_api.post(ADMIN, {
        "name": "Backwards", "starts_at": now.isoformat(),
        "ends_at": (now - timedelta(days=1)).isoformat(),
    }, format="json")
    assert resp.status_code == 400


# --------------------------------------------------------------------------- #
# Permissions and caching
# --------------------------------------------------------------------------- #
def test_the_admin_list_requires_authentication(api, db):
    assert api.get(ADMIN).status_code == 401


def test_the_public_list_needs_no_account(api, db):
    make()
    assert api.get(PUBLIC).status_code == 200


def test_disabling_a_campaign_takes_it_down_at_once(auth_api, db):
    """A cached eligible list must not keep a withdrawn promotion alive."""
    campaign = make()
    assert names(auth_api.get(PUBLIC)) == ["Ramadan nights"]

    auth_api.patch(f"{ADMIN}{campaign.id}/", {"is_enabled": False}, format="json")
    assert names(auth_api.get(PUBLIC)) == []


def test_archived_campaigns_are_kept_out_of_the_admin_list_but_not_deleted(auth_api, db):
    campaign = make(is_archived=True)
    listed = [row["id"] for row in auth_api.get(ADMIN).json()["results"]]
    assert campaign.id not in listed
    assert WebsiteCampaign.objects.filter(pk=campaign.id).exists()


# --------------------------------------------------------------------------- #
# Engagement
# --------------------------------------------------------------------------- #
def test_an_impression_is_counted_without_recording_who_saw_it(api, db):
    campaign = make()
    resp = api.post("/api/v1/website/public/campaign-event/",
                    {"id": campaign.id, "event": "impression"}, format="json")
    campaign.refresh_from_db()
    assert resp.json()["ok"] is True
    assert campaign.impressions == 1


def test_dismissals_and_clicks_are_counted_separately(api, db):
    campaign = make()
    for event in ("dismiss", "click", "click"):
        api.post("/api/v1/website/public/campaign-event/",
                 {"id": campaign.id, "event": event}, format="json")
    campaign.refresh_from_db()
    assert (campaign.dismissals, campaign.cta_clicks) == (1, 2)


def test_an_unknown_event_changes_nothing(api, db):
    campaign = make()
    api.post("/api/v1/website/public/campaign-event/",
             {"id": campaign.id, "event": "hack"}, format="json")
    campaign.refresh_from_db()
    assert (campaign.impressions, campaign.dismissals, campaign.cta_clicks) == (0, 0, 0)


# --------------------------------------------------------------------------- #
# A campaign changes nothing about the business
# --------------------------------------------------------------------------- #
def test_linking_a_holiday_does_not_touch_the_schedule(db, club):
    """The campaign borrows the special date's name and period. The schedule
    engine is untouched: the closure still decides what is bookable."""
    from apps.settings_app.models import ScheduleException

    holiday = ScheduleException.objects.create(
        name="National Day", club=club, start_date=timezone.localdate(), closed=True)
    campaign = make(schedule_exception=holiday)

    holiday.refresh_from_db()
    assert holiday.closed is True
    assert holiday.club_id == club.id
    assert campaign.schedule_exception_id == holiday.id


def test_a_campaign_carries_no_pricing_or_discount_of_its_own(db):
    """Guards the boundary by construction: if someone adds a discount field to
    the campaign, this fails and the review conversation happens."""
    fields = {f.name for f in WebsiteCampaign._meta.get_fields()}
    forbidden = {"discount", "discount_type", "discount_value", "price", "amount",
                 "entitlement", "slot", "availability"}
    assert not fields & forbidden


# --------------------------------------------------------------------------- #
# The clock a campaign is set by
# --------------------------------------------------------------------------- #
def test_a_zone_less_time_is_read_as_the_organizations_own(db):
    """The admin form is a `datetime-local`, which carries no timezone.

    An operator in Riyadh typing 12:06 means 12:06 there. Read as UTC instead,
    the campaign goes live three hours late, which is exactly how a scheduled
    campaign appears not to work.
    """
    from datetime import timezone as dt_timezone

    from apps.settings_app.models import Organization
    from apps.website.serializers import WebsiteCampaignSerializer

    org = Organization.get_solo()
    org.timezone = "Asia/Riyadh"
    org.save(update_fields=["timezone"])

    serializer = WebsiteCampaignSerializer(data={
        "name": "Ramadan", "starts_at": "2027-03-01T12:06", "ends_at": "2027-03-30T23:59",
    })
    assert serializer.is_valid(), serializer.errors
    starts = serializer.validated_data["starts_at"]
    # 12:06 in Riyadh is 09:06 UTC, not 12:06 UTC.
    assert starts.astimezone(dt_timezone.utc).hour == 9
    assert starts.utcoffset().total_seconds() == 3 * 3600


def test_an_explicit_offset_is_respected(db):
    """A client that does send a zone is believed, not overridden."""
    from datetime import timezone as dt_timezone

    from apps.website.serializers import WebsiteCampaignSerializer

    serializer = WebsiteCampaignSerializer(data={
        "name": "Explicit", "starts_at": "2027-03-01T12:06:00Z",
        "ends_at": "2027-03-30T23:59:00Z",
    })
    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["starts_at"].astimezone(dt_timezone.utc).hour == 12


def test_saving_a_campaign_twice_does_not_move_it(auth_api, db):
    """The round trip must be stable: read a campaign, save it unchanged, and
    the window is where it was. A form that showed UTC while the operator read
    it as local time shifted the start by the offset on every save."""
    now = timezone.now()
    created = auth_api.post(ADMIN, {
        "name": "Stable", "starts_at": (now + timedelta(days=1)).isoformat(),
        "ends_at": (now + timedelta(days=2)).isoformat(),
    }, format="json").json()

    again = auth_api.patch(f"{ADMIN}{created['id']}/",
                           {"starts_at": created["starts_at"]}, format="json").json()
    assert again["starts_at"] == created["starts_at"]


def test_a_warm_cache_does_not_hide_a_campaign_that_has_just_started(db):
    """The cache must not outlive the boundary it was computed at.

    Caching the time-filtered list meant a campaign due to start at 12:06 stayed
    invisible until the entry expired, and an explicit `now` was ignored
    whenever the cache was warm. Both made a correctly scheduled campaign look
    broken.
    """
    now = timezone.now()
    campaign = make(starts_at=now + timedelta(hours=1), ends_at=now + timedelta(hours=2))

    # Warm the cache while nothing is live.
    assert rules.eligible(placement=WebsiteCampaign.Placement.HOME) == []

    # Without invalidating anything, ask again at a moment inside the window.
    inside = campaign.starts_at + timedelta(minutes=1)
    live = rules.eligible(placement=WebsiteCampaign.Placement.HOME, now=inside)
    assert [c.name for c in live] == [campaign.name]


def test_the_window_edges_are_exact(db):
    now = timezone.now()
    campaign = make(starts_at=now + timedelta(hours=1), ends_at=now + timedelta(hours=2))
    home = WebsiteCampaign.Placement.HOME

    just_before = rules.eligible(placement=home, now=campaign.starts_at - timedelta(seconds=1))
    at_start = rules.eligible(placement=home, now=campaign.starts_at)
    at_end = rules.eligible(placement=home, now=campaign.ends_at)
    just_after = rules.eligible(placement=home, now=campaign.ends_at + timedelta(seconds=1))

    assert just_before == []
    assert [c.name for c in at_start] == [campaign.name]
    assert [c.name for c in at_end] == [campaign.name]
    assert just_after == []
