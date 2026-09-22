"""The backend's error pages.

One file does two jobs: Django renders it for a route that does not exist, and
nginx points `error_page 404` at the same file for a static or media path that
never reaches Django. That second case is the one people actually meet, since
a missing image is answered by nginx and Django never hears about it.

So the thing worth testing is that it stays a plain, self-contained document.
A page that says something is missing must not itself depend on anything that
could be missing.
"""

from pathlib import Path

import pytest
from django.conf import settings
from django.test import Client

pytestmark = pytest.mark.django_db

PAGE = Path(settings.BASE_DIR) / "templates" / "404.html"


class TestItIsServed:
    def test_an_unknown_route_renders_it(self, settings):
        """Django only uses a 404 template when DEBUG is off, which is how it
        runs everywhere that matters."""
        settings.DEBUG = False
        response = Client(raise_request_exception=False).get("/no-such-page-here/")
        assert response.status_code == 404
        assert b"404" in response.content
        assert b"We cannot find that page" in response.content

    def test_it_says_nothing_about_what_exists(self, settings):
        """An administration host should not confirm which paths are real."""
        settings.DEBUG = False
        body = Client(raise_request_exception=False).get("/admin-secret/").content
        assert b"admin-secret" not in body


class TestItStandsAlone:
    """nginx serves this as a static file, with no Django and no network."""

    def test_the_file_is_where_both_consumers_expect_it(self):
        assert PAGE.is_file(), PAGE

    def test_it_carries_no_template_tags(self):
        """nginx would serve them verbatim, and the visitor would read them."""
        source = PAGE.read_text(encoding="utf-8")
        assert "{%" not in source
        assert "{{" not in source

    def test_it_asks_the_network_for_nothing(self):
        source = PAGE.read_text(encoding="utf-8").lower()
        for pattern in ("<script", "<link", "http://", "https://", ".css", ".woff"):
            assert pattern not in source, pattern

    def test_the_only_image_is_drawn_inline(self):
        """An <img> on a 404 page can itself 404."""
        source = PAGE.read_text(encoding="utf-8").lower()
        assert "<img" not in source
        assert "<svg" in source

    def test_it_is_small_enough_to_arrive_before_anything_else_fails(self):
        assert PAGE.stat().st_size < 8192, PAGE.stat().st_size


class TestItReads:
    def test_it_works_in_both_colour_schemes(self):
        source = PAGE.read_text(encoding="utf-8")
        assert "prefers-color-scheme: dark" in source

    def test_it_offers_a_way_out(self):
        assert 'href="/"' in PAGE.read_text(encoding="utf-8")

    def test_search_engines_are_told_not_to_index_it(self):
        assert 'name="robots"' in PAGE.read_text(encoding="utf-8")
