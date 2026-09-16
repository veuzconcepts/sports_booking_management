"""Pluggable OTP delivery. Default = log only (stub).

No SMS/email provider is wired yet — the code is logged so the flow is testable
end-to-end. Point `settings.CUSTOMER_OTP_SENDER` at a dotted path
`module.func(channel, identifier, code)` to plug a real provider later.
"""

import logging

from django.conf import settings
from django.utils.module_loading import import_string

logger = logging.getLogger("customer_auth.otp")


def send_otp(channel: str, identifier: str, code: str) -> bool:
    path = getattr(settings, "CUSTOMER_OTP_SENDER", None)
    if path:
        return bool(import_string(path)(channel, identifier, code))
    logger.info("[OTP stub] %s -> %s : %s", channel, identifier, code)
    return True
