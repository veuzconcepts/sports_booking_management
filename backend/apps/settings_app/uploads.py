"""Validation for the branding images.

Django's ImageField already proves a file decodes as an image, which rules out
a script renamed to .png. What it does not do is bound the size, restrict the
format, or stop an image so large it exhausts memory when Pillow opens it. A
logo is a small file by nature, so the limits here are tight on purpose.

SVG is deliberately not accepted: it is a document that can carry script and
external references, and nothing in this project sanitises it.
"""

from __future__ import annotations

from django.core.exceptions import ValidationError

# A logo or favicon that needs more than this is the wrong asset for the job.
MAX_BYTES = 2 * 1024 * 1024
# Pillow decodes to width * height * channels in memory, so the pixel count is
# the limit that actually protects the process.
MAX_PIXELS = 4000 * 4000

ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP", "ICO", "GIF"}
ALLOWED_CONTENT_TYPES = {
    "image/png", "image/jpeg", "image/jpg", "image/webp",
    "image/x-icon", "image/vnd.microsoft.icon", "image/gif",
}

FORMAT_LABEL = "PNG, JPG, WebP, GIF or ICO"


def validate_branding_image(file) -> None:
    """Raise ValidationError unless this is a small, ordinary raster image.

    Checked in this order on purpose: size first (cheapest, and the one that
    stops a denial of service), then the declared type, then what the bytes
    actually are. The last check is the one that counts, because a client
    controls both the filename and the content type it claims.
    """
    if file is None:
        return

    size = getattr(file, "size", None)
    if size is not None and size > MAX_BYTES:
        raise ValidationError(
            f"That image is {size // 1024} KB. Use one under "
            f"{MAX_BYTES // 1024} KB.")

    declared = (getattr(file, "content_type", "") or "").lower()
    if declared and declared not in ALLOWED_CONTENT_TYPES:
        raise ValidationError(f"Upload a {FORMAT_LABEL} image.")

    try:
        from PIL import Image
    except ImportError:                       # pragma: no cover - Pillow ships with Django images
        return

    position = file.tell() if hasattr(file, "tell") else None
    try:
        file.seek(0)
        with Image.open(file) as image:
            image_format = (image.format or "").upper()
            width, height = image.size
    except Exception as exc:                  # noqa: BLE001 - any decode failure is a rejection
        raise ValidationError("That file is not a readable image.") from exc
    finally:
        if position is not None:
            try:
                file.seek(position)
            except (OSError, ValueError):     # pragma: no cover - closed file
                pass

    # The real format, not the extension or the header the client sent.
    if image_format not in ALLOWED_FORMATS:
        raise ValidationError(f"Upload a {FORMAT_LABEL} image.")

    if width * height > MAX_PIXELS:
        raise ValidationError(
            f"That image is {width} by {height} pixels, which is larger than a "
            "logo needs to be. Resize it before uploading.")
