"""Branding image uploads: what must be refused.

These files are served to every visitor of the public site, so the interesting
cases are the ones that should not be stored: a script wearing an image
extension, a file that lies about its type, and an image large enough to
exhaust memory when it is decoded.
"""

import io

import pytest
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image
from rest_framework.test import APIClient

from apps.accounts.models import Role, User
from apps.settings_app.models import Organization
from apps.settings_app.uploads import MAX_BYTES, validate_branding_image

pytestmark = pytest.mark.django_db


def image_file(name="logo.png", fmt="PNG", size=(120, 40), content_type="image/png"):
    buffer = io.BytesIO()
    Image.new("RGB", size, (110, 74, 158)).save(buffer, format=fmt)
    return SimpleUploadedFile(name, buffer.getvalue(), content_type=content_type)


@pytest.fixture
def api():
    user = User.objects.create_user(
        email="branding-admin@example.com", password="Sup3r!Secret",
        role=Role.ADMIN, first_name="Branding", last_name="Admin",
    )
    client = APIClient()
    client.force_authenticate(user)
    return client


class TestValidator:
    def test_accepts_an_ordinary_logo(self):
        validate_branding_image(image_file())

    @pytest.mark.parametrize("fmt,content_type", [
        ("PNG", "image/png"), ("JPEG", "image/jpeg"),
        ("GIF", "image/gif"), ("WEBP", "image/webp"),
    ])
    def test_accepts_the_usual_raster_formats(self, fmt, content_type):
        validate_branding_image(image_file(fmt=fmt, content_type=content_type))

    def test_rejects_a_script_with_an_image_name(self):
        # The extension and the content type are both attacker-controlled; only
        # decoding the bytes settles it.
        payload = SimpleUploadedFile(
            "logo.png", b"<script>alert(1)</script>", content_type="image/png")
        with pytest.raises(ValidationError):
            validate_branding_image(payload)

    def test_rejects_svg_even_when_it_is_valid(self):
        # SVG can carry script and external references, and nothing here
        # sanitises it.
        payload = SimpleUploadedFile(
            "logo.svg",
            b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            content_type="image/svg+xml")
        with pytest.raises(ValidationError):
            validate_branding_image(payload)

    def test_rejects_a_file_over_the_size_limit(self):
        payload = SimpleUploadedFile(
            "logo.png", b"x" * (MAX_BYTES + 1), content_type="image/png")
        with pytest.raises(ValidationError) as exc:
            validate_branding_image(payload)
        assert "KB" in str(exc.value)

    def test_rejects_an_image_with_too_many_pixels(self):
        # A "decompression bomb": small on disk, enormous once decoded.
        buffer = io.BytesIO()
        Image.new("RGB", (5000, 5000), (0, 0, 0)).save(buffer, format="PNG")
        payload = SimpleUploadedFile("huge.png", buffer.getvalue(), content_type="image/png")
        with pytest.raises(ValidationError) as exc:
            validate_branding_image(payload)
        assert "pixels" in str(exc.value)

    def test_leaves_the_file_readable_afterwards(self):
        # The validator seeks through the file; the storage backend still has
        # to be able to save it.
        payload = image_file()
        validate_branding_image(payload)
        assert payload.read()

    def test_no_file_is_not_an_error(self):
        validate_branding_image(None)


class TestUploadEndpoint:
    def test_a_valid_logo_is_stored(self, api):
        res = api.patch("/api/v1/settings/organization/",
                        {"logo_light": image_file()}, format="multipart")
        assert res.status_code == 200
        assert Organization.get_solo().logo_light

    def test_a_disguised_script_is_refused(self, api):
        payload = SimpleUploadedFile(
            "logo.png", b"<script>alert(1)</script>", content_type="image/png")
        res = api.patch("/api/v1/settings/organization/",
                        {"logo_light": payload}, format="multipart")
        assert res.status_code == 400
        assert not Organization.get_solo().logo_light

    def test_an_oversized_file_is_refused(self, api):
        payload = SimpleUploadedFile(
            "logo.png", b"x" * (MAX_BYTES + 1), content_type="image/png")
        res = api.patch("/api/v1/settings/organization/",
                        {"logo_light": payload}, format="multipart")
        assert res.status_code == 400
        assert "logo_light" in res.json()
