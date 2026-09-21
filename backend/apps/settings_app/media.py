"""Turning a stored file into a URL a browser can actually fetch.

`request.build_absolute_uri()` answers "where did THIS request arrive?", which
is the wrong question for a public payload. The customer website is rendered
on the server: Astro calls Django over the internal loopback address, so every
image URL built from that request came back as `http://127.0.0.1:8000/media/…`
and the visitor's browser could not load a single one. The images were there,
the site was up, and the pictures were broken.

The reachable address of this backend is a deployment fact, not a property of
whichever hop happened to make the call, so it is configured once and read
here. `PUBLIC_BACKEND_URL` empty keeps the old behaviour exactly, which is
what a developer running everything on localhost wants.
"""

from __future__ import annotations

from django.conf import settings

ABSOLUTE_SCHEMES = ("http://", "https://", "//")


def public_base() -> str:
    """The browser-reachable root of this backend, without a trailing slash."""
    return str(getattr(settings, "PUBLIC_BACKEND_URL", "") or "").rstrip("/")


def public_file_url(field, request=None) -> str | None:
    """An absolute URL for a stored file, or None when there is no file.

    Prefers the configured public address and falls back to the request, so a
    deployment that has not set one behaves exactly as it always did.

    A storage backend that already returns an absolute URL (S3, a CDN) is left
    alone: it has told us where the file is, and prefixing a host onto that
    would produce nonsense.
    """
    if not field:
        return None
    url = getattr(field, "url", None) or str(field)
    if url.startswith(ABSOLUTE_SCHEMES):
        return url

    base = public_base()
    if base:
        return f"{base}/{url.lstrip('/')}"
    if request is not None:
        return request.build_absolute_uri(url)
    return url
