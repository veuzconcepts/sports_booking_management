"""TOTP-based multi-factor auth helpers (RFC 6238) built on pyotp + qrcode."""

import base64
from io import BytesIO

import pyotp
import qrcode

ISSUER = "Club Booking"


def new_secret() -> str:
    """Generate a fresh base32 TOTP secret."""
    return pyotp.random_base32()


def provisioning_uri(secret: str, account_label: str) -> str:
    """`otpauth://` URI an authenticator app scans to enrol."""
    return pyotp.TOTP(secret).provisioning_uri(name=account_label, issuer_name=ISSUER)


def verify(secret: str, code: str) -> bool:
    """Validate a 6-digit code, tolerating one 30s step of clock drift."""
    if not secret or not code:
        return False
    try:
        return pyotp.TOTP(secret).verify(str(code).strip(), valid_window=1)
    except Exception:  # pragma: no cover - malformed input
        return False


def qr_data_uri(uri: str) -> str:
    """Render the provisioning URI to a base64 PNG data URI for an <img> tag."""
    img = qrcode.make(uri)
    buf = BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"
