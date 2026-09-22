"""Image URLs in the public payload, as a visitor's browser receives them.

The customer site renders on the server. Astro calls Django over the internal
loopback address, so every URL built from that request came back as
`http://127.0.0.1:8000/media/...` and no visitor could load a single image.
The files were present, the site was up, and the pictures were broken.

Where this backend can be reached is a deployment fact, not a property of
whichever hop made the call. These pin that: with a public address configured
the payload uses it no matter how the request arrived, and without one the
behaviour is exactly what it always was.
"""

import base64
from decimal import Decimal

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.settings_app.media import public_file_url

pytestmark = pytest.mark.django_db

CATALOGUE = "/api/v1/website/public/catalogue/"
PUBLIC = "https://api.example.com"

# A real one-pixel PNG, so the field stores something a browser would accept.
PIXEL = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def a_picture(name="court.png"):
    return SimpleUploadedFile(name, PIXEL, content_type="image/png")


@pytest.fixture
def activity(db):
    from apps.facilities.models import FacilityType

    item = FacilityType.objects.create(
        name="Padel Court", price=Decimal("100.000"), duration_minutes=60,
        is_active=True, online_booking_enabled=True)
    item.image = a_picture()
    item.save()
    return item


# --------------------------------------------------------------------------- #
# The bug, end to end
# --------------------------------------------------------------------------- #
class TestTheServerRenderedSiteGetsUsableUrls:
    def test_a_loopback_request_still_yields_the_public_host(
            self, api, activity, settings):
        """Exactly the reported failure: the SSR call arrives on 127.0.0.1."""
        settings.PUBLIC_BACKEND_URL = PUBLIC
        response = api.get(CATALOGUE, SERVER_NAME="127.0.0.1")

        images = [f["image"] for f in response.data["facility_types"] if f.get("image")]
        assert images, response.data
        for url in images:
            assert url.startswith(PUBLIC), url
            assert "127.0.0.1" not in url

    def test_without_a_public_address_it_behaves_as_it_always_did(
            self, api, activity, settings):
        """A developer running everything on one machine must not have to
        configure anything."""
        settings.PUBLIC_BACKEND_URL = ""
        response = api.get(CATALOGUE, SERVER_NAME="localhost")

        images = [f["image"] for f in response.data["facility_types"] if f.get("image")]
        assert images
        assert all(u.startswith("http://localhost") for u in images), images

    def test_branding_images_are_fixed_too(self, api, settings):
        """The logo comes through the same machinery and was equally broken."""
        from apps.settings_app.models import Organization

        settings.PUBLIC_BACKEND_URL = PUBLIC
        org = Organization.get_solo()
        org.logo_light = a_picture("logo.png")
        org.save()

        body = api.get("/api/v1/website/public/branding/", SERVER_NAME="127.0.0.1").data
        logo = (body.get("branding") or body).get("logo_light")
        assert logo and logo.startswith(PUBLIC), logo


# --------------------------------------------------------------------------- #
# The helper itself
# --------------------------------------------------------------------------- #
class TestTheHelper:
    def test_no_file_means_no_url(self, settings):
        settings.PUBLIC_BACKEND_URL = PUBLIC
        assert public_file_url(None) is None
        assert public_file_url("") is None

    def test_a_trailing_slash_does_not_double_up(self, settings):
        settings.PUBLIC_BACKEND_URL = "https://api.example.com/"
        assert public_file_url("/media/a.png") == "https://api.example.com/media/a.png"

    def test_a_missing_leading_slash_is_added(self, settings):
        settings.PUBLIC_BACKEND_URL = PUBLIC
        assert public_file_url("media/a.png") == f"{PUBLIC}/media/a.png"

    def test_an_already_absolute_url_is_left_alone(self, settings):
        """A CDN or S3 backend has already said where the file is; putting a
        host in front of that would produce nonsense."""
        settings.PUBLIC_BACKEND_URL = PUBLIC
        for url in ("https://cdn.example.com/a.png",
                    "http://cdn.example.com/a.png",
                    "//cdn.example.com/a.png"):
            assert public_file_url(url) == url

    def test_with_no_setting_and_no_request_the_path_comes_back_unchanged(
            self, settings):
        settings.PUBLIC_BACKEND_URL = ""
        assert public_file_url("/media/a.png") == "/media/a.png"
